import { describe, expect, it } from "vite-plus/test";

import { limitsOnlyDrivers } from "./usageProviders";

const config = (drivers: string[], accounts: string[] = []) =>
  ({
    serverConfig: {
      providers: drivers.map((driver) => ({ driver, usageLimits: {} })),
      usageLimitSources: [{ accounts: accounts.map((driver) => ({ driver })) }],
    },
  }) as never;

describe("limitsOnlyDrivers", () => {
  it("lists only drivers without cost usage, keeping hidden ones", () => {
    expect(
      limitsOnlyDrivers([config(["codex", "grok-bot"], ["claudeAgent"]), { serverConfig: null }]),
    ).toEqual(["grok-bot"]);
    expect(limitsOnlyDrivers([config(["codex"])], ["grok-bot"])).toEqual(["grok-bot"]);
  });
});
