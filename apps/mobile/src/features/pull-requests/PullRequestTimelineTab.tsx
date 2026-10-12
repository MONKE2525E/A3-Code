import type {
  PullRequestActivity,
  PullRequestComment,
  PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  TextInput,
  useColorScheme,
  View,
  type NativeScrollEvent,
} from "react-native";
import Animated, { FadeOut, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { EnvironmentQueryView } from "../../state/query";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";
import { pullRequestFailureMessage } from "./pull-request-model";
import {
  PR_EASE,
  PR_FADE_IN,
  PrAvatar,
  PrButton,
  PrChevron,
  PrChoice,
  PrNotice,
  PrSkeletonLine,
  PrStateMessage,
  tint,
} from "./pull-request-components";
import type { PullRequestComposerState } from "./usePullRequestComposer";

const LAYOUT = LinearTransition.duration(200).easing(PR_EASE).reduceMotion(ReduceMotion.System);
const FADE_OUT = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

const VERDICT_LABEL: Record<PullRequestReviewVerdict, string> = {
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes",
};

type ReviewTone = "success" | "failure" | "neutral";

const REVIEW_STATE: Record<string, { label: string; tone: ReviewTone }> = {
  APPROVED: { label: "Approved", tone: "success" },
  CHANGES_REQUESTED: { label: "Requested changes", tone: "failure" },
  COMMENTED: { label: "Reviewed", tone: "neutral" },
  DISMISSED: { label: "Dismissed", tone: "neutral" },
};

function reviewState(state: string | null) {
  if (!state) return null;
  return (
    REVIEW_STATE[state.toUpperCase()] ?? { label: state.toLowerCase(), tone: "neutral" as const }
  );
}

function useReviewToneColor() {
  const dark = useColorScheme() === "dark";
  const muted = String(useUniwindTheme()["--color-foreground-secondary"]);
  return (tone: ReviewTone) =>
    tone === "success"
      ? dark
        ? "#6ee7b7"
        : "#059669"
      : tone === "failure"
        ? dark
          ? "#fca5a5"
          : "#dc2626"
        : muted;
}

function Commits(props: { commits: PullRequestActivity["commits"] }) {
  const [open, setOpen] = useState(false);
  const iconColor = String(useUniwindTheme()["--color-icon-muted"]);
  if (props.commits.length === 0) return null;
  return (
    <Animated.View
      layout={LAYOUT}
      className="mx-4 mt-4 overflow-hidden rounded-2xl border border-border bg-card"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="min-h-12 flex-row items-center gap-2.5 px-4 active:bg-subtle"
      >
        <SymbolView
          name="smallcircle.filled.circle"
          size={15}
          tintColor={iconColor}
          type="monochrome"
        />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground">
          {props.commits.length} {props.commits.length === 1 ? "commit" : "commits"}
        </Text>
        <PrChevron open={open} />
      </Pressable>
      {open ? (
        <Animated.View
          entering={PR_FADE_IN}
          exiting={FADE_OUT}
          className="border-t border-border py-1"
        >
          {props.commits.map((commit) => (
            <View key={commit.oid} className="flex-row items-center gap-2.5 px-4 py-2">
              {commit.authors?.[0] ? (
                <PrAvatar actor={commit.authors[0]} size={18} />
              ) : (
                <View className="size-[18px]" />
              )}
              <Text numberOfLines={1} className="min-w-0 flex-1 text-[13px] text-foreground">
                {commit.messageHeadline}
              </Text>
              <Text className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-foreground-tertiary">
                {commit.oid.slice(0, 7)}
              </Text>
            </View>
          ))}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/**
 * One remark on the timeline: the author's face on the rail, then a card with who, when and
 * any verdict, the file it was left on, and the body.
 */
function CommentItem(props: {
  item: PullRequestComment;
  last: boolean;
  onLinkPress: (href: string) => void;
}) {
  const { item } = props;
  const login = item.author?.login ?? "ghost";
  const review = reviewState(item.reviewState);
  const colorFor = useReviewToneColor();
  const reviewColor = review ? colorFor(review.tone) : null;
  return (
    <View className="flex-row gap-3 px-4">
      <View className="items-center pt-3">
        <PrAvatar actor={item.author} size={28} />
        {props.last ? null : <View className="mt-1 w-px flex-1 bg-border" />}
      </View>
      <View className="min-w-0 flex-1 pb-1 pt-3">
        <View
          className="overflow-hidden rounded-2xl border border-border bg-card"
          style={
            reviewColor && review?.tone !== "neutral"
              ? { borderColor: tint(reviewColor, 0.55) }
              : undefined
          }
        >
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1 px-3.5 pt-3">
            <Text numberOfLines={1} className="shrink text-[14px] font-t3-bold text-foreground">
              {login}
            </Text>
            {item.author?.isBot ? (
              <Text className="rounded bg-subtle px-1 text-[10px] font-t3-bold uppercase text-foreground-tertiary">
                bot
              </Text>
            ) : null}
            <Text className="text-xs text-foreground-tertiary">{relativeTime(item.createdAt)}</Text>
            {review && reviewColor ? (
              <View
                className="rounded-full px-2 py-0.5"
                style={{ backgroundColor: tint(reviewColor, 0.14) }}
              >
                <Text className="text-[11px] font-t3-bold" style={{ color: reviewColor }}>
                  {review.label}
                </Text>
              </View>
            ) : null}
          </View>
          {item.path ? (
            <Text
              numberOfLines={1}
              ellipsizeMode="head"
              className="mx-3.5 mt-2 self-start rounded-md bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-foreground-muted"
            >
              {item.path}
            </Text>
          ) : null}
          {item.body.trim() ? (
            <FileMarkdownPreview embedded markdown={item.body} onLinkPress={props.onLinkPress} />
          ) : (
            <Text className="px-3.5 pb-3 pt-1.5 text-[13px] italic text-foreground-muted">
              {review ? "No review summary." : "No comment body."}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

function Composer(props: {
  composer: PullRequestComposerState;
  canComment: boolean;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  target: string;
}) {
  const { composer, canComment, verdicts } = props;
  const [focused, setFocused] = useState(false);
  const theme = useUniwindTheme();
  const foreground = String(theme["--color-foreground"]);
  const placeholder = String(theme["--color-placeholder"]);
  const onPrimary = String(theme["--color-primary-foreground"]);
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const insets = useSafeAreaInsets();
  const modes = [
    ...(canComment ? (["comment"] as const) : []),
    ...verdicts.filter((verdict) => verdict !== "comment"),
  ];
  const verdict = modes.includes(composer.verdict) ? composer.verdict : modes[0];
  if (!verdict) {
    return (
      <View className="border-t border-border px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          Comments are not available on this pull request. Open it on its host to respond.
        </Text>
      </View>
    );
  }
  const expanded = focused || composer.body.length > 0 || composer.busy || composer.error !== null;
  const canSend =
    !composer.busy && (verdict === "comment" ? composer.body.trim().length > 0 : true);
  const confirm = () =>
    Alert.alert(
      verdict === "comment" ? "Post comment?" : "Submit review?",
      `This will publish to ${props.target}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Submit", onPress: () => void composer.send(verdict) },
      ],
    );
  return (
    <Animated.View
      layout={LAYOUT}
      className="gap-2 border-t border-border bg-screen px-3 pt-2.5"
      style={{ paddingBottom: keyboardVisible ? 10 : Math.max(insets.bottom, 10) }}
    >
      {composer.error ? <PrNotice flush lines={[composer.error]} /> : null}
      {expanded && modes.length > 1 ? (
        <Animated.View
          entering={PR_FADE_IN}
          className="flex-row flex-wrap gap-2"
          accessibilityRole="radiogroup"
        >
          {modes.map((mode) => (
            <PrChoice
              key={mode}
              label={VERDICT_LABEL[mode]}
              selected={verdict === mode}
              onPress={() => composer.setVerdict(mode)}
            />
          ))}
        </Animated.View>
      ) : null}
      <View className="flex-row items-end gap-2">
        <TextInput
          accessibilityLabel="Pull request comment or review"
          placeholder={verdict === "comment" ? "Add a comment" : "Add a note to your review"}
          placeholderTextColor={placeholder}
          multiline
          value={composer.body}
          onChangeText={composer.setBody}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={!composer.busy}
          maxLength={65536}
          textAlignVertical="top"
          className="max-h-36 min-h-11 min-w-0 flex-1 rounded-[22px] border border-input-border bg-input px-4 py-2.5 font-t3-regular text-[15px]"
          style={{ color: foreground }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={verdict === "comment" ? "Post comment" : VERDICT_LABEL[verdict]}
          accessibilityState={{ disabled: !canSend, busy: composer.busy }}
          disabled={!canSend}
          onPress={confirm}
          className={cn(
            "size-11 items-center justify-center rounded-full bg-primary active:opacity-80",
            !canSend && "opacity-40",
          )}
        >
          {composer.busy ? (
            <ActivityIndicator size="small" color={onPrimary} />
          ) : (
            <SymbolView
              name={verdict === "approve" ? "checkmark" : "arrow.up"}
              size={18}
              tintColor={onPrimary}
              type="monochrome"
            />
          )}
        </Pressable>
      </View>
    </Animated.View>
  );
}

/** Placeholder rows in the timeline's own rhythm while the conversation is read. */
function TimelineSkeleton() {
  return (
    <View accessibilityLabel="Loading conversation" className="flex-1 pt-4">
      {[0, 1, 2].map((index) => (
        <View key={index} className="flex-row gap-3 px-4 pb-4">
          <View className="size-7 rounded-full bg-subtle-strong" />
          <View className="flex-1 gap-2 rounded-2xl border border-border bg-card p-3.5">
            <PrSkeletonLine width="40%" strong />
            <PrSkeletonLine width="92%" />
            <PrSkeletonLine width="70%" />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The conversation, with the composer pinned below it. Commits sit behind one collapsed card,
 * since the comments are what a reviewer came for.
 */
export function PullRequestTimelineTab(props: {
  activity: EnvironmentQueryView<PullRequestActivity>;
  composer: PullRequestComposerState;
  canComment: boolean;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  target: string;
  refreshing: boolean;
  onRefresh: () => void;
  /** Opens a link in a comment, natively when it names a pull request. */
  onLinkPress: (href: string) => void;
  onScroll?: (event: NativeScrollEvent) => void;
}) {
  const { activity } = props;
  const data = activity.data;
  const refreshColor = String(useUniwindTheme()["--color-icon"]);
  return (
    <KeyboardAvoidingView automaticOffset behavior="padding" className="min-h-0 flex-1">
      {data === null ? (
        activity.error ? (
          <PrStateMessage
            icon="text.bubble"
            title="Could not load pull request activity"
            message={pullRequestFailureMessage(activity.error)}
          >
            <PrButton label="Retry" icon="arrow.clockwise" onPress={activity.refresh} />
          </PrStateMessage>
        ) : (
          <TimelineSkeleton />
        )
      ) : (
        <FlatList
          className="flex-1"
          data={data.comments}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          scrollEventThrottle={32}
          onScroll={props.onScroll ? (event) => props.onScroll?.(event.nativeEvent) : undefined}
          refreshControl={
            <RefreshControl
              refreshing={props.refreshing}
              onRefresh={props.onRefresh}
              tintColor={refreshColor}
            />
          }
          contentContainerStyle={{ paddingBottom: 16 }}
          ListHeaderComponent={
            <>
              {activity.error ? (
                <View className="pt-3">
                  <PrNotice
                    lines={[
                      `${pullRequestFailureMessage(activity.error)} Showing the last activity loaded.`,
                    ]}
                    actionLabel="Retry"
                    onAction={activity.refresh}
                  />
                </View>
              ) : null}
              <Commits commits={data.commits} />
            </>
          }
          ListEmptyComponent={
            <PrStateMessage
              icon="bubble.left.and.bubble.right"
              title="No comments yet"
              message="Start the conversation below."
            />
          }
          ListFooterComponent={
            data.commentsTruncated ? (
              <View className="mx-4 mt-3 rounded-xl bg-subtle px-3.5 py-3">
                <Text className="text-[13px] text-foreground-muted">
                  Showing {data.comments.length} of {data.commentCount} comments. Open the pull
                  request on its host for the full conversation.
                </Text>
              </View>
            ) : activity.isPending ? (
              <ActivityIndicator className="m-4" />
            ) : undefined
          }
          renderItem={({ item, index }) => (
            <CommentItem
              item={item}
              last={index === data.comments.length - 1}
              onLinkPress={props.onLinkPress}
            />
          )}
        />
      )}
      <Composer
        composer={props.composer}
        canComment={props.canComment}
        verdicts={props.verdicts}
        target={props.target}
      />
    </KeyboardAvoidingView>
  );
}
