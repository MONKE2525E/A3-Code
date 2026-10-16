import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import {
  type AgentStatusDot,
  type AgentUnreadThreadShell,
  hasUnseenAssistantMessage,
  resolveAgentStatusDot,
} from "../agents/agentStatusDot";
import { findGrokBotNativeThread } from "./grokBotNativeThread";

export type GrokBotStatusDot = AgentStatusDot;

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

export const resolveGrokBotStatusDot = resolveAgentStatusDot;

/**
 * Bots whose native thread has an assistant message newer than the user's last visit. The
 * per-thread rule is shared with the rest of the AI Agents section (see `agentStatusDot`).
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
    if (hasUnseenAssistantMessage(thread satisfies AgentUnreadThreadShell, localVisitedAt)) {
      unreadBotIds.add(botId);
    }
  }
  return unreadBotIds;
}
