import * as Schema from "effect/Schema";
import { GrokBotId } from "./grokBot.ts";

/**
 * Answers a Grok Bot `secret-request` transcript entry. The value goes to the native secure
 * input only: it is never written to a thread, history, log, or any response, and no RPC reads a
 * stored value back.
 */
export const GrokBotSecretSubmitInput = Schema.Struct({
  botId: GrokBotId,
  sessionId: Schema.String.check(Schema.isMaxLength(1024)),
  entryId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536)),
});
/**
 * One secret question the bot is asking in a session. Read-only: it names the request so the
 * client can render a secure input and answer it with `GrokBotSecretSubmitInput`, and it never
 * carries a value, a target name, or anything the user typed.
 */
export const GrokBotSecretRequest = Schema.Struct({
  entryId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  sessionId: Schema.String.check(Schema.isMaxLength(1024)),
  title: Schema.String.check(Schema.isMaxLength(1024)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  /** `responded` once native recorded an answer or dismissal; only `pending` can be submitted. */
  state: Schema.Literals(["pending", "responded"]),
});
/**
 * Asks to dismiss a pending `secret-request`. Native has no dismissal for a secure input (its card
 * only submits, and `DismissGrokBotWidget` is for `widget` entries), so this always fails with
 * `unsupported` and the bot is never told. A client may hide the card on its own account.
 */
export const GrokBotSecretDismissInput = Schema.Struct({
  botId: GrokBotId,
  sessionId: Schema.String.check(Schema.isMaxLength(1024)),
  entryId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
export const GrokBotSecretDismissResult = Schema.Struct({ dismissed: Schema.Literal(true) });
export const GrokBotSecretPendingInput = Schema.Struct({
  botId: GrokBotId,
  sessionId: Schema.String.check(Schema.isMaxLength(1024)),
});
export const GrokBotSecretPendingResult = Schema.Struct({
  requests: Schema.Array(GrokBotSecretRequest),
});
export const GrokBotSecretSubmitResult = Schema.Struct({ accepted: Schema.Literal(true) });
export class GrokBotSecretError extends Schema.TaggedError<GrokBotSecretError>()(
  "GrokBotSecretError",
  {
    reason: Schema.Literals([
      "account_unavailable",
      "request_not_found",
      "already_answered",
      "refused",
      "unsupported",
      "unavailable",
    ]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "account_unavailable":
        return "Connect a Grok Bot account to answer this request.";
      case "request_not_found":
        return "That secure input is no longer being requested.";
      case "already_answered":
        return "That secure input was already answered.";
      case "refused":
        return "Grok Bot declined the secure input. The request may have expired or already been answered.";
      case "unsupported":
        return "Grok Bot cannot cancel a secure input. It stays open for the bot until answered.";
      default:
        return "The secure input could not be delivered. Try again.";
    }
  }
}
