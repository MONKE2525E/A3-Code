import type { GrokBotConnectorCard } from "@t3tools/contracts";

/**
 * Connect cards that a later `connected` card for the same connector has settled. The bot posts that
 * confirmation once sign-in lands, so the earlier card must stop offering a connection. A connector
 * that signs out and asks again is settled only up to its newest connect card.
 */
export function settledConnectorCardIds(
  messages: Iterable<{
    readonly id: string;
    readonly grokBotConnectorCard?: GrokBotConnectorCard | undefined;
  }>,
): ReadonlySet<string> {
  const waiting = new Map<number, string[]>();
  const settled = new Set<string>();
  for (const { id, grokBotConnectorCard: card } of messages) {
    if (card === undefined) continue;
    if (card.variant === "connect") {
      waiting.set(card.serverId, [...(waiting.get(card.serverId) ?? []), id]);
      continue;
    }
    for (const earlier of waiting.get(card.serverId) ?? []) settled.add(earlier);
    waiting.delete(card.serverId);
  }
  return settled;
}
