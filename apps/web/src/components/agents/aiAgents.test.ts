import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { AgentUnreadThreadShell } from "./agentStatusDot";

import {
  findCachedMuseAgentThread,
  museAvatarStateForStatus,
  pickMuseAvatarVideo,
  resolveMuseAgentNotice,
  resolveMuseAgentSidebarState,
  resolveMuseAgentStatusDot,
  resolveMuseAvatarPlayback,
} from "./aiAgents";

describe("resolveMuseAgentNotice", () => {
  it("is ready only when the server says ready", () => {
    expect(
      resolveMuseAgentNotice({ status: { installed: true, sessionPresent: true, ready: true } }),
    ).toMatchObject({ kind: "ready", message: "Muse is connected." });
  });

  it("asks for install, then sign-in, then reports not-ready, in that order", () => {
    const base = { installed: false, sessionPresent: false, ready: false };
    expect(resolveMuseAgentNotice({ status: base }).kind).toBe("install");
    expect(resolveMuseAgentNotice({ status: { ...base, installed: true } }).kind).toBe("sign-in");
    expect(
      resolveMuseAgentNotice({ status: { ...base, installed: true, sessionPresent: true } }).kind,
    ).toBe("error");
  });

  it("prefers a query error and the server's own message", () => {
    expect(
      resolveMuseAgentNotice({
        status: { installed: true, sessionPresent: true, ready: true },
        error: "boom",
      }),
    ).toMatchObject({ kind: "error", message: "boom" });
    expect(
      resolveMuseAgentNotice({
        status: {
          installed: true,
          sessionPresent: false,
          ready: false,
          message: "Session expired",
        },
      }),
    ).toMatchObject({ kind: "sign-in", message: "Session expired" });
  });
});

describe("findCachedMuseAgentThread", () => {
  const thread = (
    id: string,
    instance: string,
    archivedAt: string | null,
    updatedAt = "2026-01-01T00:00:00Z",
  ) => ({
    id,
    providerInstanceId: instance,
    archivedAt,
    updatedAt,
  });

  it("ignores Grok, other accounts, and archived threads", () => {
    const threads = [
      thread("grok-bot:a", "i1", null),
      thread("muse-agent:b", "i2", null),
      thread("muse-agent:c", "i1", "2026-01-01"),
    ];
    expect(findCachedMuseAgentThread(threads, "i1")).toBeNull();
  });

  it("picks the most recently updated live thread", () => {
    const threads = [
      thread("muse-agent:old", "i1", null, "2026-01-01T00:00:00Z"),
      thread("muse-agent:new", "i1", null, "2026-02-01T00:00:00Z"),
    ];
    expect(findCachedMuseAgentThread(threads, "i1")?.id).toBe("muse-agent:new");
  });

  it("preserves the caller's thread type and compares DateTime-like timestamps", () => {
    const at = (epochMilliseconds: number) => ({ epochMilliseconds });
    const base = { providerInstanceId: "i1", archivedAt: null };
    const threads = [
      { ...base, id: "muse-agent:a", updatedAt: at(1), runtime: "x" },
      { ...base, id: "muse-agent:b", updatedAt: at(9), runtime: "y" },
      { ...base, id: "muse-agent:c", archivedAt: at(5), updatedAt: at(99), runtime: "z" },
    ];
    expect(findCachedMuseAgentThread(threads, "i1")?.runtime).toBe("y");
  });
});

describe("resolveMuseAgentSidebarState", () => {
  const ready = { installed: true, sessionPresent: true, ready: true };

  it("stays out of the way when Muse is not installed", () => {
    expect(
      resolveMuseAgentSidebarState({
        status: { installed: false, sessionPresent: false, ready: false, provider: null },
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("guides sign-in, offers enable once ready, then shows the row", () => {
    expect(
      resolveMuseAgentSidebarState({
        status: { ...ready, sessionPresent: false, ready: false, provider: null },
      }).kind,
    ).toBe("setup");
    expect(
      resolveMuseAgentSidebarState({ status: { ...ready, ready: false, provider: null } }),
    ).toEqual({ kind: "enable", mode: "connect", detail: null });
    expect(
      resolveMuseAgentSidebarState({
        status: { ...ready, provider: { instanceId: "muse-agent" } },
      }),
    ).toEqual({ kind: "row", instanceId: "muse-agent" });
  });

  it("offers reconnect, with the server's reason, when signed in with an unverified provider", () => {
    expect(
      resolveMuseAgentSidebarState({
        status: {
          ...ready,
          ready: false,
          message: " Session expired ",
          provider: { instanceId: "muse-agent" },
        },
      }),
    ).toEqual({ kind: "enable", mode: "reconnect", detail: "Session expired" });
  });

  it("surfaces a query failure instead of hiding", () => {
    expect(resolveMuseAgentSidebarState({ status: null, error: "offline" })).toMatchObject({
      kind: "setup",
      notice: { kind: "error", message: "offline" },
    });
  });
});

describe("sidebar loading and avatar art", () => {
  it("shows nothing while status is still loading", () => {
    expect(resolveMuseAgentSidebarState({ status: undefined })).toEqual({ kind: "hidden" });
  });

  it("falls back from a state to the idle clip, then default, then any, else none", () => {
    expect(pickMuseAvatarVideo({ talk: "t", idle: "i", default: "d" })).toBe("i");
    expect(pickMuseAvatarVideo({ talk: "t", default: "d" })).toBe("d");
    expect(pickMuseAvatarVideo({ talk: "t" })).toBe("t");
    expect(pickMuseAvatarVideo({ talk: "t", working: "w", idle: "i" }, "working")).toBe("w");
    expect(pickMuseAvatarVideo({ talk: "t", idle: "i" }, "working")).toBe("t");
    expect(pickMuseAvatarVideo({ idle: "i" }, "working")).toBe("i");
    expect(pickMuseAvatarVideo({})).toBeNull();
    expect(pickMuseAvatarVideo(null)).toBeNull();
  });

  it("plays the clip for each state, with hyphenated Muse keys matched", () => {
    const variants = {
      idle: "i",
      connecting: "c",
      working: "w",
      "waiting-for-subagents": "s",
    };
    expect(pickMuseAvatarVideo(variants, "connecting")).toBe("c");
    expect(pickMuseAvatarVideo(variants, "waiting")).toBe("s");
    expect(pickMuseAvatarVideo(variants, "working")).toBe("w");
    expect(pickMuseAvatarVideo(variants, "idle")).toBe("i");
  });

  it("maps only a running status out of idle", () => {
    expect(museAvatarStateForStatus("running")).toBe("working");
    expect(museAvatarStateForStatus("starting")).toBe("connecting");
    expect(museAvatarStateForStatus("waiting")).toBe("waiting");
    expect(museAvatarStateForStatus("idle")).toBe("idle");
    expect(museAvatarStateForStatus(undefined)).toBe("idle");
  });
});

describe("resolveMuseAvatarPlayback", () => {
  const all = {
    hasVideo: true,
    active: true,
    reducedMotion: false,
    onScreen: true,
    documentVisible: true,
  };

  it("plays only when every condition allows it", () => {
    expect(resolveMuseAvatarPlayback(all)).toBe("playing");
    for (const key of ["hasVideo", "active", "onScreen", "documentVisible"] as const) {
      expect(resolveMuseAvatarPlayback({ ...all, [key]: false })).toBe("parked");
    }
    expect(resolveMuseAvatarPlayback({ ...all, reducedMotion: true })).toBe("parked");
  });
});

describe("resolveMuseAgentStatusDot", () => {
  // A pre-tracking server reports no lastVisitedAt, so the browser's watermark decides.
  const reply: AgentUnreadThreadShell = {
    archivedAt: null,
    latestVisibleMessage: {
      createdAt: DateTime.makeUnsafe("2026-01-01T00:00:02Z"),
      updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:02Z"),
    },
  } as AgentUnreadThreadShell;

  it("shows no dot without a thread, but still shows active while a run is in flight", () => {
    expect(
      resolveMuseAgentStatusDot({ active: false, thread: null, localVisitedAt: undefined }),
    ).toBeNull();
    expect(
      resolveMuseAgentStatusDot({ active: true, thread: null, localVisitedAt: undefined }),
    ).toBe("active");
  });

  it("lets an active run win over an unread reply", () => {
    expect(
      resolveMuseAgentStatusDot({
        active: true,
        thread: reply,
        localVisitedAt: "2026-01-01T00:00:01Z",
      }),
    ).toBe("active");
  });

  it("marks a reply newer than the last local visit as unread, and clears once visited", () => {
    expect(
      resolveMuseAgentStatusDot({
        active: false,
        thread: reply,
        localVisitedAt: "2026-01-01T00:00:01Z",
      }),
    ).toBe("unread");
    expect(
      resolveMuseAgentStatusDot({
        active: false,
        thread: reply,
        localVisitedAt: "2026-01-01T00:00:03Z",
      }),
    ).toBeNull();
  });
});
