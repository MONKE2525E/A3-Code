import * as Schema from "effect/Schema";
import { GrokBotId } from "./grokBot.ts";

export const GrokBotComputerInput = Schema.Struct({ botId: GrokBotId });
/** The signed native socket URL is ephemeral and must never be persisted or logged. */
export const GrokBotComputer = Schema.Struct({
  state: Schema.String,
  socketUrl: Schema.optionalKey(Schema.String),
});
export const GrokBotTeachRecording = Schema.Struct({
  state: Schema.Literals(["idle", "recording"]),
  agentId: Schema.NullOr(GrokBotId),
  startedAtMs: Schema.NullOr(Schema.Number),
  maxDurationMs: Schema.Number,
});
export const GrokBotTeachStartInput = Schema.Struct({
  botId: GrokBotId,
  entryPoint: Schema.Literals(["screen_hover", "composer_menu", "fullscreen_title_bar"]),
});
export const GrokBotTeachStopInput = Schema.Struct({ botId: GrokBotId, save: Schema.Boolean });
/** Recreating replaces the account's computer. `confirm` must be literally true, so a client cannot trigger it by omission. */
export const GrokBotComputerRecreateInput = Schema.Struct({
  preserveData: Schema.Boolean,
  confirm: Schema.Literal(true),
});
export const GrokBotComputerRecreateResult = Schema.Struct({
  started: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  operationId: Schema.optionalKey(Schema.String),
});
/**
 * Native "restore last saved snapshot" (ForceRecreateSandBox, no arguments): the account's
 * computer is rebuilt from its last saved snapshot, so changes since that snapshot are lost.
 * `confirm` must be literally true.
 */
export const GrokBotComputerResetInput = Schema.Struct({ confirm: Schema.Literal(true) });
export const GrokBotComputerResetResult = GrokBotComputerRecreateResult;
export const GrokBotComputerUpgradeScheduleInput = Schema.Struct({});
export const GrokBotComputerUpgradeScheduleResult = Schema.Struct({
  schedule: Schema.NullOr(
    Schema.Struct({
      timezone: Schema.optionalKey(Schema.String),
      localTime: Schema.optionalKey(Schema.String),
      recurring: Schema.optionalKey(Schema.Boolean),
      targetImageTag: Schema.optionalKey(Schema.String),
      nextFireAtMs: Schema.optionalKey(Schema.Number),
      state: Schema.optionalKey(Schema.String),
      lastCompletedImageTag: Schema.optionalKey(Schema.String),
      failureReason: Schema.optionalKey(Schema.String),
    }),
  ),
});
export class GrokBotComputerError extends Schema.TaggedError<GrokBotComputerError>()(
  "GrokBotComputerError",
  { reason: Schema.Literals(["account_unavailable", "unavailable"]) },
) {
  override get message() {
    return this.reason === "account_unavailable"
      ? "Connect a Grok Bot account to open its computer."
      : "The Grok Bot computer is unavailable. Try starting it or reconnecting.";
  }
}
