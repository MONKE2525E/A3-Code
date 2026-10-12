import type { PullRequestActivity, PullRequestDetail } from "@t3tools/contracts";
import { pullRequestReviewerEntries } from "@t3tools/shared/pullRequestHandoff";
import type { ReactNode } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  useColorScheme,
  View,
  type NativeScrollEvent,
} from "react-native";
import Animated, { FadeOut, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";
import {
  sortPullRequestChecks,
  summarizePullRequestChecks,
  type PullRequestChecksTone,
} from "./pull-request-model";
import { PR_EASE, PR_FADE_IN, PrAvatar, PrCard, PrChevron, tint } from "./pull-request-components";

const LAYOUT = LinearTransition.duration(200).easing(PR_EASE).reduceMotion(ReduceMotion.System);
const FADE_OUT = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

const CHECK_ICON: Record<PullRequestDetail["checks"][number]["status"], AppSymbolName> = {
  "action-required": "exclamationmark.triangle",
  success: "checkmark.circle",
  failure: "xmark.circle",
  cancelled: "xmark.circle",
  pending: "clock",
  skipped: "circle.dashed",
  neutral: "circle.dashed",
};

const CHECK_STATUS_LABEL: Record<PullRequestDetail["checks"][number]["status"], string> = {
  "action-required": "Action required",
  success: "Passed",
  failure: "Failed",
  cancelled: "Cancelled",
  pending: "Running",
  skipped: "Skipped",
  neutral: "Neutral",
};

/** Which Summary sections are open. Owned by the pane so a tab switch or a fold keeps them. */
export interface PullRequestSummarySections {
  readonly description: boolean;
  readonly checks: boolean;
}

/** The desktop's defaults: the description open, the checks folded behind their summary. */
export const DEFAULT_PULL_REQUEST_SUMMARY_SECTIONS: PullRequestSummarySections = {
  description: true,
  checks: false,
};

/** One ink per outcome, readable on both themes and shared with the header summary. */
export function useChecksToneColor() {
  const dark = useColorScheme() === "dark";
  return (tone: PullRequestChecksTone | PullRequestDetail["checks"][number]["status"]) => {
    switch (tone) {
      case "success":
        return dark ? "#6ee7b7" : "#059669";
      case "failure":
      case "cancelled":
        return dark ? "#fca5a5" : "#dc2626";
      case "pending":
        return dark ? "#fcd34d" : "#b45309";
      default:
        return dark ? "#a1a1aa" : "#71717a";
    }
  };
}

/** A card whose heading folds it, the whole heading one touch target as the desktop's is. */
function Section(props: {
  title: string;
  detail?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Animated.View layout={LAYOUT}>
      <PrCard>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.title}
          accessibilityState={{ expanded: props.open }}
          onPress={props.onToggle}
          className="min-h-12 flex-row items-center gap-2 px-4 active:bg-subtle"
        >
          <Text className="text-[14px] font-t3-bold text-foreground">{props.title}</Text>
          <PrChevron open={props.open} />
          <View className="min-w-0 flex-1 flex-row justify-end">{props.detail}</View>
        </Pressable>
        {props.open ? (
          <Animated.View
            entering={PR_FADE_IN}
            exiting={FADE_OUT}
            className="border-t border-border pb-2"
          >
            {props.children}
          </Animated.View>
        ) : null}
      </PrCard>
    </Animated.View>
  );
}

function ChecksSummary(props: { checks: PullRequestDetail["checks"] }) {
  const colorFor = useChecksToneColor();
  const summary = summarizePullRequestChecks(props.checks);
  if (summary.tone === "none") {
    return <Text className="text-xs text-foreground-tertiary">{summary.label}</Text>;
  }
  const color = colorFor(summary.tone);
  return (
    <View
      className="flex-row items-center gap-1 rounded-full px-2 py-0.5"
      style={{ backgroundColor: tint(color, 0.12) }}
    >
      <SymbolView
        name={
          summary.tone === "success"
            ? "checkmark.circle"
            : summary.tone === "failure"
              ? "xmark.circle"
              : "clock"
        }
        size={12}
        tintColor={color}
        type="monochrome"
      />
      <Text numberOfLines={1} className="text-xs font-t3-medium" style={{ color }}>
        {summary.label}
      </Text>
    </View>
  );
}

/** A bar of the checks by outcome, so a long list reads at a glance before it is opened. */
function ChecksBar(props: { checks: PullRequestDetail["checks"] }) {
  const colorFor = useChecksToneColor();
  if (props.checks.length === 0) return null;
  const groups = (["success", "pending", "failure"] as const)
    .map((tone) => ({
      tone,
      count: props.checks.filter((check) =>
        tone === "failure"
          ? check.status === "failure" ||
            check.status === "cancelled" ||
            check.status === "action-required"
          : check.status === tone,
      ).length,
    }))
    .filter((group) => group.count > 0);
  return (
    <View className="mx-4 mb-1 mt-3 h-1.5 flex-row gap-0.5 overflow-hidden rounded-full">
      {groups.map((group) => (
        <View
          key={group.tone}
          style={{ flex: group.count, backgroundColor: colorFor(group.tone) }}
        />
      ))}
    </View>
  );
}

function Checks(props: { checks: PullRequestDetail["checks"] }) {
  const colorFor = useChecksToneColor();
  const linkColor = String(useUniwindTheme()["--color-icon-subtle"]);
  if (props.checks.length === 0) {
    return <Text className="px-4 pt-3 text-sm text-foreground-muted">No checks reported.</Text>;
  }
  return (
    <View>
      <ChecksBar checks={props.checks} />
      {sortPullRequestChecks(props.checks).map((check) => (
        <Pressable
          key={`${check.name}:${check.url ?? ""}`}
          accessibilityRole={check.url ? "link" : "text"}
          accessibilityLabel={`${check.name}, ${CHECK_STATUS_LABEL[check.status]}`}
          disabled={!check.url}
          onPress={() => check.url && void tryOpenExternalUrl(check.url, "pull-request")}
          className="min-h-11 flex-row items-center gap-3 px-4 py-2 active:bg-subtle"
        >
          <SymbolView
            name={CHECK_ICON[check.status]}
            size={16}
            tintColor={colorFor(check.status)}
            type="monochrome"
          />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={2} className="text-sm text-foreground">
              {check.name}
            </Text>
            {check.description ? (
              <Text numberOfLines={1} className="text-xs text-foreground-muted">
                {check.description}
              </Text>
            ) : null}
          </View>
          <Text className="text-xs text-foreground-tertiary">
            {CHECK_STATUS_LABEL[check.status]}
          </Text>
          {check.url ? (
            <SymbolView name="arrow.up.right" size={12} tintColor={linkColor} type="monochrome" />
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

function labelColor(color: string | null) {
  return color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : null;
}

function MetaRow(props: { icon: AppSymbolName; title: string; children: ReactNode }) {
  const iconColor = String(useUniwindTheme()["--color-icon-muted"]);
  return (
    <View className="min-h-11 flex-row items-start gap-2 px-4 py-2">
      <View className="w-24 flex-row items-center gap-1.5 pt-1">
        <SymbolView name={props.icon} size={14} tintColor={iconColor} type="monochrome" />
        <Text className="text-[13px] text-foreground-muted">{props.title}</Text>
      </View>
      <View className="min-w-0 flex-1">{props.children}</View>
    </View>
  );
}

const VERDICT_LABEL = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  dismissed: "Dismissed",
} as const;

/** A reviewer's face and name, with their verdict on the chip the way desktop rings the avatar. */
function ReviewerChip(props: {
  actor: Parameters<typeof PrAvatar>[0]["actor"];
  outcome: keyof typeof VERDICT_LABEL | null;
  stale: boolean;
}) {
  const colorFor = useChecksToneColor();
  const login = props.actor?.login ?? "ghost";
  const verdictColor =
    props.outcome === "approved"
      ? colorFor("success")
      : props.outcome === "changes-requested"
        ? colorFor("failure")
        : null;
  const verdict = props.outcome
    ? `${VERDICT_LABEL[props.outcome]}${props.stale ? " before the latest commits" : ""}`
    : "Review requested";
  return (
    <View
      accessible
      accessibilityLabel={`${login}, ${verdict}`}
      className={cn(
        "max-w-full flex-row items-center gap-1.5 rounded-full border border-border py-0.5 pl-0.5 pr-2.5",
        props.stale && "opacity-60",
      )}
      style={
        verdictColor
          ? { borderColor: verdictColor, backgroundColor: tint(verdictColor, 0.08) }
          : undefined
      }
    >
      <PrAvatar actor={props.actor} size={20} />
      <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground">
        {login}
      </Text>
      {verdictColor ? (
        <SymbolView
          name={props.outcome === "approved" ? "checkmark.circle" : "xmark.circle"}
          size={13}
          tintColor={verdictColor}
          type="monochrome"
        />
      ) : (
        <SymbolView name="clock" size={12} tintColor={colorFor("pending")} type="monochrome" />
      )}
    </View>
  );
}

/** Reviewers, labels and where the change lives: the desktop's meta rows, in one card. */
function AboutCard(props: { pr: PullRequestDetail; activity: PullRequestActivity | null }) {
  const { pr } = props;
  const reviewers = pullRequestReviewerEntries(
    props.activity?.reviewers ?? pr.reviewers,
    props.activity?.comments ?? [],
    props.activity?.commits ?? [],
  );
  return (
    <PrCard className="py-1">
      <MetaRow icon="person.2" title="Reviewers">
        {reviewers.length > 0 ? (
          <View className="flex-row flex-wrap gap-1.5">
            {reviewers.map((entry) => (
              <ReviewerChip
                key={entry.key}
                actor={entry.actor}
                outcome={entry.outcome}
                stale={entry.stale}
              />
            ))}
          </View>
        ) : (
          <Text className="pt-1 text-[13px] text-foreground-muted">None</Text>
        )}
      </MetaRow>
      {pr.labels.length > 0 ? (
        <MetaRow icon="ticket" title="Labels">
          <View className="flex-row flex-wrap gap-1.5">
            {pr.labels.map((label) => {
              const color = labelColor(label.color);
              return (
                <View
                  key={label.name}
                  className="flex-row items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5"
                  style={
                    color
                      ? { borderColor: tint(color, 0.5), backgroundColor: tint(color, 0.14) }
                      : undefined
                  }
                >
                  {color ? (
                    <View className="size-2 rounded-full" style={{ backgroundColor: color }} />
                  ) : null}
                  <Text className="text-xs text-foreground-secondary">{label.name}</Text>
                </View>
              );
            })}
          </View>
        </MetaRow>
      ) : null}
      <MetaRow icon="folder" title="Project">
        <Text numberOfLines={1} className="pt-1 text-[13px] text-foreground">
          {pr.projectTitle}
        </Text>
      </MetaRow>
      <MetaRow icon="clock" title="Opened">
        <Text className="pt-1 text-[13px] text-foreground">{relativeTime(pr.createdAt)}</Text>
      </MetaRow>
    </PrCard>
  );
}

/**
 * The desktop Summary: who reviews it and how it is labelled, the description open and the
 * checks folded behind their one-line summary. The conversation is the Timeline tab. On a wide
 * pane the description takes the main column and the facts ride a rail beside it, as a desktop
 * page lays them out.
 */
export function PullRequestSummaryTab(props: {
  pr: PullRequestDetail;
  activity: PullRequestActivity | null;
  sections: PullRequestSummarySections;
  onSectionsChange: (next: PullRequestSummarySections) => void;
  refreshing: boolean;
  onRefresh: () => void;
  /** Opens a link in the description, natively when it names a pull request. */
  onLinkPress: (href: string) => void;
  onScroll?: (event: NativeScrollEvent) => void;
  wide?: boolean;
}) {
  const { pr, sections } = props;
  const insets = useSafeAreaInsets();
  const refreshColor = String(useUniwindTheme()["--color-icon"]);
  const description = (
    <Section
      title="Description"
      open={sections.description}
      onToggle={() => props.onSectionsChange({ ...sections, description: !sections.description })}
    >
      {pr.body.trim() ? (
        <FileMarkdownPreview embedded markdown={pr.body} onLinkPress={props.onLinkPress} />
      ) : (
        <Text className="px-4 pt-3 text-sm italic text-foreground-muted">
          No description provided.
        </Text>
      )}
    </Section>
  );
  const checks = (
    <Section
      title="Checks"
      detail={<ChecksSummary checks={pr.checks} />}
      open={sections.checks}
      onToggle={() => props.onSectionsChange({ ...sections, checks: !sections.checks })}
    >
      <Checks checks={pr.checks} />
    </Section>
  );
  const about = <AboutCard pr={pr} activity={props.activity} />;
  return (
    <ScrollView
      className="flex-1"
      scrollEventThrottle={32}
      onScroll={props.onScroll ? (event) => props.onScroll?.(event.nativeEvent) : undefined}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}
      refreshControl={
        <RefreshControl
          refreshing={props.refreshing}
          onRefresh={props.onRefresh}
          tintColor={refreshColor}
        />
      }
    >
      <Animated.View entering={PR_FADE_IN}>
        {props.wide ? (
          <View className="flex-row items-start gap-4">
            <View className="min-w-0 flex-1 gap-3">{description}</View>
            <View className="w-80 gap-3">
              {about}
              {checks}
            </View>
          </View>
        ) : (
          <View className="gap-3">
            {about}
            {description}
            {checks}
          </View>
        )}
      </Animated.View>
    </ScrollView>
  );
}
