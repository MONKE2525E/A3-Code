import { describe, expect, it } from "@effect/vitest";
import {
  DeviceBootError,
  DeviceId,
  LOCAL_DEVICE_HOST_ID,
  deviceToolInstallMessage,
} from "./device.ts";
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

describe("device tool install progress", () => {
  it("distinguishes a new install from an upgrade and chooses versions numerically", () => {
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: [],
        runningVersion: null,
      }),
    ).toBe("Installing device hub 0.11.0…");
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: ["0.9.0", "0.10.0"],
        runningVersion: null,
      }),
    ).toBe("Updating device hub from 0.10.0 to 0.11.0…");
  });
});
