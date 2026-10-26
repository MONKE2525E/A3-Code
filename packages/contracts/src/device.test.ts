import {
  DeviceServiceState,
  EasDeviceHostConfig,
  EasDeviceHostConfigs,
  SshDeviceHostConfigs,
} from "./device.ts";
import { secretSettingsFields } from "./settings.ts";
import { describe, expect, it } from "@effect/vitest";
import { DeviceBootError, DeviceId, LOCAL_DEVICE_HOST_ID } from "./device.ts";
import * as Schema from "effect/Schema";
const decodeBootError = Schema.decodeUnknownSync(DeviceBootError);
const encodeBootError = Schema.encodeSync(DeviceBootError);

it("keeps legacy boot errors compatible and round-trips optional safe diagnostics", () => {
  const legacy = {
    hostId: LOCAL_DEVICE_HOST_ID,
    deviceId: DeviceId.make("synthetic-avd"),
    reason: "launch_failed" as const,
    cause: { ok: false },
  };
  for (const diagnostic of [
    undefined,
    "avd_discovery_failed",
    "emulator_ports_exhausted",
  ] as const) {
    const error = new DeviceBootError({ ...legacy, ...(diagnostic ? { diagnostic } : {}) });
    const decoded = decodeBootError(encodeBootError(error));
    expect(decoded.diagnostic).toBe(diagnostic);
    expect(decoded.message).toBe(error.message);
    if (diagnostic === undefined) expect(decoded.message).toContain("could not start");
  }
});

const decodeSshHosts = Schema.decodeUnknownSync(SshDeviceHostConfigs);
const decodeEas = Schema.decodeUnknownSync(EasDeviceHostConfigs);
const encodeState = Schema.encodeSync(DeviceServiceState);
const decodeState = Schema.decodeUnknownSync(DeviceServiceState);
// The host summary as clients decoded it before EAS hosts existed.
const decodeOlderState = Schema.decodeUnknownSync(
  Schema.Struct({
    hosts: Schema.Array(
      Schema.Struct({ id: Schema.String, kind: Schema.Literals(["local", "ssh"]) }),
    ),
  }),
);

describe("configured device hosts", () => {
  it("reads SSH hosts saved before hosts had a kind, and bounds EAS sessions", () => {
    expect(decodeSshHosts([{ id: "mac", label: "Mac mini", target: "julius@mac" }])).toEqual([
      { kind: "ssh", id: "mac", label: "Mac mini", target: "julius@mac" },
    ]);
    expect(decodeEas([{ kind: "eas", id: "eas", label: "EAS Simulator" }])).toEqual([
      {
        kind: "eas",
        id: "eas",
        label: "EAS Simulator",
        accessToken: "",
        maxSessionMinutes: 30,
        idleMinutes: 10,
        maxConcurrentSessions: 2,
      },
    ]);
    expect(() =>
      decodeEas([{ kind: "eas", id: "eas", label: "EAS", maxSessionMinutes: 600 }]),
    ).toThrow();
    // The default idle limit of 10 is not smaller than a session limit of 10.
    expect(() =>
      decodeEas([{ kind: "eas", id: "eas", label: "EAS", maxSessionMinutes: 10 }]),
    ).toThrow();
  });

  it("marks the EAS access token as a secret setting", () => {
    expect(secretSettingsFields(EasDeviceHostConfig)).toEqual(["accessToken"]);
  });
});

describe("device state for clients from before EAS hosts", () => {
  const summary = {
    label: "Host",
    platforms: [],
    hubInstalled: true,
    agentDeviceInstalled: true,
  };
  const state = {
    hosts: [
      { ...summary, id: "local", kind: "local" as const },
      { ...summary, id: "eas", kind: "eas" as const },
    ],
    hostStatus: "ready" as const,
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 1,
  };

  it("sends EAS hosts where an older client does not look, and reads them back", () => {
    const wire = encodeState(state);
    expect(decodeOlderState(wire).hosts.map((host) => host.id)).toEqual(["local"]);
    expect(decodeState(wire).hosts).toEqual(state.hosts);
  });
});
