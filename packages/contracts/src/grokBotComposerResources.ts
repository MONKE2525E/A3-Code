import * as Schema from "effect/Schema";
import { GrokBotId } from "./grokBot.ts";

/**
 * Native T3 managed-turn skill. It is installed for T3's own session binding and is
 * not a user-mentionable composer skill.
 */
export const GROK_BOT_MANAGED_COMPOSER_SKILL_NAME = "t3-code-managed-turn-v1";

/**
 * A mentionable native skill. `id` is the native workflowReference id (user-own
 * skills are `sand-workflow:<kebab-name>` when the native store uses that encoding).
 * Skill bodies never leave the server.
 */
export const GrokBotComposerSkill = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  origin: Schema.Literals(["user", "agent"]),
  /** Composer token alias; the native workflow reference continues to use `id`. */
  chipName: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  ),
});
export type GrokBotComposerSkill = typeof GrokBotComposerSkill.Type;

/** Another bot that native @ mention serializes as `{type:"mention", attrs:{id,label}}`. */
export const GrokBotComposerBot = Schema.Struct({
  id: GrokBotId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  avatarShape: Schema.optionalKey(Schema.String),
  avatarColor: Schema.optionalKey(Schema.String),
});
export type GrokBotComposerBot = typeof GrokBotComposerBot.Type;

/**
 * An installed native plugin/connector. Mention id is `plugin:${pluginId}`.
 * MCP config, credentials, and plugin file contents are never included.
 */
export const GrokBotComposerConnector = Schema.Struct({
  pluginId: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  displayName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  connectorType: Schema.Literals(["unspecified", "user", "team"]),
});
export type GrokBotComposerConnector = typeof GrokBotComposerConnector.Type;

export const GrokBotComposerResourcesInput = Schema.Struct({
  botId: GrokBotId,
});
export type GrokBotComposerResourcesInput = typeof GrokBotComposerResourcesInput.Type;

export const GrokBotComposerResources = Schema.Struct({
  skills: Schema.Array(GrokBotComposerSkill),
  bots: Schema.Array(GrokBotComposerBot),
  connectors: Schema.Array(GrokBotComposerConnector),
});
export type GrokBotComposerResources = typeof GrokBotComposerResources.Type;

export class GrokBotComposerResourcesError extends Schema.TaggedError<GrokBotComposerResourcesError>()(
  "GrokBotComposerResourcesError",
  {
    reason: Schema.Literals(["provider_not_ready", "account_changed", "unavailable"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider_not_ready":
        return "No Grok Bot account is connected, so its skills and connectors cannot be read.";
      case "account_changed":
        return "The selected Grok Bot account changed. Reload skills and try again.";
      case "unavailable":
        return "Grok Bot skills and connectors are unavailable right now. Try again shortly.";
    }
  }
}
