import type { PullRequestActor } from "@t3tools/contracts";
import { Image } from "expo-image";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

/** One easing for every pull request transition, and none at all when the system asks. */
export const PR_EASE = Easing.out(Easing.cubic);
export const PR_FADE_IN = FadeIn.duration(180).easing(PR_EASE).reduceMotion(ReduceMotion.System);

/** A hex ink at a low alpha, for tinted pill and badge backgrounds. */
export function tint(color: string, alpha = 0.14) {
  const value = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${value}` : color;
}

export function PrIconButton(props: {
  icon: AppSymbolName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const iconColor = String(useUniwindTheme()["--color-icon"]);
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled || props.busy, busy: props.busy }}
      disabled={props.disabled || props.busy}
      hitSlop={4}
      onPress={props.onPress}
      className={cn(
        "size-11 items-center justify-center rounded-full active:bg-subtle-strong",
        props.disabled && "opacity-45",
      )}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={iconColor} />
      ) : (
        <SymbolView name={props.icon} size={19} tintColor={iconColor} type="monochrome" />
      )}
    </Pressable>
  );
}

export function PrButton(props: {
  label: string;
  onPress: () => void;
  icon?: AppSymbolName;
  variant?: "outline" | "primary";
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const primary = props.variant === "primary";
  const foreground = String(useUniwindTheme()["--color-foreground"]);
  const onPrimary = String(useUniwindTheme()["--color-primary-foreground"]);
  const tintColor = primary ? onPrimary : foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled || props.busy, busy: props.busy }}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      className={cn(
        "min-h-11 flex-row items-center justify-center gap-1.5 rounded-full px-4",
        primary ? "bg-primary active:opacity-80" : "border border-input-border active:bg-subtle",
        (props.disabled || props.busy) && "opacity-50",
        props.className,
      )}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={tintColor} />
      ) : props.icon ? (
        <SymbolView name={props.icon} size={15} tintColor={tintColor} type="monochrome" />
      ) : null}
      <Text
        className={cn(
          "text-sm font-t3-medium",
          primary ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A selectable pill, used for single-choice groups where every option should stay visible. */
export function PrChoice(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-9 justify-center rounded-full border px-3.5",
        props.selected ? "border-primary bg-primary" : "border-input-border active:bg-subtle",
        props.disabled && "opacity-45",
      )}
    >
      <Text
        className={cn(
          "text-[13px]",
          props.selected ? "font-t3-medium text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A face for an account, or its initial where the host sends no picture. */
export function PrAvatar(props: {
  actor: Pick<PullRequestActor, "login" | "avatarUrl"> | null | undefined;
  size?: number;
}) {
  const size = props.size ?? 20;
  const login = props.actor?.login ?? "ghost";
  if (props.actor?.avatarUrl) {
    return (
      <Image
        source={{ uri: props.actor.avatarUrl }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        transition={120}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <View
      className="items-center justify-center rounded-full bg-subtle-strong"
      style={{ width: size, height: size }}
    >
      <Text
        className="font-t3-bold text-foreground-secondary"
        style={{ fontSize: Math.max(9, size * 0.45) }}
      >
        {login.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

/** A rounded surface that groups one kind of fact, the phone's version of a desktop panel. */
export function PrCard(props: { children: ReactNode; className?: string; title?: string }) {
  return (
    <View
      className={cn("overflow-hidden rounded-2xl border border-border bg-card", props.className)}
    >
      {props.title ? (
        <Text className="px-4 pb-1 pt-3 text-[11px] font-t3-bold uppercase tracking-wide text-foreground-tertiary">
          {props.title}
        </Text>
      ) : null}
      {props.children}
    </View>
  );
}

/** A coloured state or status pill: the ink on the text and icon, a wash of it behind. */
export function PrPill(props: {
  icon?: AppSymbolName;
  label: string;
  color: string;
  accessibilityLabel?: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      className="flex-row items-center gap-1 rounded-full px-2.5 py-1"
      style={{ backgroundColor: tint(props.color) }}
    >
      {props.icon ? (
        <SymbolView name={props.icon} size={13} tintColor={props.color} type="monochrome" />
      ) : null}
      <Text className="text-xs font-t3-bold" style={{ color: props.color }}>
        {props.label}
      </Text>
    </View>
  );
}

/** A static placeholder bar. Nothing pulses: the layout settling is the only motion. */
export function PrSkeletonLine(props: {
  width: number | `${number}%`;
  height?: number;
  strong?: boolean;
}) {
  return (
    <View
      className={cn("rounded-md", props.strong ? "bg-subtle-strong" : "bg-subtle")}
      style={{ width: props.width, height: props.height ?? 12 }}
    />
  );
}

/**
 * Said once a read has taken long enough to wonder about, so it is mounted only while loading
 * and appears after `afterMs`. Pull requests are read by the server on the reader's computer, so
 * a slow or unreachable connection there is the usual cause, and the way out is to retry or read
 * it on the host instead.
 */
export function PrSlowLoadHint(props: { afterMs?: number; children?: ReactNode }) {
  const iconColor = String(useUniwindTheme()["--color-icon-muted"]);
  const [slow, setSlow] = useState(false);
  const afterMs = props.afterMs ?? 6_000;
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  if (!slow) return null;
  return (
    <Animated.View
      entering={PR_FADE_IN}
      accessibilityLiveRegion="polite"
      className="mx-4 mt-3 gap-3 rounded-2xl border border-border bg-card px-4 py-3.5"
    >
      <View className="flex-row items-start gap-2.5">
        <View className="pt-0.5">
          <SymbolView name="clock" size={16} tintColor={iconColor} type="monochrome" />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-[14px] font-t3-medium text-foreground">
            Still waiting on your environment
          </Text>
          <Text className="text-[13px] leading-[18px] text-foreground-muted">
            Pull requests are read by T3 Code on your computer. A slow or unreachable connection to
            it holds this up.
          </Text>
        </View>
      </View>
      {props.children ? <View className="flex-row flex-wrap gap-2">{props.children}</View> : null}
    </Animated.View>
  );
}

/**
 * The page-sized state: nothing to list, nothing loaded, or a failure with a way out. Centered in
 * the space the content would have used, with the one action that can change the outcome.
 */
export function PrStateMessage(props: {
  icon: AppSymbolName;
  title: string;
  message?: string;
  loading?: boolean;
  children?: ReactNode;
}) {
  const iconColor = String(useUniwindTheme()["--color-icon-muted"]);
  return (
    <Animated.View entering={PR_FADE_IN} className="flex-1 items-center justify-center px-8 py-10">
      <View className="mb-4 size-14 items-center justify-center rounded-2xl border border-border bg-card">
        {props.loading ? (
          <ActivityIndicator size="small" color={iconColor} />
        ) : (
          <SymbolView name={props.icon} size={22} tintColor={iconColor} type="monochrome" />
        )}
      </View>
      <Text className="text-center text-base font-t3-bold text-foreground">{props.title}</Text>
      {props.message ? (
        <Text
          selectable
          className="mt-1.5 max-w-[340px] text-center text-sm leading-5 text-foreground-muted"
        >
          {props.message}
        </Text>
      ) : null}
      {props.children ? (
        <View className="mt-5 flex-row flex-wrap justify-center gap-2">{props.children}</View>
      ) : null}
    </Animated.View>
  );
}

/** A problem worth a line above content that did load. Lines are shown as given. */
export function PrNotice(props: {
  lines: ReadonlyArray<string>;
  actionLabel?: string;
  onAction?: () => void;
  /** Drops the outer margin where the parent already pads its content. */
  flush?: boolean;
}) {
  const warning = String(useUniwindTheme()["--color-danger-foreground"]);
  if (props.lines.length === 0) return null;
  return (
    <Animated.View
      entering={PR_FADE_IN}
      accessibilityRole="alert"
      className={cn(
        "flex-row items-start gap-2.5 rounded-xl border border-danger-border bg-danger px-3 py-2.5",
        !props.flush && "mx-4 mb-2",
      )}
    >
      <View className="pt-0.5">
        <SymbolView
          name="exclamationmark.triangle"
          size={15}
          tintColor={warning}
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        {props.lines.map((line) => (
          <Text key={line} selectable className="text-[13px] leading-[18px] text-danger-foreground">
            {line}
          </Text>
        ))}
      </View>
      {props.actionLabel && props.onAction ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          onPress={props.onAction}
        >
          <Text className="text-[13px] font-t3-bold text-danger-foreground">
            {props.actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

/**
 * The detail tabs: a segmented track with one thumb that slides to the selected tab, as the
 * desktop's underline does, with counts in their own small badge.
 */
export function PrTabs<Key extends string>(props: {
  tabs: ReadonlyArray<{ key: Key; label: string; badge?: string | number | undefined }>;
  selected: Key;
  onSelect: (key: Key) => void;
}) {
  const [width, setWidth] = useState(0);
  const count = Math.max(1, props.tabs.length);
  const index = Math.max(
    0,
    props.tabs.findIndex((tab) => tab.key === props.selected),
  );
  const segment = width > 0 ? (width - 8) / count : 0;
  const offset = useSharedValue(index * segment);
  useEffect(() => {
    offset.set(
      withTiming(index * segment, {
        duration: 220,
        easing: PR_EASE,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [index, offset, segment]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));
  return (
    <View className="px-4 pb-2">
      <View
        accessibilityRole="tablist"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        className="flex-row rounded-full bg-subtle p-1"
      >
        {segment > 0 ? (
          <Animated.View
            pointerEvents="none"
            className="absolute bottom-1 left-1 top-1 rounded-full border border-border bg-card"
            style={[{ width: segment }, thumb]}
          />
        ) : null}
        {props.tabs.map((tab) => {
          const selected = tab.key === props.selected;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => props.onSelect(tab.key)}
              className="min-h-9 flex-1 flex-row items-center justify-center gap-1.5 rounded-full"
            >
              <Text
                className={cn(
                  "text-[13px]",
                  selected
                    ? "font-t3-bold text-foreground"
                    : "font-t3-medium text-foreground-muted",
                )}
              >
                {tab.label}
              </Text>
              {tab.badge !== undefined && tab.badge !== "" ? (
                <View
                  className={cn(
                    "min-w-5 items-center rounded-full px-1.5",
                    selected ? "bg-subtle-strong" : "bg-subtle",
                  )}
                >
                  <Text className="text-[11px] font-t3-medium text-foreground-secondary">
                    {tab.badge}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A chevron that turns rather than swaps when its section opens. */
export function PrChevron(props: { open: boolean; size?: number }) {
  const iconColor = String(useUniwindTheme()["--color-icon-muted"]);
  const rotation = useSharedValue(props.open ? 90 : 0);
  useEffect(() => {
    rotation.set(
      withTiming(props.open ? 90 : 0, {
        duration: 180,
        easing: PR_EASE,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [props.open, rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.get()}deg` }] }));
  return (
    <Animated.View style={style}>
      <SymbolView
        name="chevron.right"
        size={props.size ?? 13}
        tintColor={iconColor}
        type="monochrome"
      />
    </Animated.View>
  );
}
