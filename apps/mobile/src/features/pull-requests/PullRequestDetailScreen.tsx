import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestMergeMethod,
  type PullRequestRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  gitHubPullRequestBrowserUrl,
  parseChangeRequestUrl,
} from "@t3tools/shared/changeRequestUrl";
import {
  allowsSinglePullRequestMerge,
  resolvePullRequestMergeMethod,
} from "@t3tools/shared/pullRequestHandoff";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import { type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  useColorScheme,
  View,
  type NativeScrollEvent,
} from "react-native";
import Animated, { LinearTransition, ReduceMotion } from "react-native-reanimated";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestEnvironment, pullRequestStack } from "../../state/pull-requests";
import { serverEnvironment } from "../../state/server";
import {
  allowedMergeMethods,
  pullRequestMenuGroups,
  pullRequestMergeBox,
  type PullRequestMenuCommand,
  type PullRequestMenuItem,
} from "./pull-request-actions";
import {
  describePullRequestFailure,
  pullRequestFailureMessage,
  resolvePullRequestPresentation,
  summarizePullRequestChecks,
} from "./pull-request-model";
import {
  PR_EASE,
  PR_FADE_IN,
  PrAvatar,
  PrButton,
  PrNotice,
  PrPill,
  PrSkeletonLine,
  PrSlowLoadHint,
  PrStateMessage,
  PrTabs,
} from "./pull-request-components";
import { PullRequestCode } from "./PullRequestCode";
import { PullRequestMergeBar, toMenuAction } from "./PullRequestMergeBar";
import {
  DEFAULT_PULL_REQUEST_SUMMARY_SECTIONS,
  PullRequestSummaryTab,
  useChecksToneColor,
  type PullRequestSummarySections,
} from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import { useOpenPullRequest } from "./useOpenPullRequest";
import { usePullRequestComposer } from "./usePullRequestComposer";
import {
  type PullRequestActionStatus,
  usePullRequestDetailActions,
} from "./usePullRequestDetailActions";

type DetailTab = "summary" | "timeline" | "code";

/** A pane at least this wide puts the merge box beside the header and the summary in columns. */
const WIDE_PANE = 640;

const LAYOUT = LinearTransition.duration(200).easing(PR_EASE).reduceMotion(ReduceMotion.System);

/**
 * What the list already knows about a pull request, drawn in the header while the detail is
 * still on its way so the screen never opens empty.
 */
export type PullRequestPreview = Pick<
  PullRequestListEntry,
  | "title"
  | "state"
  | "isDraft"
  | "mergeability"
  | "author"
  | "headBranch"
  | "baseBranch"
  | "additions"
  | "deletions"
  | "updatedAt"
>;

/** The strategy picked last, kept for the session so the next pull request starts with it. */
let lastSelectedMergeMethod: PullRequestMergeMethod = "squash";

/**
 * The route a pull request link opens: that pull request alone, at every width, with Back
 * returning to wherever the link was. `threadId` names the thread it was opened from, which is
 * where hand-offs land and what Unlink acts on. The list of pull requests is its own screen.
 */
export function PullRequestDetailScreen(
  props: StaticScreenProps<{
    environmentId: string;
    projectId: string;
    repository: string;
    number: number;
    host?: string;
    threadId?: string;
  }>,
) {
  const navigation = useNavigation();
  const params = props.route.params;
  const reference = useMemo<PullRequestRef>(
    () => ({
      projectId: ProjectId.make(params.projectId),
      repository: params.repository,
      number: Number(params.number),
      ...(params.host ? { host: params.host } : {}),
    }),
    [params.host, params.number, params.projectId, params.repository],
  );
  return (
    <View className="flex-1 bg-header">
      <PullRequestDetailPane
        environmentId={EnvironmentId.make(params.environmentId)}
        reference={reference}
        originThreadId={params.threadId ? ThreadId.make(params.threadId) : null}
        onBack={() => navigation.goBack()}
      />
    </View>
  );
}

/**
 * One pull request, laid out like the desktop panel: a header with the state, title, author,
 * branches and size; the merge box with its split button; tabs; and the rest of the screen for
 * content. The header folds to one line once the content is scrolled, as the desktop's does. On a
 * wide pane (an unfolded Fold, a tablet) the merge box sits beside the header and the Summary
 * splits into columns.
 */
export function PullRequestDetailPane(props: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  originThreadId?: ThreadId | null;
  /** Drawn until the detail arrives; the list passes the row that was tapped. */
  preview?: PullRequestPreview | null;
  onBack?: (() => void) | undefined;
}) {
  const registry = useContext(RegistryContext);
  const [tab, setTab] = useState<DetailTab>("summary");
  const [sections, setSections] = useState<PullRequestSummarySections>(
    DEFAULT_PULL_REQUEST_SUMMARY_SECTIONS,
  );
  const [titleExpanded, setTitleExpanded] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [paneWidth, setPaneWidth] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [diffVersion, setDiffVersion] = useState(0);
  const [mergeMethodChoice, setMergeMethodChoice] = useState<PullRequestMergeMethod | null>(null);
  const target = { environmentId: props.environmentId, input: props.reference };
  const detail = useEnvironmentQuery(pullRequestEnvironment.detail(target));
  // Read with the detail, as the desktop does: the reviewers' verdicts and the findings a
  // hand-off carries come from here, not only the Timeline tab.
  const activity = useEnvironmentQuery(pullRequestEnvironment.activity(target));
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const { refresh: refreshDetail } = detail;
  const { refresh: refreshActivity } = activity;
  const openLink = useOpenPullRequest();
  const originThreadId = props.originThreadId ?? null;
  const wide = paneWidth >= WIDE_PANE;
  // A link in a description or comment opens in the viewer when it names a pull request this
  // environment can read, so following one never drops the reader into the GitHub app. The
  // originating thread travels with it, so a nested pull request can still hand off there.
  const onLinkPress = useCallback(
    (href: string) =>
      void openLink(
        href,
        String(props.environmentId),
        "markdown-link",
        originThreadId === null ? undefined : String(originThreadId),
      ),
    [openLink, props.environmentId, originThreadId],
  );
  const project = useProject(scopeProjectRef(props.environmentId, props.reference.projectId));
  // Offered where the host's own page may still load when this one cannot.
  const hostUrl = gitHubPullRequestBrowserUrl(
    project?.repositoryIdentity,
    props.reference.repository,
    props.reference.number,
  );

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const result = await invalidate({
        environmentId: props.environmentId,
        input: { reference: props.reference },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setRefreshError(
          pullRequestFailureMessage(
            failure instanceof Error ? failure.message : "Could not refresh the pull request.",
          ),
        );
      }
      // The reads run either way: at worst they answer from the server's cache.
      refreshDetail();
      refreshActivity();
      registry.refresh(
        pullRequestEnvironment.diff({ environmentId: props.environmentId, input: props.reference }),
      );
      setDiffVersion((value) => value + 1);
    } finally {
      setRefreshing(false);
    }
  };

  const onPosted = useCallback(() => {
    refreshDetail();
    refreshActivity();
  }, [refreshActivity, refreshDetail]);
  const composer = usePullRequestComposer({
    environmentId: props.environmentId,
    reference: props.reference,
    onPosted,
  });

  const pr = detail.data;
  const actions = usePullRequestDetailActions({
    environmentId: props.environmentId,
    reference: props.reference,
    detail: pr,
    activity: activity.data,
    originThreadId,
    refreshFromHost: refresh,
    onSelectMergeMethod: (method) => {
      lastSelectedMergeMethod = method;
      setMergeMethodChoice(method);
    },
  });
  const canMergeSingle = useCanMergeSinglePullRequest(props.environmentId, props.reference, pr);
  // Folds the header once the content has room to scroll under it, and unfolds at the top. The
  // room check keeps a short page from folding, growing past the fold point and unfolding again.
  const onContentScroll = useCallback((event: NativeScrollEvent) => {
    const room = event.contentSize.height - event.layoutMeasurement.height;
    const y = event.contentOffset.y;
    setScrolled((current) => (current ? y > 4 : y > 48 && room > 260));
  }, []);
  const selectTab = (next: DetailTab) => {
    setScrolled(false);
    setTab(next);
  };

  if (!pr) {
    return (
      <PaneBar
        onBack={props.onBack}
        repository={props.reference.repository}
        number={props.reference.number}
        onLayoutWidth={setPaneWidth}
      >
        {detail.error ? (
          <PrStateMessage
            icon="arrow.triangle.pull"
            {...describePullRequestFailure({
              failure: detail.failure,
              message: detail.error,
              number: props.reference.number,
            })}
          >
            <PrButton
              label="Retry"
              icon="arrow.clockwise"
              busy={detail.isPending}
              onPress={detail.refresh}
            />
            {hostUrl ? (
              <PrButton
                label="Open on GitHub"
                icon="safari"
                onPress={() => void tryOpenExternalUrl(hostUrl, "pull-request")}
              />
            ) : null}
          </PrStateMessage>
        ) : (
          <DetailSkeleton preview={props.preview ?? null} wide={wide}>
            <PrSlowLoadHint>
              <PrButton label="Retry" icon="arrow.clockwise" onPress={detail.refresh} />
              {hostUrl ? (
                <PrButton
                  label="Open on GitHub"
                  icon="safari"
                  onPress={() => void tryOpenExternalUrl(hostUrl, "pull-request")}
                />
              ) : null}
            </PrSlowLoadHint>
          </DetailSkeleton>
        )}
      </PaneBar>
    );
  }

  const verdicts = pr.capabilities.review.verdicts.filter((verdict) =>
    pr.viewerPermissions.verdicts.includes(verdict),
  );
  const canComment = pr.capabilities.comment && pr.viewerPermissions.comment;
  const condensed = tab === "code" || (scrolled && !titleExpanded);
  const failureLine =
    refreshError ?? (detail.error ? pullRequestFailureMessage(detail.error) : null);
  const notices = failureLine === null ? [] : [`${failureLine} Showing the last loaded details.`];
  const methods = allowedMergeMethods(pr);
  const mergeMethod = resolvePullRequestMergeMethod(
    methods,
    mergeMethodChoice ?? pr.autoMergeMethod ?? null,
    undefined,
    lastSelectedMergeMethod,
  );
  const busy =
    refreshing || actions.pendingAction !== null || actions.linkPending || actions.handoffPending;
  const menuInput = {
    detail: pr,
    thread: actions.thread,
    canMergeSingle,
    mergeMethod,
    canAdminMerge: actions.canAdminMerge,
    refreshing,
    actionPending: actions.pendingAction !== null || actions.linkPending,
    handoffPending: actions.handoffPending || activity.isPending,
  };
  const menu = pullRequestMenuGroups(menuInput);
  const mergeBox = pullRequestMergeBox(menuInput);
  const mergeBar = (
    <PullRequestMergeBar
      box={mergeBox}
      pr={pr}
      busy={actions.pendingAction === "merge" || actions.pendingAction === "enable-auto-merge"}
      onCommand={actions.run}
      className={wide ? "w-80" : "mx-4"}
    />
  );
  return (
    <PaneBar
      onBack={props.onBack}
      repository={pr.repository}
      number={pr.number}
      onLayoutWidth={setPaneWidth}
      menu={<PullRequestMenu groups={menu} busy={busy} onCommand={actions.run} />}
    >
      <Animated.View layout={LAYOUT} className={cn("px-4", wide && "flex-row items-start gap-4")}>
        <View className={cn("min-w-0 gap-2 pb-3", wide && "flex-1")}>
          <View className="flex-row flex-wrap items-center gap-1.5">
            <StatePill pr={pr} />
            <ChecksPill checks={pr.checks} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pr.title}
            accessibilityHint={titleExpanded ? "Collapse the title" : "Show the full title"}
            onPress={() => setTitleExpanded((value) => !value)}
          >
            <Text
              numberOfLines={titleExpanded ? undefined : condensed ? 1 : 3}
              className={cn(
                "font-t3-bold text-foreground",
                condensed ? "text-[16px] leading-[22px]" : "text-[20px] leading-[26px]",
              )}
            >
              {pr.title}
            </Text>
          </Pressable>
          {condensed ? null : (
            <Animated.View entering={PR_FADE_IN}>
              <HeaderFacts pr={pr} author={activity.data?.author ?? pr.author} />
            </Animated.View>
          )}
        </View>
        {wide && !condensed ? <View className="pb-3">{mergeBar}</View> : null}
      </Animated.View>
      {!wide && !condensed ? (
        <Animated.View entering={PR_FADE_IN} className="pb-3">
          {mergeBar}
        </Animated.View>
      ) : null}
      <ActionStatus status={actions.status} onDismiss={actions.dismissStatus} />
      <PrTabs
        tabs={[
          { key: "summary", label: "Summary" },
          { key: "timeline", label: "Timeline", badge: activity.data?.commentCount },
          ...(pr.capabilities.diff
            ? [{ key: "code" as const, label: "Code", badge: pr.changedFiles }]
            : []),
        ]}
        selected={tab}
        onSelect={selectTab}
      />
      {notices.length > 0 ? (
        <PrNotice
          lines={notices}
          actionLabel="Retry"
          onAction={() => (refreshError ? void refresh() : detail.refresh())}
        />
      ) : null}
      <View className="min-h-0 flex-1 border-t border-border">
        {tab === "summary" ? (
          <PullRequestSummaryTab
            pr={pr}
            activity={activity.data}
            sections={sections}
            onSectionsChange={setSections}
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            onLinkPress={onLinkPress}
            onScroll={onContentScroll}
            wide={wide}
          />
        ) : tab === "code" ? (
          <PullRequestCode
            key={diffVersion}
            environmentId={props.environmentId}
            reference={props.reference}
          />
        ) : (
          <PullRequestTimelineTab
            activity={activity}
            composer={composer}
            canComment={canComment}
            verdicts={verdicts}
            target={`${pr.repository}#${pr.number}`}
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            onLinkPress={onLinkPress}
            onScroll={onContentScroll}
          />
        )}
      </View>
    </PaneBar>
  );
}

/**
 * The desktop's single-merge guard. A host that keeps stacks merges a stacked pull request from
 * its stack, so a single merge is offered only once the host has said this one is not in one.
 */
function useCanMergeSinglePullRequest(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  pr: PullRequestDetail | null,
) {
  const capabilities = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities,
  );
  const supportsStackActions =
    capabilities?.threadPullRequests === true &&
    capabilities.pullRequestStackActions === true &&
    pr?.capabilities.stacks === true &&
    pr.capabilities.stackActions === true;
  const stack = useEnvironmentQuery(
    pr && supportsStackActions
      ? pullRequestStack({
          environmentId,
          input: { ...reference, host: reference.host ?? parseChangeRequestUrl(pr.url)?.host },
        })
      : null,
  );
  return allowsSinglePullRequestMerge({
    supportsStackActions,
    hasStack: stack.data !== null,
    stackPending: stack.isPending,
    stackError: stack.error,
  });
}

/** The three-dot menu: grouped natively on iOS, a flat Material list on Android. */
function PullRequestMenu(props: {
  groups: PullRequestMenuItem[][];
  busy: boolean;
  onCommand: (command: PullRequestMenuCommand) => void;
}) {
  const iconColor = String(useUniwindTheme()["--color-header-foreground"]);
  const actions =
    Platform.OS === "ios"
      ? props.groups.map((group, index): MenuAction => ({
          id: `group:${index}`,
          title: "",
          displayInline: true,
          subactions: group.map(toMenuAction),
        }))
      : props.groups.flat().map(toMenuAction);
  return (
    <ControlPillMenu
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const item = props.groups.flat().find((entry) => entry.id === nativeEvent.event);
        if (item && !item.disabled) props.onCommand(item.command);
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel="More pull request actions"
        accessibilityState={{ busy: props.busy }}
        className="size-11 items-center justify-center rounded-full"
      >
        {props.busy ? (
          <ActivityIndicator size="small" color={iconColor} />
        ) : (
          <SymbolView name="ellipsis" size={20} tintColor={iconColor} type="monochrome" />
        )}
      </View>
    </ControlPillMenu>
  );
}

/** How the last menu action went, in place of a toast: a failure stays until dismissed. */
function ActionStatus(props: { status: PullRequestActionStatus | null; onDismiss: () => void }) {
  const iconColor = String(useUniwindTheme()["--color-icon-muted"]);
  const { status } = props;
  if (status === null) return null;
  if (status.tone === "failure") {
    return (
      <PrNotice
        lines={status.detail ? [status.title, status.detail] : [status.title]}
        actionLabel="Dismiss"
        onAction={props.onDismiss}
      />
    );
  }
  return (
    <Animated.View
      entering={PR_FADE_IN}
      layout={LAYOUT}
      accessibilityLiveRegion="polite"
      className="mx-4 mb-2 flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2"
    >
      {status.tone === "progress" ? (
        <ActivityIndicator size="small" color={iconColor} />
      ) : (
        <SymbolView name="checkmark.circle" size={15} tintColor={iconColor} type="monochrome" />
      )}
      <Text className="min-w-0 flex-1 text-[13px] text-foreground-secondary">{status.title}</Text>
      {status.tone === "success" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={12}
          onPress={props.onDismiss}
        >
          <SymbolView name="xmark" size={14} tintColor={iconColor} type="monochrome" />
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

function StatePill(props: { pr: Pick<PullRequestDetail, "state" | "isDraft" | "mergeability"> }) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const presentation = resolvePullRequestPresentation(props.pr, scheme);
  return (
    <PrPill
      icon={presentation.icon}
      label={presentation.label}
      color={presentation.color}
      accessibilityLabel={`Status: ${presentation.label}`}
    />
  );
}

/** The checks rollup beside the state, as the desktop header shows it next to the title. */
function ChecksPill(props: { checks: PullRequestDetail["checks"] }) {
  const colorFor = useChecksToneColor();
  const summary = summarizePullRequestChecks(props.checks);
  if (summary.tone === "none") return null;
  return (
    <PrPill
      icon={
        summary.tone === "success"
          ? "checkmark.circle"
          : summary.tone === "failure"
            ? "xmark.circle"
            : "clock"
      }
      label={summary.label}
      color={colorFor(summary.tone)}
      accessibilityLabel={`Checks: ${summary.label}`}
    />
  );
}

/**
 * The pane's frame. On a phone it is the app's own top bar (back, `#number` over the repository,
 * the action menu) above the rounded content surface every screen uses; beside the list it is a
 * slim bar inside the list's surface with the menu rightmost.
 */
function PaneBar(props: {
  onBack?: (() => void) | undefined;
  repository: string;
  number: number;
  menu?: ReactNode;
  onLayoutWidth: (width: number) => void;
  children: ReactNode;
}) {
  if (props.onBack) {
    return (
      <View className="flex-1 bg-header">
        <AndroidScreenHeader
          title={`#${props.number}`}
          subtitle={props.repository}
          onBack={props.onBack}
          hideBottomBorder
          trailing={props.menu}
        />
        <View
          onLayout={(event) => props.onLayoutWidth(event.nativeEvent.layout.width)}
          className="flex-1 overflow-hidden rounded-t-[28px] bg-screen pt-4"
        >
          {props.children}
        </View>
      </View>
    );
  }

  return (
    <View
      onLayout={(event) => props.onLayoutWidth(event.nativeEvent.layout.width)}
      className="flex-1 bg-screen"
    >
      <View className="min-h-12 flex-row items-center gap-1 pl-4 pr-1 pt-1">
        <Text
          numberOfLines={1}
          ellipsizeMode="middle"
          className="min-w-0 flex-1 text-[13px] text-foreground-muted"
        >
          {props.repository} #{props.number}
        </Text>
        {props.menu}
      </View>
      {props.children}
    </View>
  );
}

/** A proportion of additions to deletions in five blocks, as the host's own diffstat draws it. */
function DiffBlocks(props: {
  additions: number;
  deletions: number;
  addColor: string;
  deleteColor: string;
}) {
  const total = props.additions + props.deletions;
  if (total === 0) return null;
  const green = Math.round((props.additions / total) * 5);
  return (
    <View className="flex-row gap-0.5" accessibilityElementsHidden importantForAccessibility="no">
      {[0, 1, 2, 3, 4].map((index) => (
        <View
          key={index}
          className="size-2 rounded-[2px]"
          style={{ backgroundColor: index < green ? props.addColor : props.deleteColor }}
        />
      ))}
    </View>
  );
}

/**
 * Who and when, which branches, and how big: the desktop header's line, with the base first and
 * the head it receives changes from after it. Split in two so neither wraps on a phone.
 */
function HeaderFacts(props: {
  pr: Pick<
    PullRequestPreview,
    "headBranch" | "baseBranch" | "updatedAt" | "additions" | "deletions"
  > & { changedFiles?: number };
  author: PullRequestDetail["author"];
}) {
  const { pr } = props;
  const iconColor = String(useUniwindTheme()["--color-icon-muted"]);
  const toneColor = useChecksToneColor();
  // The host's diffstat inks, rather than the theme's accent, so additions always read green.
  const addColor = toneColor("success");
  const deleteColor = toneColor("failure");
  const login = props.author?.login ?? "ghost";
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <PrAvatar actor={props.author} size={20} />
        <Text numberOfLines={1} className="min-w-0 shrink text-[13px] text-foreground-muted">
          <Text className="text-[13px] font-t3-medium text-foreground-secondary">{login}</Text>
          {` · updated ${relativeTime(pr.updatedAt)}`}
        </Text>
      </View>
      <View className="flex-row items-center gap-3">
        <View
          accessible
          accessibilityLabel={`${pr.baseBranch} receives changes from ${pr.headBranch}`}
          className="min-w-0 flex-1 flex-row items-center gap-1"
        >
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            className="max-w-[45%] shrink-0 rounded-md bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-foreground-secondary"
          >
            {pr.baseBranch}
          </Text>
          <SymbolView name="arrow.left" size={12} tintColor={iconColor} type="monochrome" />
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            className="min-w-0 shrink rounded-md bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-foreground-secondary"
          >
            {pr.headBranch}
          </Text>
        </View>
        <View
          accessible
          accessibilityLabel={`${pr.changedFiles === undefined ? "" : `${pr.changedFiles} changed ${pr.changedFiles === 1 ? "file" : "files"}, `}${pr.additions} additions, ${pr.deletions} deletions`}
          className="flex-row items-center gap-1.5"
        >
          {pr.changedFiles === undefined ? null : (
            <>
              <SymbolView name="doc.text" size={12} tintColor={iconColor} type="monochrome" />
              <Text className="font-mono text-[11px] text-foreground-muted">{pr.changedFiles}</Text>
            </>
          )}
          <Text className="font-mono text-[11px]" style={{ color: addColor }}>
            +{pr.additions}
          </Text>
          <Text className="font-mono text-[11px]" style={{ color: deleteColor }}>
            -{pr.deletions}
          </Text>
          <DiffBlocks
            additions={pr.additions}
            deletions={pr.deletions}
            addColor={addColor}
            deleteColor={deleteColor}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * The detail's shape before it arrives: the tapped row's own facts where the list passed them,
 * then quiet placeholders where the merge box, tabs and description will be.
 */
function DetailSkeleton(props: {
  preview: PullRequestPreview | null;
  wide: boolean;
  children?: ReactNode;
}) {
  const { preview } = props;
  return (
    <View accessibilityLabel="Loading pull request" className="flex-1">
      <View className={cn("px-4", props.wide && "flex-row items-start gap-4")}>
        <View className={cn("min-w-0 gap-2 pb-3", props.wide && "flex-1")}>
          {preview ? (
            <>
              <View className="flex-row">
                <StatePill pr={preview} />
              </View>
              <Text
                numberOfLines={3}
                className="text-[20px] font-t3-bold leading-[26px] text-foreground"
              >
                {preview.title}
              </Text>
              <HeaderFacts pr={preview} author={preview.author} />
            </>
          ) : (
            <>
              <PrSkeletonLine width={72} height={22} strong />
              <PrSkeletonLine width="88%" height={20} strong />
              <PrSkeletonLine width="56%" height={20} strong />
              <PrSkeletonLine width="44%" />
            </>
          )}
        </View>
        <View
          className={cn(
            "h-28 rounded-2xl border border-border bg-card",
            props.wide ? "w-80" : "mb-3",
          )}
        />
      </View>
      <View className="px-4 pb-3">
        <View className="h-11 rounded-full bg-subtle" />
      </View>
      <View className="gap-2.5 border-t border-border px-4 pt-4">
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" />
          <Text className="text-[13px] text-foreground-muted">Loading pull request...</Text>
        </View>
        <PrSkeletonLine width="94%" />
        <PrSkeletonLine width="82%" />
        <PrSkeletonLine width="88%" />
        <PrSkeletonLine width="40%" />
      </View>
      {props.children}
    </View>
  );
}
