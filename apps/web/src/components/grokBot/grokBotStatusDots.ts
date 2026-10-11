import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DateTime } from "effect";

import { findGrokBotNativeThread } from "./grokBotNativeThread";

/** Green while a bot's run is in flight, blue for finished work the user has not opened. */
export type GrokBotStatusDot = "active" | "unread";

export type GrokBotUnreadThreadShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "providerInstanceId"
  | "modelSelection"
  | "archivedAt"
  | "createdAt"
  | "latestVisibleMessage"
  | "lastVisitedAt"
>;

/**
 * Active wins over unread, so a bot that finished one run and started another shows green.
 * Only the server's active run decides `active`; a selected bot that is idle has no dot.
 */
export function resolveGrokBotStatusDot(input: {
  readonly active: boolean;
  readonly unread: boolean;
}): GrokBotStatusDot | null {
  if (input.active) return "active";
  return input.unread ? "unread" : null;
}

/**
 * Bots whose native thread has an assistant message newer than the user's last visit. Native
 * bots reply outside a finished run (voice summaries, bot-to-bot messages), so run completion
 * is not the signal. Visits are recorded only when the thread is opened, so refreshing the
 * roster never clears this. A thread that was never visited is read, as in the main sidebar.
 */
export function selectGrokBotUnreadBotIds<T extends GrokBotUnreadThreadShell>(input: {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<T>;
  readonly instanceId: ProviderInstanceId;
  /** Browser-local visit watermarks, keyed by scoped thread key. */
  readonly localLastVisitedAt: Readonly<Record<string, string>>;
}): ReadonlySet<string> {
  const botIds = new Set<string>();
  for (const thread of input.threads) {
    if (thread.providerInstanceId === input.instanceId) botIds.add(thread.modelSelection.model);
  }
  const unreadBotIds = new Set<string>();
  for (const botId of botIds) {
    const thread = findGrokBotNativeThread(input.threads, {
      instanceId: input.instanceId,
      botId,
    });
    if (thread === null || thread.archivedAt !== null) continue;
    const localVisitedAt =
      input.localLastVisitedAt[scopedThreadKey(scopeThreadRef(input.environmentId, thread.id))];
    if (hasUnseenAssistantMessage(thread, localVisitedAt)) unreadBotIds.add(botId);
  }
  return unreadBotIds;
}

function hasUnseenAssistantMessage(
  thread: GrokBotUnreadThreadShell,
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
