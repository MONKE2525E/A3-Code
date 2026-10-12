import type { GrokBotConnectorCard } from "@t3tools/contracts";

/**
 * The connector card in a native `send-message` entry (`message.type === "connector"`). Native
 * names the connector by host and by the server id the plugin authentication flow takes. An entry
 * that does not carry both is not a card this app can act on, so it stays absent.
 */
export function grokBotConnectorCard(message: unknown): GrokBotConnectorCard | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const wire = message as Record<string, unknown>;
  if (wire.type !== "connector") return undefined;
  const connector = typeof wire.connector === "string" ? wire.connector.trim() : "";
  const serverId = wire.serverId;
  if (
    connector.length === 0 ||
    connector.length > 256 ||
    typeof serverId !== "number" ||
    !Number.isSafeInteger(serverId) ||
    serverId < 1
  ) {
    return undefined;
  }
  return { connector, serverId, variant: wire.variant === "connected" ? "connected" : "connect" };
}

/** Plain text for clients and previews that do not draw the card. */
export function grokBotConnectorCardLabel(card: GrokBotConnectorCard): string {
  return card.variant === "connected" ? `${card.connector} connected` : `Connect ${card.connector}`;
}
