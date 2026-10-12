import {
  connectionStatusText,
  type NetworkStatus,
  type SupervisorConnectionPhase,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";

export type WorkspaceDeviceBadge = "none" | "connecting" | "failed";

export interface WorkspaceDeviceStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machineKind: EnvironmentMachineKind;
  readonly isConnected: boolean;
  readonly badge: WorkspaceDeviceBadge;
  /** Untruncated, for the tap reveal. */
  readonly statusLabel: string;
  readonly traceId: string | null;
}

type DeviceState = Pick<WorkspaceDeviceStatus, "badge" | "statusLabel" | "traceId">;

/**
 * The shared phase collapses an active retry and backoff into "reconnecting", so
 * the supervisor phase is needed to tell a spinning attempt from a failed one.
 */
function deviceState(
  environment: WorkspaceEnvironment,
  phase: SupervisorConnectionPhase | undefined,
  networkStatus: NetworkStatus,
): DeviceState {
  const { connectionState, connectionError, connectionErrorTraceId } = environment;

  if (
    networkStatus === "offline" &&
    (connectionState === "connected" ||
      connectionState === "connecting" ||
      connectionState === "reconnecting")
  ) {
    return { badge: "failed", statusLabel: "Offline", traceId: null };
  }

  switch (connectionState) {
    case "connected":
      return { badge: "none", statusLabel: "Connected", traceId: null };
    case "connecting":
      return { badge: "connecting", statusLabel: "Connecting", traceId: null };
    case "reconnecting":
      return {
        badge: phase === "connecting" ? "connecting" : "failed",
        statusLabel: connectionStatusText({
          phase: "reconnecting",
          error: connectionError,
          traceId: connectionErrorTraceId,
        }),
        traceId: connectionErrorTraceId,
      };
    case "offline":
      return { badge: "failed", statusLabel: "Offline", traceId: null };
    case "error":
      return {
        badge: "failed",
        statusLabel: connectionError ?? "Connection failed",
        traceId: connectionErrorTraceId,
      };
    case "unsupported":
      return {
        badge: "failed",
        statusLabel: connectionError ?? "Unsupported",
        traceId: connectionErrorTraceId,
      };
    case "available":
      return { badge: "none", statusLabel: "Not connected", traceId: null };
  }
}

export function workspaceDeviceStatuses(
  environments: ReadonlyArray<WorkspaceEnvironment>,
  machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>,
  phaseByEnvironmentId: ReadonlyMap<EnvironmentId, SupervisorConnectionPhase>,
  networkStatus: NetworkStatus = "online",
): ReadonlyArray<WorkspaceDeviceStatus> {
  return environments
    .filter((environment) => environment.isEnabled)
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.environmentLabel,
      machineKind: machineByEnvironmentId.get(environment.environmentId) ?? "server",
      isConnected: networkStatus !== "offline" && environment.connectionState === "connected",
      ...deviceState(
        environment,
        phaseByEnvironmentId.get(environment.environmentId),
        networkStatus,
      ),
    }));
}
