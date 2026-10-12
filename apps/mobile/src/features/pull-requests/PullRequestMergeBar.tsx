import type { PullRequestDetail } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import { ActivityIndicator, Pressable, useColorScheme, View } from "react-native";
import Animated, { LinearTransition, ReduceMotion } from "react-native-reanimated";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type {
  PullRequestMenuCommand,
  PullRequestMenuItem,
  PullRequestMergeBox,
  PullRequestMergeTone,
} from "./pull-request-actions";
import { PR_EASE, tint } from "./pull-request-components";

const LAYOUT = LinearTransition.duration(200).easing(PR_EASE).reduceMotion(ReduceMotion.System);

const TONE_ICON: Record<PullRequestMergeTone, AppSymbolName> = {
  success: "checkmark.circle",
  failure: "exclamationmark.triangle",
  pending: "clock",
  none: "circle.dashed",
  draft: "circle.dashed",
  merged: "point.topleft.down.curvedto.point.bottomright.up",
  closed: "xmark.circle",
};

/** Inks shared with the state pill, so the box and the header never disagree about a colour. */
export function useMergeToneColor() {
  const dark = useColorScheme() === "dark";
  return (tone: PullRequestMergeTone) => {
    switch (tone) {
      case "success":
        return dark ? "#6ee7b7" : "#059669";
      case "failure":
      case "closed":
        return dark ? "#fca5a5" : "#dc2626";
      case "pending":
        return dark ? "#fcd34d" : "#b45309";
      case "merged":
        return dark ? "#c4b5fd" : "#7c3aed";
      default:
        return dark ? "#a1a1aa" : "#71717a";
    }
  };
}

/** The one menu-action shape both the split button and the three-dot menu hand to native. */
export function toMenuAction(item: PullRequestMenuItem): MenuAction {
  return {
    id: item.id,
    title: item.title,
    ...(item.subtitle ? { subtitle: item.subtitle } : {}),
    image: item.icon as string,
    ...(item.checked === undefined ? {} : { state: item.checked ? "on" : "off" }),
    attributes: { disabled: item.disabled ?? false, destructive: item.destructive ?? false },
  };
}

/**
 * The desktop header's merge area as a phone card: where the pull request stands on the left,
 * the split Merge button on the right with every other way to land it behind the chevron. Beside
 * the hero on a wide pane and under it on a phone; the parent decides.
 */
export function PullRequestMergeBar(props: {
  box: PullRequestMergeBox;
  pr: Pick<PullRequestDetail, "mergedAt" | "closedAt">;
  busy: boolean;
  onCommand: (command: PullRequestMenuCommand) => void;
  className?: string;
}) {
  const { box } = props;
  const colorFor = useMergeToneColor();
  const color = colorFor(box.tone);
  const detail =
    box.tone === "merged" && props.pr.mergedAt
      ? `Merged ${relativeTime(props.pr.mergedAt)}`
      : box.tone === "closed" && props.pr.closedAt
        ? `Closed ${relativeTime(props.pr.closedAt)}`
        : box.detail;
  const run = (command: PullRequestMenuCommand) => {
    if (command.kind !== "select-merge-method") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else {
      void Haptics.selectionAsync();
    }
    props.onCommand(command);
  };
  const hasActions = box.primary !== null || box.options.length > 0;
  return (
    <Animated.View
      layout={LAYOUT}
      className={cn("rounded-2xl border border-border bg-card p-3", props.className)}
    >
      <View className={cn("flex-row items-center gap-3", hasActions && "pb-3")}>
        <View
          className="size-9 items-center justify-center rounded-full"
          style={{ backgroundColor: tint(color, 0.16) }}
        >
          <SymbolView name={TONE_ICON[box.tone]} size={17} tintColor={color} type="monochrome" />
        </View>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-[15px] font-t3-bold text-foreground">
            {box.title}
          </Text>
          {detail ? (
            <Text numberOfLines={2} className="text-[12px] leading-[16px] text-foreground-muted">
              {detail}
            </Text>
          ) : null}
        </View>
      </View>
      {hasActions ? <MergeSplitButton box={box} busy={props.busy} onCommand={run} /> : null}
    </Animated.View>
  );
}

function MergeSplitButton(props: {
  box: PullRequestMergeBox;
  busy: boolean;
  onCommand: (command: PullRequestMenuCommand) => void;
}) {
  const { primary, options } = props.box;
  const theme = useUniwindTheme();
  const onPrimary = String(theme["--color-primary-foreground"]);
  const foreground = String(theme["--color-foreground"]);
  const actions = options.map(toMenuAction);
  const onPressAction = ({ nativeEvent }: { nativeEvent: { event: string } }) => {
    const item = options.find((entry) => entry.id === nativeEvent.event);
    if (item && !item.disabled) props.onCommand(item.command);
  };

  if (primary === null) {
    return (
      <ControlPillMenu actions={actions} onPressAction={onPressAction}>
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel="Merge options"
          className="min-h-11 flex-row items-center justify-center gap-1.5 rounded-full border border-input-border px-4"
        >
          <Text className="text-sm font-t3-medium text-foreground">Merge options</Text>
          <SymbolView name="chevron.down" size={14} tintColor={foreground} type="monochrome" />
        </View>
      </ControlPillMenu>
    );
  }

  const disabled = primary.disabled || props.busy;
  return (
    <View className="flex-row overflow-hidden rounded-full bg-primary">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={primary.label}
        accessibilityState={{ disabled, busy: props.busy }}
        disabled={disabled}
        onPress={() => props.onCommand(primary.command)}
        className={cn(
          "min-h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 px-4 active:opacity-80",
          disabled && "opacity-60",
        )}
      >
        {props.busy ? (
          <ActivityIndicator size="small" color={onPrimary} />
        ) : (
          <SymbolView name={primary.icon} size={16} tintColor={onPrimary} type="monochrome" />
        )}
        <Text numberOfLines={1} className="shrink text-[14px] font-t3-bold text-primary-foreground">
          {primary.label}
        </Text>
      </Pressable>
      {options.length > 0 ? (
        <>
          <View className="my-2.5 w-px bg-primary-foreground opacity-25" />
          <ControlPillMenu actions={actions} onPressAction={onPressAction}>
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel="More merge options"
              className="min-h-11 w-12 items-center justify-center active:opacity-80"
            >
              <SymbolView name="chevron.down" size={16} tintColor={onPrimary} type="monochrome" />
            </View>
          </ControlPillMenu>
        </>
      ) : null}
    </View>
  );
}
