import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ThreadId } from "./baseSchemas.ts";

export const MuseAgentAvatarVariant = Schema.String.check(Schema.isPattern(/^[a-z_-]{1,64}$/));

/** Account and cloud workspace identity, hashed by the server; never a credential. */
export const MuseAgentProviderSettings = Schema.Struct({
  accountBinding: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
export type MuseAgentProviderSettings = typeof MuseAgentProviderSettings.Type;

export const MuseAgentStatus = Schema.Struct({
  installed: Schema.Boolean,
  sessionPresent: Schema.Boolean,
  ready: Schema.Boolean,
  message: Schema.String,
  accountBinding: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
});
export type MuseAgentStatus = typeof MuseAgentStatus.Type;

/** Muse 6 has one personal assistant. Side chats are sessions of that assistant. */
export const MuseAgentProfile = Schema.Struct({
  id: Schema.Literal("muse"),
  name: Schema.String,
  creature: Schema.optionalKey(Schema.String),
  vibe: Schema.optionalKey(Schema.String),
  emoji: Schema.optionalKey(Schema.String),
  tagline: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  avatarPath: Schema.optionalKey(Schema.String),
  avatarImagePath: Schema.optionalKey(Schema.String),
  avatarVideoVariants: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  chatThemeColor: Schema.optionalKey(Schema.String),
});
export type MuseAgentProfile = typeof MuseAgentProfile.Type;

export const MuseAgentOpenThreadInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  /** A side chat's native session. Omitted opens Main chat. */
  sessionId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  ),
});
export type MuseAgentOpenThreadInput = typeof MuseAgentOpenThreadInput.Type;
export const MuseAgentOpenThreadResult = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
});
export type MuseAgentOpenThreadResult = typeof MuseAgentOpenThreadResult.Type;
