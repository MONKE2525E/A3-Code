import type {
  GrokBotOrchestratorConfig as GrokBotOrchestratorConfigSchema,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  findGrokBotNativeThread,
  grokBotNativeInstanceId,
  grokBotNativeReadiness,
} from "./grokBotNativeThread";

type GrokBotOrchestratorConfig = typeof GrokBotOrchestratorConfigSchema.Type;

const CURRENT = "grok-bot-current" as ProviderInstanceId;
const OLD = "grok-bot-old" as ProviderInstanceId;

function thread(input: {
  readonly id: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly createdAt: string;
  readonly archivedAt?: string | null;
}) {
  return {
    id: input.id as ThreadId,
    providerInstanceId: input.instanceId,
    modelSelection: { instanceId: input.instanceId, model: input.model },
    createdAt: DateTime.makeUnsafe(input.createdAt),
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
  };
}

describe("findGrokBotNativeThread", () => {
  it("matches only the current provider instance and bot", () => {
    const threads = [
      thread({
        id: "grok-bot:old-account",
        instanceId: OLD,
        model: "bot-a",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      thread({
        id: "grok-bot:other-bot",
        instanceId: CURRENT,
        model: "bot-b",
        createdAt: "2026-01-02T00:00:00Z",
      }),
      thread({
        id: "grok-bot:match",
        instanceId: CURRENT,
        model: "bot-a",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    ];
    expect(findGrokBotNativeThread(threads, { instanceId: CURRENT, botId: "bot-a" })?.id).toBe(
      "grok-bot:match",
    );
    expect(findGrokBotNativeThread(threads, { instanceId: CURRENT, botId: "bot-c" })).toBeNull();
  });

  it("ignores an ordinary provider thread that uses the same instance and bot", () => {
    const threads = [
      thread({
        id: "manual-grok-chat",
        instanceId: CURRENT,
        model: "bot-a",
        createdAt: "2026-03-01T00:00:00Z",
      }),
      thread({
        id: "grok-bot:canonical",
        instanceId: CURRENT,
        model: "bot-a",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ];
    expect(findGrokBotNativeThread(threads, { instanceId: CURRENT, botId: "bot-a" })?.id).toBe(
      "grok-bot:canonical",
    );
    expect(
      findGrokBotNativeThread([threads[0]!], { instanceId: CURRENT, botId: "bot-a" }),
    ).toBeNull();
  });

  it("prefers an active thread over a newer archived one, then the newest active", () => {
    const threads = [
      thread({
        id: "grok-bot:archived-newer",
        instanceId: CURRENT,
        model: "bot-a",
        createdAt: "2026-02-01T00:00:00Z",
        archivedAt: "2026-02-02T00:00:00Z",
      }),
      thread({
        id: "grok-bot:active-older",
        instanceId: CURRENT,
        model: "bot-a",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      thread({
        id: "grok-bot:active-newest",
        instanceId: CURRENT,
        model: "bot-a",
        createdAt: "2026-01-05T00:00:00Z",
      }),
    ];
    expect(findGrokBotNativeThread(threads, { instanceId: CURRENT, botId: "bot-a" })?.id).toBe(
      "grok-bot:active-newest",
    );
  });

  it("falls back to an archived thread when no active one exists", () => {
    const threads = [
      thread({
        id: "grok-bot:archived",
        instanceId: CURRENT,
        model: "bot-a",
        createdAt: "2026-01-01T00:00:00Z",
        archivedAt: "2026-01-02T00:00:00Z",
      }),
    ];
    expect(findGrokBotNativeThread(threads, { instanceId: CURRENT, botId: "bot-a" })?.id).toBe(
      "grok-bot:archived",
    );
  });
});

describe("grokBotNativeReadiness", () => {
  it("opens a thread only when the provider is ready", () => {
    const ready = {
      state: "ready",
      provider: { instanceId: CURRENT },
    } as unknown as GrokBotOrchestratorConfig;
    expect(grokBotNativeReadiness(ready)).toEqual({ kind: "ready", instanceId: CURRENT });
  });

  it("reports the server state with a plain message when it is not ready", () => {
    const notConfigured = {
      state: "not_configured",
      provider: null,
    } as unknown as GrokBotOrchestratorConfig;
    const readiness = grokBotNativeReadiness(notConfigured);
    expect(readiness).toMatchObject({ kind: "unavailable", state: "not_configured" });
    expect(readiness.kind === "unavailable" && readiness.message).toContain("Settings");
  });

  it("treats a ready state without a provider row as blocked", () => {
    const orphan = { state: "ready", provider: null } as unknown as GrokBotOrchestratorConfig;
    expect(grokBotNativeReadiness(orphan)).toMatchObject({
      kind: "unavailable",
      state: "blocked",
    });
  });

  it("keeps a bound provider openable while its send readiness is blocked", () => {
    const blocked = {
      state: "blocked",
      provider: { instanceId: CURRENT },
    } as unknown as GrokBotOrchestratorConfig;
    const readiness = grokBotNativeReadiness(blocked);
    expect(readiness).toMatchObject({ kind: "blocked", instanceId: CURRENT });
    expect(grokBotNativeInstanceId(readiness)).toBe(CURRENT);
  });

  it("hard-blocks an account change even when a provider row is present", () => {
    const changed = {
      state: "account_changed",
      provider: { instanceId: OLD },
    } as unknown as GrokBotOrchestratorConfig;
    expect(grokBotNativeReadiness(changed)).toMatchObject({
      kind: "unavailable",
      state: "account_changed",
    });
    expect(grokBotNativeInstanceId(grokBotNativeReadiness(changed))).toBeNull();
  });

  it("stays pending until the config has loaded", () => {
    expect(grokBotNativeReadiness(null)).toEqual({ kind: "pending" });
  });
});
