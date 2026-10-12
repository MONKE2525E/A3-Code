import type { SupervisorConnectionPhase } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import { workspaceDeviceStatuses } from "./workspace-connection-status";

describe("workspace device statuses", () => {
  function environment(overrides: Partial<WorkspaceEnvironment> = {}): WorkspaceEnvironment {
    return {
      environmentId: "environment-1" as never,
      environmentLabel: "Julius’s Mac mini",
      displayUrl: "",
      isRelayManaged: false,
      isEnabled: true,
      connectionState: "connected",
      connectionError: null,
      connectionErrorTraceId: null,
      ...overrides,
    };
  }

  function statusFor(
    overrides: Partial<WorkspaceEnvironment>,
    phase?: SupervisorConnectionPhase,
    networkStatus?: "online" | "offline",
  ) {
    const environmentId = "environment-1" as never;
    const phases = new Map(phase === undefined ? [] : [[environmentId, phase]]);
    return workspaceDeviceStatuses(
      [environment({ environmentId, ...overrides })],
      new Map(),
      phases,
      networkStatus,
    )[0]!;
  }

  it("keeps configured devices in order and uses each device's machine kind", () => {
    const environments = [
      environment({ environmentId: "a" as never, environmentLabel: "Laptop" }),
      environment({ environmentId: "b" as never, environmentLabel: "Studio" }),
    ];
    const machines = new Map([["b" as never, "mac-studio" as const]]);

    expect(workspaceDeviceStatuses(environments, machines, new Map())).toEqual([
      {
        environmentId: "a",
        label: "Laptop",
        machineKind: "server",
        isConnected: true,
        badge: "none",
        statusLabel: "Connected",
        traceId: null,
      },
      {
        environmentId: "b",
        label: "Studio",
        machineKind: "mac-studio",
        isConnected: true,
        badge: "none",
        statusLabel: "Connected",
        traceId: null,
      },
    ]);
  });

  it("spins while the first attempt is in flight without marking it failed", () => {
    expect(statusFor({ connectionState: "connecting" }, "connecting")).toMatchObject({
      isConnected: false,
      badge: "connecting",
      statusLabel: "Connecting",
    });
  });

  it("keeps spinning and shows the last failure while an active retry runs", () => {
    expect(
      statusFor(
        {
          connectionState: "reconnecting",
          connectionError: "Could not reach the tailnet address",
          connectionErrorTraceId: "trace-1",
        },
        "connecting",
      ),
    ).toMatchObject({
      isConnected: false,
      badge: "connecting",
      statusLabel: "Failed to connect. Reconnecting... Reason: Could not reach the tailnet address",
      traceId: "trace-1",
    });
  });

  it("marks a device failed while it waits in backoff, keeping the reason and trace", () => {
    expect(
      statusFor(
        {
          connectionState: "reconnecting",
          connectionError: "Could not reach the tailnet address",
          connectionErrorTraceId: "trace-2",
        },
        "backoff",
      ),
    ).toMatchObject({
      isConnected: false,
      badge: "failed",
      statusLabel: "Failed to connect. Reconnecting... Reason: Could not reach the tailnet address",
      traceId: "trace-2",
    });
  });

  it("reports blocked and unsupported devices as failed with their reason and trace", () => {
    expect(
      statusFor({
        connectionState: "error",
        connectionError: "Could not reach the Julius’s Mac mini environment over the tailnet",
        connectionErrorTraceId: "trace-3",
      }),
    ).toMatchObject({
      badge: "failed",
      statusLabel: "Could not reach the Julius’s Mac mini environment over the tailnet",
      traceId: "trace-3",
    });
    expect(statusFor({ connectionState: "unsupported" })).toMatchObject({
      badge: "failed",
      statusLabel: "Unsupported",
    });
  });

  it("shows no badge for a device that has not attempted a connection yet", () => {
    expect(statusFor({ connectionState: "available" }, "available")).toMatchObject({
      isConnected: false,
      badge: "none",
      statusLabel: "Not connected",
    });
  });

  it("overrides stale connected and connecting values when the network is offline", () => {
    expect(statusFor({ connectionState: "connected" }, "connected", "offline")).toMatchObject({
      isConnected: false,
      badge: "failed",
      statusLabel: "Offline",
    });
    expect(statusFor({ connectionState: "connecting" }, "connecting", "offline")).toMatchObject({
      isConnected: false,
      badge: "failed",
      statusLabel: "Offline",
    });
  });

  it("excludes deliberately switched-off devices", () => {
    expect(
      workspaceDeviceStatuses([environment({ isEnabled: false })], new Map(), new Map()),
    ).toEqual([]);
  });
});
