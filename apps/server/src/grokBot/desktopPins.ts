/**
 * The Grok Bot desktop app keeps its sidebar pins as a JSON array inside one of
 * its client-persistence blobs. Bots with no T3 pin preference start from it.
 */
const PINNED_PATTERN = /"pinnedAgentIds"\s*:\s*(\[[^\]]*\])/;

export function parsePinnedAgentIds(text: string): ReadonlyArray<string> {
  const match = PINNED_PATTERN.exec(text);
  if (match?.[1] === undefined) return [];
  try {
    const ids: unknown = JSON.parse(match[1]);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
