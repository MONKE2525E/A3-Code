/**
 * Bots that never had a look chosen get one derived from their id, using the
 * same seeded pick as the Grok Bot app so a bot looks the same in both.
 */
const COLORS = [
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
] as const;
const SHAPES = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop",
] as const;

function fnv1a(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function defaultGrokBotAvatarColor(botId: string): string {
  let state = fnv1a(botId);
  state = (state + 1831565813) | 0;
  let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  const unit = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  return COLORS[Math.floor(unit * COLORS.length)]!;
}

export function defaultGrokBotAvatarShape(botId: string): string {
  let hash = fnv1a(botId) | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 73244475);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return SHAPES[((hash ^ (hash >>> 16)) >>> 0) % SHAPES.length]!;
}
