import * as Schema from "effect/Schema";
import { GrokBotId } from "./grokBot.ts";

/**
 * A routine owned and run by the native Grok Bot account. T3 only reads it and flips its
 * enabled state; it never schedules or fires one. Fields mirror the native automation
 * record's own summary strings so T3 does not reinterpret its trigger.
 */
export const GrokBotRoutine = Schema.Struct({
  botId: GrokBotId,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  name: Schema.String,
  /** Native human-readable schedule, for example a cron or interval description. */
  schedule: Schema.String,
  /** Native description of what starts it (schedule, webhook, and so on). */
  triggerDescription: Schema.String,
  isEnabled: Schema.Boolean,
  createdAt: Schema.Number,
  nextRunAt: Schema.optionalKey(Schema.Number),
});

export const GrokBotRoutinesListInput = Schema.Struct({
  timeZone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});

export const GrokBotRoutinesListResult = Schema.Struct({
  routines: Schema.Array(GrokBotRoutine),
  /** Bots whose routines could not be read this time. Their routines are omitted, not empty. */
  unavailableBotIds: Schema.Array(GrokBotId),
});

export const GrokBotRoutineSetEnabledInput = Schema.Struct({
  botId: GrokBotId,
  routineId: GrokBotRoutine.fields.id,
  isEnabled: Schema.Boolean,
  timeZone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});

export const GrokBotRoutineSetEnabledResult = Schema.Struct({
  botId: GrokBotId,
  routines: Schema.Array(GrokBotRoutine),
});

export const GrokBotRoutineDeleteInput = Schema.Struct({
  botId: GrokBotId,
  routineId: GrokBotRoutine.fields.id,
  timeZone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});

export const GrokBotRoutineDeleteResult = GrokBotRoutineSetEnabledResult;

export class GrokBotRoutineError extends Schema.TaggedError<GrokBotRoutineError>()(
  "GrokBotRoutineError",
  {
    reason: Schema.Literals([
      "provider_not_ready",
      "account_changed",
      "unavailable",
      "routine_not_found",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider_not_ready":
        return "No Grok Bot account is connected, so its routines cannot be read.";
      case "account_changed":
        return "The selected Grok Bot account changed. Reload routines and try again.";
      case "unavailable":
        return "Grok Bot routines are unavailable right now. Try again shortly.";
      case "routine_not_found":
        return "That routine no longer exists on this Grok Bot account.";
    }
  }
}
