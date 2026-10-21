import * as Schema from "effect/Schema";

export const MUSE_AGENT_AVATAR_MAX_BYTES = 20 * 1024 * 1024;
export const museAgentAvatarPathPattern =
  "^/?workspace/avatars/(?!.*(?:^|/)\\.\\.?(?:/|$))[A-Za-z0-9_-][A-Za-z0-9_./-]*$";
export const MuseAgentAvatarPath = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(new RegExp(museAgentAvatarPathPattern)),
);
export const MuseAgentAvatarMime = Schema.Literals([
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
]);
export const museAgentAvatarMimes = [
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
] as const;
