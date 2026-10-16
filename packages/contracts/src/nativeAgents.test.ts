import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { isGrokBotBackingThread } from "./orchestrationV2.ts";
import {
  NativeAgentReference,
  nativeAgentBackingThreadReference,
  nativeAgentSourceForDriver,
  nativeAgentSourceForThread,
} from "./nativeAgents.ts";

describe("native agent identity", () => {
  it("keeps Muse Code, ordinary threads and coding subagents separate", () => {
    expect(nativeAgentSourceForDriver("muse")).toBeUndefined();
    expect(nativeAgentSourceForDriver("claudeAgent")).toBeUndefined();
    expect(nativeAgentSourceForThread({ id: "thread:delegated-task:abc" })).toBeUndefined();
    expect(nativeAgentSourceForThread({ id: "ordinary-thread" })).toBeUndefined();
  });

  it("preserves Grok classification without enabling Grok controls on Muse", () => {
    expect(nativeAgentSourceForThread({ id: "grok-bot:saved-hash" })).toBe("grok-bot");
    expect(nativeAgentSourceForThread({ id: "muse-agent:saved-hash" })).toBe("muse-agent");
    expect(isGrokBotBackingThread({ id: "muse-agent:saved-hash" })).toBe(false);
    expect(isGrokBotBackingThread({ id: "grok-bot:saved-hash" })).toBe(true);
  });

  it("uses the saved instance and model rather than interpreting opaque hashes", () => {
    expect(
      nativeAgentBackingThreadReference({
        id: "muse-agent:opaque",
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse-on-remote-host"),
          model: "muse",
        },
      }),
    ).toEqual({ source: "muse-agent", providerInstanceId: "muse-on-remote-host", agentId: "muse" });
  });

  it("rejects coding-provider references at the native wire boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(NativeAgentReference)({
        source: "muse",
        providerInstanceId: "muse",
        agentId: "muse",
      }),
    ).toThrow();
  });
});
