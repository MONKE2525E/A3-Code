import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  type GrokBotUnreadThreadShell,
  resolveGrokBotStatusDot,
  selectGrokBotUnreadBotIds,
} from "./grokBotStatusDots";

const ENVIRONMENT = "env-a" as EnvironmentId;
const OTHER_ENVIRONMENT = "env-b" as EnvironmentId;
const INSTANCE = "grok-bot-current" as ProviderInstanceId;
const EARLY = "2026-01-01T00:00:00Z";
const MIDDLE = "2026-01-02T00:00:00Z";
const LATE = "2026-01-03T00:00:00Z";

function shell(input: {
  readonly id: string;
  readonly model: string;
  /** createdAt of the newest completed assistant message; null means none. */
  readonly messageAt?: string | null;
  /** updatedAt of that message; defaults to messageAt. Edits and replays move this, not createdAt. */
  readonly messageUpdatedAt?: string;
  readonly visitedAt?: string | null | undefined;
  readonly archived?: boolean;
}): GrokBotUnreadThreadShell & { readonly id: ThreadId } {
  // Only the fields the status selector reads; `lastVisitedAt` undefined means a pre-tracking server.
  return {
    id: `grok-bot:${input.id}` as ThreadId,
    providerInstanceId: INSTANCE,
    modelSelection: { instanceId: INSTANCE, model: input.model },
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    archivedAt: input.archived ? DateTime.makeUnsafe(LATE) : null,
    latestVisibleMessage:
      input.messageAt == null
        ? null
        : {
            id: `message:${input.id}`,
            role: "assistant",
            text: "",
            createdAt: DateTime.makeUnsafe(input.messageAt),
            updatedAt: DateTime.makeUnsafe(input.messageUpdatedAt ?? input.messageAt),
          },
    lastVisitedAt:
      input.visitedAt === undefined
        ? undefined
        : input.visitedAt === null
          ? null
          : DateTime.makeUnsafe(input.visitedAt),
  } as unknown as GrokBotUnreadThreadShell & { readonly id: ThreadId };
}

function unreadBots(
  threads: ReadonlyArray<GrokBotUnreadThreadShell>,
  localLastVisitedAt: Readonly<Record<string, string>> = {},
  environmentId: EnvironmentId = ENVIRONMENT,
): ReadonlySet<string> {
  return selectGrokBotUnreadBotIds({
    environmentId,
    threads,
    instanceId: INSTANCE,
    localLastVisitedAt,
  });
}

describe("resolveGrokBotStatusDot", () => {
  it("shows green while active, even when there is also unread work", () => {
    expect(resolveGrokBotStatusDot({ active: true, unread: true })).toBe("active");
    expect(resolveGrokBotStatusDot({ active: true, unread: false })).toBe("active");
  });

  it("shows blue for unread work that is not active", () => {
    expect(resolveGrokBotStatusDot({ active: false, unread: true })).toBe("unread");
  });

  it("shows no dot for an idle bot with nothing unread", () => {
    expect(resolveGrokBotStatusDot({ active: false, unread: false })).toBeNull();
  });
});

describe("selectGrokBotUnreadBotIds", () => {
  it("flags an assistant message newer than the server's visit watermark", () => {
    const threads = [shell({ id: "t1", model: "bot-1", messageAt: LATE, visitedAt: MIDDLE })];
    expect(unreadBots(threads).has("bot-1")).toBe(true);
  });

  it("flags a runless native reply, such as a voice summary or a bot-to-bot message", () => {
    // No run ever completed for this thread; only the reply's own timestamp is newer.
    const threads = [shell({ id: "t1", model: "bot-1", messageAt: LATE, visitedAt: MIDDLE })];
    expect(unreadBots(threads).has("bot-1")).toBe(true);
  });

  it("does not flag a replayed history message that predates the visit", () => {
    // Refresh or replay touches updatedAt, but the message's createdAt is still old.
    const threads = [
      shell({
        id: "t1",
        model: "bot-1",
        messageAt: EARLY,
        messageUpdatedAt: LATE,
        visitedAt: MIDDLE,
      }),
    ];
    expect(unreadBots(threads).has("bot-1")).toBe(false);
  });

  it("clears once the user has viewed the thread after the run completed", () => {
    const threads = [shell({ id: "t1", model: "bot-1", messageAt: MIDDLE, visitedAt: LATE })];
    expect(unreadBots(threads).has("bot-1")).toBe(false);
  });

  it("treats a thread that was never visited as read, as the main sidebar does", () => {
    const threads = [shell({ id: "t1", model: "bot-1", messageAt: LATE, visitedAt: null })];
    expect(unreadBots(threads).has("bot-1")).toBe(false);
  });

  it("uses the browser-local watermark only when the server does not track visits", () => {
    const localKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT, "grok-bot:t1" as ThreadId));
    const preTracking = [shell({ id: "t1", model: "bot-1", messageAt: LATE })];
    expect(unreadBots(preTracking, { [localKey]: EARLY }).has("bot-1")).toBe(true);
    expect(unreadBots(preTracking, { [localKey]: LATE }).has("bot-1")).toBe(false);

    // A server that tracks visits is authoritative: a stale local watermark cannot hide unread work.
    const tracked = [shell({ id: "t1", model: "bot-1", messageAt: LATE, visitedAt: EARLY })];
    expect(unreadBots(tracked, { [localKey]: LATE }).has("bot-1")).toBe(true);
  });

  it("does not flag a bot with no visible assistant message", () => {
    const threads = [shell({ id: "t1", model: "bot-1", messageAt: null, visitedAt: EARLY })];
    expect(unreadBots(threads).has("bot-1")).toBe(false);
  });

  it("ignores an archived bot thread", () => {
    const threads = [
      shell({ id: "t1", model: "bot-1", messageAt: LATE, visitedAt: EARLY, archived: true }),
    ];
    expect(unreadBots(threads).has("bot-1")).toBe(false);
  });

  it("keeps each bot's unread state separate from the others", () => {
    const threads = [
      shell({ id: "t1", model: "bot-1", messageAt: LATE, visitedAt: EARLY }),
      shell({ id: "t2", model: "bot-2", messageAt: LATE, visitedAt: LATE }),
    ];
    const unread = unreadBots(threads);
    expect(unread.has("bot-1")).toBe(true);
    expect(unread.has("bot-2")).toBe(false);
  });

  it("does not let another environment's visit clear this environment's unread work", () => {
    const threads = [shell({ id: "t1", model: "bot-1", messageAt: LATE })];
    const ownKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT, "grok-bot:t1" as ThreadId));
    const otherKey = scopedThreadKey(scopeThreadRef(OTHER_ENVIRONMENT, "grok-bot:t1" as ThreadId));
    expect(unreadBots(threads, { [ownKey]: EARLY, [otherKey]: LATE }).has("bot-1")).toBe(true);
  });
});
