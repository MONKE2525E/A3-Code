import { describe, expect, it } from "vite-plus/test";

import { stageFromConfig } from "./AddGrokBotProviderStep";

type Config = NonNullable<Parameters<typeof stageFromConfig>[0]>;

const config = (overrides: Partial<Config> & { endpointReady?: boolean } = {}): Config =>
  ({
    bridge: { installed: true, sessionPresent: true },
    botIds: ["a", "b"],
    provider: null,
    state: "not_configured",
    publicEndpointReadiness: { ready: overrides.endpointReady ?? true, reason: null },
    ...overrides,
  }) as unknown as Config;

describe("Grok Bot connect stages", () => {
  it("shows a read error with a retry instead of checking forever", () => {
    expect(stageFromConfig(null).kind).toBe("checking");
    expect(stageFromConfig(null, "offline").kind).toBe("read-error");
  });

  it("walks install, sign-in, connect, ready", () => {
    const bridge = (installed: boolean, sessionPresent: boolean) =>
      config({ bridge: { installed, sessionPresent } as Config["bridge"] });
    expect(stageFromConfig(bridge(false, false)).kind).toBe("install");
    expect(stageFromConfig(bridge(true, false)).kind).toBe("sign-in");
    expect(stageFromConfig(config()).kind).toBe("connect");
    expect(stageFromConfig(config({ state: "ready" }))).toEqual({ kind: "ready", botCount: 2 });
  });

  it("routes an unreachable public endpoint to Connections", () => {
    expect(stageFromConfig(config({ state: "blocked", endpointReady: false })).kind).toBe(
      "endpoint",
    );
    expect(stageFromConfig(config({ state: "blocked" })).kind).toBe("blocked");
    expect(stageFromConfig(config({ state: "account_changed" })).kind).toBe("blocked");
  });

  it("reaches ready from the native sign-in without the CLI bridge", () => {
    const bridge = {
      installed: false,
      sessionPresent: false,
      nativeAvailable: true,
    } as Config["bridge"];
    expect(stageFromConfig(config({ bridge }))).toEqual({ kind: "connect", botCount: 2 });
    expect(stageFromConfig(config({ bridge, state: "ready" }))).toEqual({
      kind: "ready",
      botCount: 2,
    });
  });

  it("asks for the desktop sign-in, not the CLI, when native sign-in is unreadable", () => {
    const bridge = { installed: true, sessionPresent: true, nativeAvailable: false };
    expect(stageFromConfig(config({ bridge: bridge as Config["bridge"] })).kind).toBe("sign-in");
    expect(
      stageFromConfig(
        config({
          state: "native_account_unavailable",
          bridge: {
            installed: false,
            sessionPresent: false,
            nativeAvailable: true,
          } as Config["bridge"],
        }),
      ).kind,
    ).toBe("sign-in");
  });

  it("lets a failed refresh outrank retained data", () => {
    expect(stageFromConfig(config({ state: "ready" }), "offline").kind).toBe("read-error");
    expect(stageFromConfig(config({ state: "ready" }), null).kind).toBe("ready");
  });

  it("offers reconnect for a disabled matching provider but not a changed account", () => {
    const provider = { enabled: false } as Config["provider"];
    expect(stageFromConfig(config({ state: "blocked", provider }))).toEqual({
      kind: "reconnect",
      botCount: 2,
    });
    expect(stageFromConfig(config({ state: "account_changed", provider })).kind).toBe("blocked");
    expect(
      stageFromConfig(config({ state: "blocked", provider, endpointReady: false })),
    ).toMatchObject({ kind: "endpoint", reconnect: true });
    expect(
      stageFromConfig(
        config({ state: "blocked", provider: { enabled: true } as Config["provider"] }),
      ).kind,
    ).toBe("blocked");
  });
});
