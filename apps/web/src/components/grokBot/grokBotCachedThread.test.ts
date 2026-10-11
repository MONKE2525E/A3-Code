import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  cachedGrokBotNativeInstanceId,
  findCachedGrokBotNativeThread,
  isGrokBotReadinessTransportFailure,
} from "./grokBotCachedThread";

const CURRENT = ProviderInstanceId.make("grok-bot-current");
const OLD = ProviderInstanceId.make("grok-bot-old");
const BINDING = "a".repeat(64);
const provider: ServerProvider = {
  instanceId: CURRENT,
  driver: ProviderDriverKind.make("grok-bot"),
  enabled: true,
  installed: true,
  version: null,
  status: "error",
  auth: { status: "authenticated" },
  checkedAt: DateTime.formatIso(DateTime.makeUnsafe("2026-01-01T00:00:00Z")),
  continuation: { groupKey: `grok-bot/account/${BINDING}` },
  models: [],
  slashCommands: [],
  skills: [],
};
function config(
  snapshot = provider,
  binding: unknown = BINDING,
): Pick<ServerConfig, "providers" | "settings"> {
  return {
    providers: [snapshot],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [CURRENT]: {
          driver: ProviderDriverKind.make("grok-bot"),
          config: { accountBinding: binding },
        },
      },
    },
  };
}

describe("cached native account resolution", () => {
  it("requires server open for an archived canonical conversation but resolves its active successor immediately", () => {
    const archived = {
      id: ThreadId.make("grok-bot:archived"),
      providerInstanceId: CURRENT,
      modelSelection: { instanceId: CURRENT, model: "bot-a" },
      createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00Z"),
      archivedAt: DateTime.makeUnsafe("2026-01-03T00:00:00Z"),
    };
    const input = { instanceId: CURRENT, botId: "bot-a" };
    expect(findCachedGrokBotNativeThread([archived], input)).toBeNull();
    const active = {
      ...archived,
      id: ThreadId.make("grok-bot:active"),
      createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      archivedAt: null,
    };
    expect(findCachedGrokBotNativeThread([archived, active], input)).toBe(active);
  });
  it("uses the authenticated settings-bound instance while readiness loads, including blocked send readiness", () => {
    expect(cachedGrokBotNativeInstanceId(config(), { kind: "pending" })).toBe(CURRENT);
    expect(
      cachedGrokBotNativeInstanceId(null, {
        kind: "blocked",
        instanceId: CURRENT,
        message: "endpoint unavailable",
      }),
    ).toBe(CURRENT);
  });
  it("rejects stale account identity, unauthenticated snapshots, disabled providers and ambiguous accounts", () => {
    expect(
      cachedGrokBotNativeInstanceId(config(provider, "b".repeat(64)), { kind: "pending" }),
    ).toBeNull();
    expect(
      cachedGrokBotNativeInstanceId(config({ ...provider, auth: { status: "unknown" } }), {
        kind: "pending",
      }),
    ).toBeNull();
    expect(
      cachedGrokBotNativeInstanceId(config({ ...provider, enabled: false }), { kind: "pending" }),
    ).toBeNull();
    expect(cachedGrokBotNativeInstanceId(config(provider, null), { kind: "pending" })).toBeNull();
    const ambiguous = config();
    expect(
      cachedGrokBotNativeInstanceId(
        {
          ...ambiguous,
          providers: [provider, { ...provider, instanceId: OLD }],
          settings: {
            ...ambiguous.settings,
            providerInstances: {
              ...ambiguous.settings.providerInstances,
              [OLD]: ambiguous.settings.providerInstances[CURRENT]!,
            },
          },
        },
        { kind: "pending" },
      ),
    ).toBeNull();
  });
  it("lets explicit account change, signout and permission denial override cached data", () => {
    expect(
      cachedGrokBotNativeInstanceId(config(provider, "b".repeat(64)), {
        kind: "ready",
        instanceId: CURRENT,
      }),
    ).toBeNull();
    expect(
      cachedGrokBotNativeInstanceId(config(), {
        kind: "unavailable",
        state: "account_changed",
        message: "changed",
      }),
    ).toBeNull();
    expect(
      cachedGrokBotNativeInstanceId(config(), {
        kind: "unavailable",
        state: "native_account_unavailable",
        message: "sign in",
      }),
    ).toBeNull();
    expect(
      cachedGrokBotNativeInstanceId(config(), { kind: "denied", message: "denied" }),
    ).toBeNull();
  });
  it("permits only typed transport failures to fall back to cached account identity", () => {
    expect(isGrokBotReadinessTransportFailure({ _tag: "ConnectionTransientError" })).toBe(true);
    expect(isGrokBotReadinessTransportFailure({ _tag: "EnvironmentRpcUnavailableError" })).toBe(
      true,
    );
    expect(
      isGrokBotReadinessTransportFailure({
        _tag: "RpcClientError",
        reason: { _tag: "SocketCloseError" },
      }),
    ).toBe(true);
    expect(
      isGrokBotReadinessTransportFailure({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
      }),
    ).toBe(false);
    expect(isGrokBotReadinessTransportFailure({ _tag: "EnvironmentAuthorizationError" })).toBe(
      false,
    );
    expect(
      isGrokBotReadinessTransportFailure({
        _tag: "GrokBotOrchestratorError",
        reason: "account_changed",
      }),
    ).toBe(false);
    expect(isGrokBotReadinessTransportFailure(new Error("network"))).toBe(false);
  });
});
