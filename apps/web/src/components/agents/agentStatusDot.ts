import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { DateTime } from "effect";

/** Green while an agent's run is in flight, blue for finished work the user has not opened. */
export type AgentStatusDot = "active" | "unread";

export type AgentUnreadThreadShell = Pick<
  OrchestrationV2ThreadShell,
  "archivedAt" | "latestVisibleMessage" | "lastVisitedAt"
>;

/**
 * Active wins over unread, so an agent that finished one run and started another shows green.
 * Only the server's active run decides `active`; a selected agent that is idle has no dot.
 */
export function resolveAgentStatusDot(input: {
  readonly active: boolean;
  readonly unread: boolean;
}): AgentStatusDot | null {
  if (input.active) return "active";
  return input.unread ? "unread" : null;
}

/**
 * Whether a native thread has an assistant message newer than the user's last visit. Native
 * agents reply outside a finished run (voice summaries, bot-to-bot messages), so run completion
 * is not the signal. Visits are recorded only when the thread is opened, so refreshing the
 * roster never clears this. A thread that was never visited is read, as in the main sidebar.
 */
export function hasUnseenAssistantMessage(
  thread: AgentUnreadThreadShell,
  localVisitedAt: string | undefined,
): boolean {
  // The server projects the newest completed assistant message for native threads, whatever
  // run produced it. Its createdAt keeps history replays and edits from counting as new.
  const message = thread.latestVisibleMessage;
  if (message === null) return false;
  // Servers that track visits are authoritative, including an explicit null (never visited).
  const visitedMs =
    thread.lastVisitedAt === undefined
      ? localVisitedAt === undefined
        ? null
        : Date.parse(localVisitedAt)
      : thread.lastVisitedAt === null
        ? null
        : DateTime.toEpochMillis(thread.lastVisitedAt);
  if (visitedMs === null) return false;
  const messageAt = message.createdAt ?? message.updatedAt;
  return DateTime.toEpochMillis(messageAt) > visitedMs;
}
