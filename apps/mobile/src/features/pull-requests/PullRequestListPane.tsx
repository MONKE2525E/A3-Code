import {
  type EnvironmentId,
  ProjectId,
  type PullRequestListCursors,
  type PullRequestListEntry,
  type PullRequestRef,
} from "@t3tools/contracts";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestEnvironment } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  countActivePullRequestFilters,
  DEFAULT_PULL_REQUEST_FILTERS,
  matchesPullRequestQuery,
  mergePullRequestPages,
  type PullRequestFilters,
  pullRequestFailureMessage,
  pullRequestRowKey,
  resolvePullRequestListStatus,
  resolvePullRequestNotices,
  resolvePullRequestPresentation,
  sortPullRequests,
} from "./pull-request-model";
import {
  PrAvatar,
  PrButton,
  PrNotice,
  PrSkeletonLine,
  PrSlowLoadHint,
  PrStateMessage,
  tint,
} from "./pull-request-components";
import { PullRequestFiltersSheet } from "./PullRequestFiltersSheet";
import { PullRequestListToolbar } from "./PullRequestListToolbar";
import { useChecksToneColor } from "./PullRequestSummaryTab";

const PAGE_SIZE = 50;
const MAX_LIMIT = 500;
const SEARCH_DEBOUNCE_MS = 300;

interface Paging {
  /** The scope this paging belongs to; paging from another scope is ignored, not carried over. */
  readonly scope: string;
  readonly cursors: PullRequestListCursors | undefined;
  readonly previousPages: ReadonlyArray<ReadonlyArray<PullRequestListEntry>>;
  readonly limit: number;
}

function initialPaging(scope: string): Paging {
  return { scope, cursors: undefined, previousPages: [], limit: PAGE_SIZE };
}

/**
 * The top bar (search, filters, refresh) and the list itself. Paging is tagged with the
 * scope it was read for, so a changed filter starts from the first page while the search field
 * and its focus stay where they are.
 */
export function PullRequestListPane(props: {
  environmentId: EnvironmentId;
  environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly environmentLabel: string;
  }>;
  onEnvironmentChange: (environmentId: string) => void;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** Undefined until the environment has reported its capabilities. */
  pullRequestsSupported: boolean | undefined;
  filters: PullRequestFilters;
  onFiltersChange: (patch: Partial<PullRequestFilters>) => void;
  selected: PullRequestRef | null;
  onSelect: (entry: PullRequestListEntry) => void;
  /** Kept by the screen so it survives switching environments. */
  search: string;
  onSearchChange: (search: string) => void;
  onBack: () => void;
  layout: { split: boolean; showDetailOnly: boolean; listWidth: number };
  /** The selected pull request, or the wide layout's placeholder for one. */
  detail: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { filters } = props;
  const { search, onSearchChange: setSearch } = props;
  const [query, setQuery] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const scope = JSON.stringify([
    props.environmentId,
    filters.projectId,
    filters.state,
    filters.involvement,
    query,
  ]);
  const [storedPaging, setPaging] = useState<Paging>(() => initialPaging(scope));
  const paging = storedPaging.scope === scope ? storedPaging : initialPaging(scope);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate);
  // An environment that cannot list pull requests is not asked to; the body says so instead.
  const listing = useEnvironmentQuery(
    props.pullRequestsSupported === false
      ? null
      : pullRequestEnvironment.list({
          environmentId: props.environmentId,
          input: {
            state: filters.state,
            involvement: filters.involvement,
            limit: paging.limit,
            ...(filters.projectId ? { projectId: ProjectId.make(filters.projectId) } : {}),
            ...(query ? { query } : {}),
            ...(paging.cursors ? { cursors: paging.cursors } : {}),
          },
        }),
  );
  const data = listing.data;
  const entries = useMemo(
    () =>
      sortPullRequests(
        mergePullRequestPages([...paging.previousPages, data?.entries ?? []]).filter((entry) => {
          const provider = data?.providers.find((item) => item.host === entry.host);
          return provider?.searchesOnHost !== false || matchesPullRequestQuery(entry, query);
        }),
        filters.sort,
      ),
    [paging.previousPages, data, query, filters.sort],
  );
  const unavailable = useMemo(
    () => new Map((data?.errors ?? []).map((error) => [error.projectId as string, error.message])),
    [data],
  );
  const health = useMemo(
    () => ({
      error: listing.error ? pullRequestFailureMessage(listing.error) : null,
      projectErrors: (data?.errors ?? []).map((error) => ({
        projectTitle: error.projectTitle,
        message: pullRequestFailureMessage(error.message),
      })),
      unconfigured: (data?.providers ?? []).filter((provider) => !provider.configured),
    }),
    [listing.error, data],
  );
  const filterCount = countActivePullRequestFilters(filters);
  const status = resolvePullRequestListStatus({
    rowCount: entries.length,
    hasData: data !== null && data !== undefined,
    pending: listing.isPending,
    query,
    searching: search.trim() !== query || listing.isPending,
    filterCount,
    projectCount: props.projects.length,
    pullRequestsSupported: props.pullRequestsSupported,
    health,
  });

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      // The server keeps its own answer for a while; ask it to forget before reading again, and
      // read again even if that fails so Retry never looks dead.
      await invalidate({ environmentId: props.environmentId, input: {} });
      setPaging(initialPaging(scope));
      listing.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const loadMore = useCallback(() => {
    if (!data?.truncated || listing.isPending) return;
    if (Object.keys(data.nextCursors).length > 0) {
      setPaging({
        ...paging,
        previousPages: [...paging.previousPages, data.entries],
        cursors: data.nextCursors,
      });
    } else if (paging.limit < MAX_LIMIT) {
      setPaging({ ...paging, limit: Math.min(paging.limit + PAGE_SIZE, MAX_LIMIT) });
    }
  }, [data, listing.isPending, paging]);
  const canLoadMore =
    data?.truncated === true &&
    (Object.keys(data.nextCursors).length > 0 || paging.limit < MAX_LIMIT);

  // A further page is on its way: the rows already read stay up and the footer says so.
  const loadingMore = listing.isPending && entries.length > 0;

  const clearSearch = () => {
    setSearch("");
    setQuery("");
  };
  const resetFilters = () =>
    props.onFiltersChange({
      state: DEFAULT_PULL_REQUEST_FILTERS.state,
      involvement: DEFAULT_PULL_REQUEST_FILTERS.involvement,
      projectId: undefined,
    });

  const notices = status.kind === "rows" ? resolvePullRequestNotices(health) : [];
  const body =
    status.kind === "rows" ? null : status.kind === "loading" ? (
      <ListSkeleton caption={status.caption} />
    ) : status.kind === "unsupported" ? (
      <PrStateMessage icon="arrow.triangle.pull" title={status.title} message={status.message} />
    ) : status.kind === "no-projects" ? (
      <PrStateMessage
        icon="folder"
        title="No projects in this environment"
        message="Add a project, and the pull requests from its repository appear here."
      />
    ) : status.kind === "error" || status.kind === "setup" ? (
      <PrStateMessage icon="arrow.triangle.pull" title={status.title} message={status.message}>
        <PrButton
          label="Retry"
          icon="arrow.clockwise"
          busy={refreshing}
          onPress={() => void refresh()}
        />
      </PrStateMessage>
    ) : status.kind === "empty-search" ? (
      <PrStateMessage
        icon="magnifyingglass"
        title={`Nothing matches "${query.length > 40 ? `${query.slice(0, 40)}...` : query}"`}
        message="Try fewer words, or search by number, author or branch."
      >
        <PrButton label="Clear search" onPress={clearSearch} />
        <PrButton
          label="Check again"
          icon="arrow.clockwise"
          busy={refreshing}
          onPress={() => void refresh()}
        />
      </PrStateMessage>
    ) : (
      <PrStateMessage
        icon="arrow.triangle.pull"
        title={
          status.kind === "empty-filtered" ? "Nothing under these filters" : "No pull requests"
        }
        message={
          status.kind === "empty-filtered"
            ? "Widen the state, involvement or project to see more."
            : "Pull requests from this environment's projects appear here."
        }
      >
        {status.kind === "empty-filtered" ? (
          <PrButton label="Reset filters" onPress={resetFilters} />
        ) : null}
        <PrButton
          label="Check again"
          icon="arrow.clockwise"
          busy={refreshing}
          onPress={() => void refresh()}
        />
      </PrStateMessage>
    );

  const toolbar = (
    <PullRequestListToolbar
      onBack={props.onBack}
      searchQuery={search}
      onSearchQueryChange={setSearch}
      filterCount={filterCount}
      filterCustomized={filterCount > 0 || filters.sort !== DEFAULT_PULL_REQUEST_FILTERS.sort}
      onOpenFilters={() => setSheetOpen(true)}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
    />
  );

  const { split, showDetailOnly, listWidth } = props.layout;
  const list = (
    <View className="flex-1">
      <View className="flex-1">
        {body ?? (
          <FlatList
            data={entries}
            keyExtractor={pullRequestRowKey}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            onEndReached={canLoadMore ? loadMore : undefined}
            onEndReachedThreshold={0.6}
            initialNumToRender={12}
            contentContainerStyle={{ paddingBottom: insets.bottom + 8 }}
            ListHeaderComponent={
              notices.length > 0 ? (
                <View className="pt-2">
                  <PrNotice
                    lines={notices}
                    actionLabel={listing.error ? "Retry" : undefined}
                    onAction={() => void refresh()}
                  />
                </View>
              ) : undefined
            }
            ListFooterComponent={
              canLoadMore || loadingMore ? (
                <View className="items-center py-3">
                  {loadingMore ? (
                    <ActivityIndicator />
                  ) : (
                    <PrButton label="Load more" onPress={loadMore} />
                  )}
                </View>
              ) : undefined
            }
            renderItem={({ item }) => (
              <PullRequestRow
                entry={item}
                selected={
                  props.selected !== null &&
                  props.selected.projectId === item.projectId &&
                  props.selected.repository === item.repository &&
                  props.selected.number === item.number &&
                  (props.selected.host === undefined ||
                    props.selected.host.toLowerCase() === item.host.toLowerCase())
                }
                onSelect={props.onSelect}
              />
            )}
          />
        )}
      </View>
      <PullRequestFiltersSheet
        visible={sheetOpen}
        filters={filters}
        projects={props.projects}
        unavailable={unavailable}
        onChange={props.onFiltersChange}
        environments={props.environments}
        environmentId={props.environmentId}
        onEnvironmentChange={props.onEnvironmentChange}
        onClose={() => setSheetOpen(false)}
      />
    </View>
  );

  return (
    <>
      {showDetailOnly ? null : toolbar}
      {/* The rounded surface under the top bar, as on Home and in a thread. A phone's detail
          draws its own bar and surface, so this one steps aside rather than nesting. */}
      <View
        className={
          showDetailOnly
            ? "flex-1 flex-row bg-header"
            : "flex-1 flex-row overflow-hidden rounded-t-[28px] bg-screen"
        }
      >
        <View
          className={split ? "border-r border-border" : "flex-1"}
          style={[
            split ? { width: listWidth } : null,
            { display: showDetailOnly ? "none" : "flex" },
          ]}
        >
          {list}
        </View>
        <View
          className="min-w-0 flex-1"
          style={{ display: split || props.selected ? "flex" : "none" }}
        >
          {props.detail}
        </View>
      </View>
    </>
  );
}

/** Static placeholders in the row's own rhythm; nothing animates while the first page loads. */
function ListSkeleton(props: { caption?: string | undefined }) {
  return (
    <View accessibilityLabel={props.caption ?? "Loading pull requests"} className="pt-1">
      {props.caption ? (
        <Text numberOfLines={1} className="px-4 pb-1 pt-2 text-xs text-foreground-tertiary">
          {props.caption}
        </Text>
      ) : null}
      <PrSlowLoadHint afterMs={8_000} />
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <View key={index} className="flex-row gap-3 px-4 py-3.5">
          <View className="size-8 rounded-full bg-subtle-strong" />
          <View className="flex-1 gap-2">
            <PrSkeletonLine width="82%" height={14} strong />
            <PrSkeletonLine width="48%" />
            <View className="flex-row gap-1.5">
              <PrSkeletonLine width={56} height={16} />
              <PrSkeletonLine width={72} height={16} />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

function labelColor(color: string | null) {
  return color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : null;
}

/**
 * The desktop row on a phone: the state in a tinted badge, `#number` before the title, then the
 * author's face, the repository and the age, and a line of chips for checks, a requested review,
 * the outcome and the first labels. The change size sits on the right.
 */
const PullRequestRow = memo(function PullRequestRow(props: {
  entry: PullRequestListEntry;
  selected: boolean;
  onSelect: (entry: PullRequestListEntry) => void;
}) {
  const { entry } = props;
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const presentation = resolvePullRequestPresentation(entry, scheme);
  const checksColor = useChecksToneColor();
  const hasStats = entry.additions > 0 || entry.deletions > 0;
  const checks =
    entry.checksState === "passing"
      ? { icon: "checkmark.circle" as const, tone: "success" as const, label: "Passing" }
      : entry.checksState === "failing"
        ? { icon: "xmark.circle" as const, tone: "failure" as const, label: "Failing" }
        : entry.checksState === "pending"
          ? { icon: "clock" as const, tone: "pending" as const, label: "Running" }
          : null;
  const reviewRequested = entry.viewerReviewRequested && entry.state === "open";
  const outcome =
    presentation.label !== "Open" && presentation.label !== "Draft" ? presentation : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${presentation.label} pull request ${entry.number}: ${entry.title}, ${entry.repository}${entry.checksState ? `, checks ${entry.checksState}` : ""}${reviewRequested ? ", review requested" : ""}`}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onSelect(entry)}
      className={cn(
        "mx-2 min-h-16 flex-row gap-3 rounded-2xl px-3 py-3",
        props.selected ? "bg-subtle-strong" : "active:bg-subtle",
      )}
    >
      <View
        className="size-8 items-center justify-center rounded-full"
        style={{ backgroundColor: tint(presentation.color, 0.14) }}
      >
        <SymbolView
          name={presentation.icon}
          size={16}
          tintColor={presentation.color}
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1 gap-1.5">
        <Text
          numberOfLines={2}
          className="text-[15px] font-t3-medium leading-[20px] text-foreground"
        >
          <Text className="text-[13px] text-foreground-tertiary">#{entry.number} </Text>
          {entry.title}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <PrAvatar actor={entry.author} size={16} />
          <Text numberOfLines={1} className="min-w-0 shrink text-[13px] text-foreground-muted">
            {entry.author?.login ?? "ghost"}
            <Text className="text-[13px] text-foreground-tertiary">
              {`  ${entry.repository} · ${relativeTime(entry.updatedAt)}`}
            </Text>
          </Text>
        </View>
        {checks || reviewRequested || outcome || entry.labels.length > 0 ? (
          <View className="flex-row flex-wrap items-center gap-1.5">
            {outcome ? <RowChip label={outcome.label} color={outcome.color} /> : null}
            {checks ? (
              <RowChip icon={checks.icon} label={checks.label} color={checksColor(checks.tone)} />
            ) : null}
            {reviewRequested ? (
              <RowChip icon="eye" label="Review requested" color={checksColor("pending")} />
            ) : null}
            {entry.labels.slice(0, 2).map((label) => {
              const color = labelColor(label.color);
              // Host label colours are often pale, so the colour rides a dot and the name keeps
              // the theme's own ink rather than becoming unreadable on a light background.
              return (
                <View
                  key={label.name}
                  className="max-w-40 flex-row items-center gap-1 rounded-full bg-subtle px-2 py-0.5"
                >
                  {color ? (
                    <View className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
                  ) : null}
                  <Text
                    numberOfLines={1}
                    className="shrink text-[11px] font-t3-medium text-foreground-secondary"
                  >
                    {label.name}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}
      </View>
      {hasStats ? (
        <View className="items-end pt-0.5">
          <Text className="font-mono text-xs" style={{ color: checksColor("success") }}>
            +{entry.additions}
          </Text>
          <Text className="font-mono text-xs" style={{ color: checksColor("failure") }}>
            -{entry.deletions}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
});

function RowChip(props: { icon?: AppSymbolName; label: string; color: string }) {
  return (
    <View
      className="max-w-40 flex-row items-center gap-1 rounded-full px-2 py-0.5"
      style={{ backgroundColor: tint(props.color, 0.13) }}
    >
      {props.icon ? (
        <SymbolView name={props.icon} size={11} tintColor={props.color} type="monochrome" />
      ) : null}
      <Text
        numberOfLines={1}
        className="shrink text-[11px] font-t3-medium"
        style={{ color: props.color }}
      >
        {props.label}
      </Text>
    </View>
  );
}
