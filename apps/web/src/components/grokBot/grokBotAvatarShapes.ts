/** Every body the engine can draw. Bots keep any of these; other shape names fall back by bot id. */
export const GROK_BOT_AVATAR_KINDS = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
  "square",
  "sparkle",
  "clover",
  "flower",
  "heart",
  "house",
  "star",
] as const satisfies readonly string[];
export type GrokBotAvatarKind = (typeof GROK_BOT_AVATAR_KINDS)[number];

/** The shape grid in the Grok Bot character editor, five per row. */
export const GROK_BOT_PICKER_SHAPES = [
  "blob",
  "cloud",
  "square",
  "sparkle",
  "clover",
  "heart",
  "flower",
  "teardrop",
  "tablet",
  "wedge",
  "house",
  "star",
  "hex",
] as const satisfies readonly GrokBotAvatarKind[];

/** The shapes `gbot bots create` accepts. Keep in step with the server's CLI_CREATE_SHAPES. */
export const GROK_BOT_CREATE_SHAPES = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
] as const satisfies readonly GrokBotAvatarKind[];

/** Bots with an unknown shape name get one of these, chosen by bot id. */
export const GROK_BOT_UNKNOWN_SHAPE_KINDS = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop",
] as const satisfies readonly GrokBotAvatarKind[];

export const GROK_BOT_AVATAR_COLORS = {
  black: "#000000",
  brown: "#936439",
  red: "#ff263c",
  orange: "#ff6700",
  yellow: "#ff9800",
  green: "#00c972",
  cyan: "#00bca6",
  blue: "#1084fe",
  violet: "#9159fe",
  magenta: "#ff309b",
  gray: "#777777",
} as const;
export type GrokBotAvatarColor = keyof typeof GROK_BOT_AVATAR_COLORS;

/** Colors an unknown color name can resolve to; black is reserved for explicit choice. */
export const GROK_BOT_FALLBACK_COLORS = (
  Object.keys(GROK_BOT_AVATAR_COLORS) as GrokBotAvatarColor[]
).filter((color) => color !== "black");
