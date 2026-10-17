import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as RpcClientError from "effect/rpc/RpcClientError";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  describeMuseNativeOpenFailure,
  guardMuseNativeSend,
  isMuseSessionThread,
  museNativeAttachSendGate,
  museSessionForThread,
  openCachedMuseThread,
  resolveMuseAgentNativeOpenPlan,
  resolveMuseOutboxAttachAction,
  resolveQueuedMuseOutboxIdentity,
} from "./museAgentThread";

const identity = "a".repeat(64);
const main = `muse-agent:${identity}`;
const side = `${main}:${encodeURIComponent("side:chat /one")}`;
const historical = ProviderInstanceId.make("historical-muse-provider");
const museProviders = [{ instanceId: historical, driver: "muse-agent" }];

describe("canonical Muse session decode", () => {
  it("decodes main chat and side-chat session ids", () => {
    expect(museSessionForThread(main)).toBeUndefined();
    expect(museSessionForThread(side)).toBe("side:chat /one");
    expect(museSessionForThread(undefined)).toBeUndefined();
    expect(museSessionForThread(`${main}:%broken`)).toBeUndefined();
  });

  it("accepts only canonical Muse session threads", () => {
    expect(isMuseSessionThread(main, null)).toBe(true);
    expect(isMuseSessionThread(side, null)).toBe(false);
    expect(isMuseSessionThread(side, "side:chat /one")).toBe(true);
    expect(isMuseSessionThread(side, "other")).toBe(false);
    expect(isMuseSessionThread("grok-bot:abc", null)).toBe(false);
    expect(isMuseSessionThread("ordinary-thread", null)).toBe(false);
  });
});

describe("resolveMuseAgentNativeOpenPlan", () => {
  it("never plans native open for ordinary or Grok threads", () => {
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: "ordinary-thread",
        providerInstanceId: historical,
        providers: museProviders,
      }),
    ).toEqual({ kind: "skip", reason: "not-muse" });
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: "grok-bot:saved-hash",
        providerInstanceId: historical,
        providers: museProviders,
      }),
    ).toEqual({ kind: "skip", reason: "not-muse" });
  });

  it("skips malformed Muse ids before any RPC", () => {
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: "muse-agent:not-a-canonical-id",
        providerInstanceId: historical,
        providers: museProviders,
      }),
    ).toEqual({ kind: "skip", reason: "malformed" });
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: `${main}:%ZZ`,
        providerInstanceId: historical,
        providers: museProviders,
      }),
    ).toEqual({ kind: "skip", reason: "malformed" });
  });

  it("waits for live providers, then treats official nightly as graceful absence", () => {
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: main,
        providerInstanceId: historical,
        providers: null,
      }),
    ).toEqual({ kind: "wait" });
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: main,
        providerInstanceId: historical,
        providers: [],
      }),
    ).toEqual({ kind: "unavailable", reason: "capability-absent" });
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: main,
        providerInstanceId: historical,
        providers: [{ instanceId: historical, driver: "codex" }],
      }),
    ).toEqual({ kind: "unavailable", reason: "capability-absent" });
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: main,
        providerInstanceId: historical,
        providers: [{ instanceId: "other-muse", driver: "muse-agent" }],
      }),
    ).toEqual({ kind: "unavailable", reason: "capability-absent" });
  });

  it("opens only the historical muse-agent instance for main and side chats", () => {
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: main,
        providerInstanceId: historical,
        providers: museProviders,
      }),
    ).toEqual({ kind: "open", providerInstanceId: historical });
    expect(
      resolveMuseAgentNativeOpenPlan({
        threadId: side,
        providerInstanceId: historical,
        providers: museProviders,
      }),
    ).toEqual({
      kind: "open",
      providerInstanceId: historical,
      sessionId: "side:chat /one",
    });
  });
});

describe("openCachedMuseThread", () => {
  const environmentId = EnvironmentId.make("remote-env");
  const shells = [main, side].map((id) => ({
    environmentId,
    id,
    providerInstanceId: historical,
  }));

  it.each([main, side])("reattaches %s with the historical instance", async (threadId) => {
    const openThread = vi.fn(async () => ({ threadId: ThreadId.make(threadId) }));
    const navigate = vi.fn(async () => {});
    await openCachedMuseThread({
      hit: { environmentId, threadId },
      shells,
      openThread,
      navigate,
    });
    expect(openThread).toHaveBeenCalledWith({
      environmentId,
      input: {
        providerInstanceId: historical,
        ...(threadId === side ? { sessionId: "side:chat /one" } : {}),
      },
    });
    expect(navigate).toHaveBeenCalledWith({
      environmentId,
      threadId: ThreadId.make(threadId),
    });
  });

  it.each(["failure", "interrupted", "other-account"])(
    "does not navigate after %s",
    async (outcome) => {
      const navigate = vi.fn(async () => {});
      const opening = openCachedMuseThread({
        hit: { environmentId, threadId: side },
        shells,
        navigate,
        openThread: async () => {
          if (outcome === "failure") throw new Error("Wait for the active Muse turn and retry.");
          return outcome === "interrupted"
            ? null
            : { threadId: ThreadId.make(`muse-agent:${"b".repeat(64)}`) };
        },
      });
      if (outcome === "interrupted") await opening;
      else
        await expect(opening).rejects.toThrow(
          outcome === "failure" ? "active Muse turn" : "different Muse account",
        );
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("rejects missing or malformed shells before opening", async () => {
    const openThread = vi.fn(async () => ({ threadId: ThreadId.make(main) }));
    const navigate = vi.fn(async () => {});
    await expect(
      openCachedMuseThread({
        hit: { environmentId, threadId: `${main}:%ZZ` },
        shells: [{ environmentId, id: `${main}:%ZZ`, providerInstanceId: historical }],
        openThread,
        navigate,
      }),
    ).rejects.toThrow("unavailable");
    expect(openThread).not.toHaveBeenCalled();
  });
});

describe("describeMuseNativeOpenFailure", () => {
  it("surfaces transport and unknown-method RPC as a generic retryable error", () => {
    expect(
      describeMuseNativeOpenFailure(
        new EnvironmentRpcUnavailableError({
          environmentId: "env",
          message: "socket timeout token=secret",
        }),
      ),
    ).toBe("Could not reconnect this Muse conversation.");
    expect(
      describeMuseNativeOpenFailure(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({
            message: "method not found",
            cause: new Error("method not found"),
          }),
        }),
      ),
    ).toBe("Could not reconnect this Muse conversation.");
  });

  it("keeps native Muse privacy failures retryable with their messages", () => {
    expect(
      describeMuseNativeOpenFailure(new Error("Wait for the active Muse turn and retry.")),
    ).toBe("Wait for the active Muse turn and retry.");
    expect(
      describeMuseNativeOpenFailure(
        new Error("This Muse conversation is unavailable. Refresh search and try again."),
      ),
    ).toBe("This Muse conversation is unavailable. Refresh search and try again.");
    expect(
      describeMuseNativeOpenFailure(
        new Error(
          "This conversation belongs to a different Muse account. Reconnect that account to open it.",
        ),
      ),
    ).toBe(
      "This conversation belongs to a different Muse account. Reconnect that account to open it.",
    );
    expect(describeMuseNativeOpenFailure("nope")).toBe(
      "Could not reconnect this Muse conversation.",
    );
  });
});

describe("museNativeAttachSendGate", () => {
  it("allows ordinary threads without waiting for attach", () => {
    expect(
      museNativeAttachSendGate({
        planKind: "skip",
        connected: true,
        canOpen: true,
        attached: false,
        error: null,
      }),
    ).toEqual({ sendAllowed: true, sendBlockedReason: null });
    expect(
      museNativeAttachSendGate({
        planKind: "skip",
        connected: false,
        canOpen: false,
        attached: false,
        error: "ignored",
      }),
    ).toEqual({ sendAllowed: true, sendBlockedReason: null });
  });

  it("blocks unsupported Muse even if previously attached", () => {
    expect(
      museNativeAttachSendGate({
        planKind: "unavailable",
        connected: true,
        canOpen: true,
        attached: true,
        error: null,
      }),
    ).toEqual({
      sendAllowed: false,
      sendBlockedReason: expect.stringContaining("no longer provides"),
    });
  });

  it("blocks wait, first paint, disconnect, permission, and error until attached", () => {
    expect(
      museNativeAttachSendGate({
        planKind: "wait",
        connected: true,
        canOpen: true,
        attached: false,
        error: null,
      }).sendAllowed,
    ).toBe(false);
    expect(
      museNativeAttachSendGate({
        planKind: "open",
        connected: true,
        canOpen: true,
        attached: false,
        error: null,
      }),
    ).toEqual({
      sendAllowed: false,
      sendBlockedReason: "Connecting Muse history…",
    });
    expect(
      museNativeAttachSendGate({
        planKind: "open",
        connected: false,
        canOpen: true,
        attached: true,
        error: null,
      }).sendBlockedReason,
    ).toBe("Connecting Muse history…");
    expect(
      museNativeAttachSendGate({
        planKind: "open",
        connected: true,
        canOpen: false,
        attached: true,
        error: null,
      }).sendBlockedReason,
    ).toMatch(/permission/);
    expect(
      museNativeAttachSendGate({
        planKind: "open",
        connected: true,
        canOpen: true,
        attached: false,
        error: "Could not reconnect this Muse conversation.",
      }),
    ).toEqual({
      sendAllowed: false,
      sendBlockedReason: "Retry Muse connection to send",
    });
    expect(
      museNativeAttachSendGate({
        planKind: "open",
        connected: true,
        canOpen: true,
        attached: true,
        error: null,
      }),
    ).toEqual({ sendAllowed: true, sendBlockedReason: null });
  });

  it("does not invoke send while the attach reason is set", async () => {
    const send = vi.fn(async () => "sent");
    await expect(guardMuseNativeSend("Connecting Muse history…", send)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
    await expect(guardMuseNativeSend(null, send)).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("queued Muse outbox identity", () => {
  const liveMuse = { id: main, providerInstanceId: historical };

  it("treats ordinary threads as already captured without Muse identity", () => {
    expect(
      resolveQueuedMuseOutboxIdentity({
        threadId: "ordinary-thread",
        queuedProviderInstanceId: historical,
        liveThread: liveMuse,
        providers: museProviders,
      }),
    ).toEqual({ kind: "ordinary" });
  });

  it("uses the queued historical provider on a canonical Muse thread", () => {
    expect(
      resolveQueuedMuseOutboxIdentity({
        threadId: side,
        queuedProviderInstanceId: historical,
        liveThread: { id: side, providerInstanceId: ProviderInstanceId.make("other-muse") },
        providers: museProviders,
      }),
    ).toEqual({
      kind: "muse",
      providerInstanceId: historical,
      sessionId: "side:chat /one",
    });
  });

  it("infers an old row only from the exact advertised live thread", () => {
    expect(
      resolveQueuedMuseOutboxIdentity({
        threadId: main,
        liveThread: liveMuse,
        providers: museProviders,
      }),
    ).toEqual({ kind: "muse", providerInstanceId: historical });
    expect(
      resolveQueuedMuseOutboxIdentity({
        threadId: main,
        liveThread: { id: main, providerInstanceId: ProviderInstanceId.make("codex") },
        providers: museProviders,
      }),
    ).toEqual({ kind: "unverified" });
    expect(
      resolveQueuedMuseOutboxIdentity({
        threadId: main,
        liveThread: { id: side, providerInstanceId: historical },
        providers: museProviders,
      }),
    ).toEqual({ kind: "unverified" });
    expect(
      resolveQueuedMuseOutboxIdentity({
        threadId: main,
        liveThread: null,
        providers: null,
      }),
    ).toEqual({ kind: "wait" });
  });
});

describe("resolveMuseOutboxAttachAction", () => {
  const liveMuse = { id: main, providerInstanceId: historical };

  it("lets ordinary send proceed without opening Muse", () => {
    expect(
      resolveMuseOutboxAttachAction({
        threadId: "ordinary-thread",
        queuedProviderInstanceId: ProviderInstanceId.make("codex"),
        liveThread: { id: "ordinary-thread", providerInstanceId: ProviderInstanceId.make("codex") },
        providers: [{ instanceId: "codex", driver: "codex" }],
        connected: true,
        canOpen: true,
      }),
    ).toEqual({ action: "proceed" });
  });

  it("restores unsupported Muse and parks transiently blocked rows", () => {
    expect(
      resolveMuseOutboxAttachAction({
        threadId: main,
        queuedProviderInstanceId: historical,
        liveThread: liveMuse,
        providers: [{ instanceId: historical, driver: "codex" }],
        connected: true,
        canOpen: true,
      }),
    ).toEqual({ action: "restore", reason: expect.stringContaining("no longer provides") });
    expect(
      resolveMuseOutboxAttachAction({
        threadId: main,
        queuedProviderInstanceId: historical,
        liveThread: liveMuse,
        providers: museProviders,
        connected: false,
        canOpen: true,
      }),
    ).toEqual({ action: "park" });
    expect(
      resolveMuseOutboxAttachAction({
        threadId: main,
        queuedProviderInstanceId: historical,
        liveThread: liveMuse,
        providers: museProviders,
        connected: true,
        canOpen: false,
      }),
    ).toEqual({ action: "park" });
    expect(
      resolveMuseOutboxAttachAction({
        threadId: "muse-agent:not-canonical",
        queuedProviderInstanceId: historical,
        liveThread: liveMuse,
        providers: museProviders,
        connected: true,
        canOpen: true,
      }),
    ).toEqual({ action: "restore", reason: expect.stringContaining("no longer provides") });
  });

  it("opens the historical provider and expected canonical thread", () => {
    expect(
      resolveMuseOutboxAttachAction({
        threadId: side,
        queuedProviderInstanceId: historical,
        liveThread: { id: side, providerInstanceId: historical },
        providers: museProviders,
        connected: true,
        canOpen: true,
      }),
    ).toEqual({
      action: "open",
      providerInstanceId: historical,
      sessionId: "side:chat /one",
      expectedThreadId: side,
    });
  });
});
