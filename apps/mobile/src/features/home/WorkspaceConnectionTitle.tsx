import { useAtomValue } from "@effect/atom-react";
import type { SupervisorConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  View,
} from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { SymbolView } from "../../components/AppSymbol";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import {
  brandTitleOffset,
  CompactBrandTitle,
  getCompactBrandHeaderOptions,
} from "../../components/CompactBrandTitle";
import { environmentCatalog } from "../../connection/catalog";
import { threadListEnvironmentsAtom } from "../../state/server";
import { useWorkspaceState } from "../../state/workspace";
import {
  workspaceDeviceStatuses,
  type WorkspaceDeviceBadge,
  type WorkspaceDeviceStatus,
} from "./workspace-connection-status";

/**
 * Delay before a connection interruption surfaces in the title slot. Sub-second
 * blips (the common reconnect case) resolve without any UI at all.
 */
const STATUS_SHOW_DELAY_MS = 800;
const FADE_IN_MS = 250;
const BADGE_IN_MS = 180;
const INDICATOR_LAYOUT_SIZE = 20;

const supervisorPhasesAtom = Atom.make((get) => {
  const phases = new Map<EnvironmentId, SupervisorConnectionPhase>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = AsyncResult.value(get(environmentCatalog.stateAtom(environmentId)));
    if (Option.isSome(state)) {
      phases.set(environmentId, state.value.phase);
    }
  }
  return phases;
}).pipe(Atom.withLabel("home:workspace-supervisor-phases"));

/**
 * Debounce brief interruptions; hide device status immediately on recovery.
 */
function useDelayedDeviceStatus(hasUnavailableDevice: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setVisible(hasUnavailableDevice),
      hasUnavailableDevice ? STATUS_SHOW_DELAY_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [hasUnavailableDevice]);
  return visible && hasUnavailableDevice;
}

/** Defaults to reduced motion until the system preference resolves, so nothing animates early. */
function useReducedMotionPreference(): boolean {
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => subscription.remove();
  }, []);

  return reducedMotion;
}

/**
 * One-shot entrance fade for the device icons. Deliberately JS-driven: this can
 * mount inside a native header item (RNSScreenStackHeaderSubview), where
 * native-driver animated nodes blank the re-hosted view entirely. The JS driver
 * updates opacity through the ordinary style path, which those subviews handle.
 */
function StatusFadeIn(props: {
  readonly children: ReactNode;
  readonly grow?: boolean;
  readonly maxWidth?: number;
  readonly reducedMotion: boolean;
}) {
  const [opacity] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const animation = Animated.timing(opacity, {
      duration: props.reducedMotion ? 0 : FADE_IN_MS,
      toValue: 1,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [opacity, props.reducedMotion]);

  return (
    <Animated.View
      style={[
        { alignItems: "center", flexDirection: "row", maxWidth: props.maxWidth, opacity },
        props.grow ? { flex: 1, minWidth: 0 } : null,
      ]}
    >
      {props.children}
    </Animated.View>
  );
}

/** Plays once when mounted, so it only animates on the transition into a not-connected state. */
function DeviceStatusBadge(props: {
  readonly kind: Exclude<WorkspaceDeviceBadge, "none">;
  readonly diameter: number;
  readonly reducedMotion: boolean;
}) {
  const [progress] = useState(() => new Animated.Value(props.reducedMotion ? 1 : 0));

  useEffect(() => {
    if (props.reducedMotion) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      duration: BADGE_IN_MS,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, props.reducedMotion]);

  return (
    <Animated.View
      style={{
        opacity: progress,
        position: "absolute",
        right: -props.diameter / 4,
        top: -props.diameter / 4,
        transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
      }}
    >
      <View
        className={
          props.kind === "failed"
            ? "items-center justify-center bg-danger"
            : "items-center justify-center bg-card"
        }
        style={{ borderRadius: props.diameter / 2, height: props.diameter, width: props.diameter }}
      >
        {props.kind === "failed" ? (
          <SymbolView
            name="xmark"
            size={Math.round(props.diameter * 0.7)}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        ) : props.reducedMotion ? (
          <SymbolView
            name="arrow.clockwise"
            size={Math.round(props.diameter * 0.7)}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        ) : (
          <AppActivityIndicator
            colorClassName="accent-icon"
            size="small"
            style={{ transform: [{ scale: props.diameter / INDICATOR_LAYOUT_SIZE }] }}
          />
        )}
      </View>
    </Animated.View>
  );
}

function DeviceStatusIcon(props: {
  readonly device: WorkspaceDeviceStatus;
  readonly size: number;
  readonly reducedMotion: boolean;
}) {
  const { device } = props;

  return (
    <Pressable
      accessibilityLabel={`${device.label}, ${device.statusLabel}`}
      accessibilityRole="button"
      style={{
        width: Math.max(44, props.size + 16),
        height: 44,
        alignItems: "center",
        justifyContent: "center",
      }}
      onPress={() =>
        Alert.alert(
          device.label,
          device.traceId
            ? `${device.statusLabel}\n\nTrace ID: ${device.traceId}`
            : device.statusLabel,
        )
      }
    >
      <EnvironmentMachineSymbol
        kind={device.machineKind}
        size={props.size}
        tintColorClassName={device.isConnected ? "accent-icon" : "accent-icon-muted"}
      />
      {device.badge === "none" ? null : (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: props.size,
            height: props.size,
            marginLeft: -props.size / 2,
            marginTop: -props.size / 2,
          }}
        >
          <DeviceStatusBadge
            kind={device.badge}
            diameter={Math.round(props.size * 0.6)}
            reducedMotion={props.reducedMotion}
          />
        </View>
      )}
    </Pressable>
  );
}

/**
 * Renders the brand/title slot of a thread-list surface, swapping the brand
 * for the workspace connection status while an environment is unavailable.
 * While any enabled device is not connected, the slot shows one icon per
 * device; tapping an icon reveals its full name and status.
 *
 * Both states occupy the same slot, so connection changes never shift the
 * layout below. While connected the brand renders untouched — no wrapper —
 * keeping the native header item on the exact element tree that predates the
 * status swap. Replaces the old WorkspaceConnectionStatus pill, which inserted
 * a row above the thread list.
 */
export function WorkspaceConnectionTitle(props: {
  /** Content shown while connected (brand lockup or a screen title). */
  readonly brand: ReactNode;
  /** Retained for existing header callers; device icons reveal their own status. */
  readonly onPress?: () => void;
  /** Fill the available row width (in-flow headers) instead of hugging content (native title slots). */
  readonly grow?: boolean;
  readonly size?: "navbar" | "pageTitle";
  /** Horizontal correction so the status aligns with the brand in native title slots. */
  readonly statusOffset?: number;
  /** Space available beside the native header actions. */
  readonly maxWidth?: number;
}) {
  const { state, environments } = useWorkspaceState();
  const { machineByEnvironmentId } = useAtomValue(threadListEnvironmentsAtom);
  const phaseByEnvironmentId = useAtomValue(supervisorPhasesAtom);
  const reducedMotion = useReducedMotionPreference();
  const size = props.size ?? "navbar";
  const { scale } = useAndroidControlSizing();

  const devices = workspaceDeviceStatuses(
    environments,
    machineByEnvironmentId,
    phaseByEnvironmentId,
    state.networkStatus,
  );
  const showsDevices = useDelayedDeviceStatus(devices.some((device) => !device.isConnected));

  if (!showsDevices) {
    return props.grow ? (
      <View style={{ alignItems: "center", flex: 1, flexDirection: "row", minWidth: 0 }}>
        {props.brand}
      </View>
    ) : (
      <>{props.brand}</>
    );
  }

  return (
    <StatusFadeIn grow={props.grow} maxWidth={props.maxWidth} reducedMotion={reducedMotion}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexShrink: 1, marginLeft: props.statusOffset ?? 0 }}
        contentContainerStyle={{ alignItems: "center" }}
      >
        {devices.map((device) => (
          <DeviceStatusIcon
            key={device.environmentId}
            device={device}
            reducedMotion={reducedMotion}
            size={Math.round((size === "pageTitle" ? 24 : 22) * scale)}
          />
        ))}
      </ScrollView>
    </StatusFadeIn>
  );
}

/**
 * getCompactBrandHeaderOptions with the brand slot upgraded to the
 * connection-status swap. Screens with an environment-settings callback apply
 * this over the static brand options at mount.
 */
export function getConnectionAwareBrandHeaderOptions(opts: {
  readonly headerWidth: number;
  readonly trailingItemCount?: number;
  readonly onOpenEnvironments: () => void;
  readonly fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"];
}): NativeStackNavigationOptions {
  // Leave room for bar margins, title spacing and the 44-point native actions.
  // Device icons scroll rather than pushing Settings into UIKit's overflow menu.
  const maxWidth = Math.max(0, opts.headerWidth - 64 - 44 * (opts.trailingItemCount ?? 1));

  return {
    ...getCompactBrandHeaderOptions(opts.fallbackTitleStyle),
    headerTitle: () => (
      <WorkspaceConnectionTitle
        brand={<CompactBrandTitle />}
        maxWidth={maxWidth}
        onPress={opts.onOpenEnvironments}
        statusOffset={brandTitleOffset()}
      />
    ),
  };
}
