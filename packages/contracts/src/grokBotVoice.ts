import * as Schema from "effect/Schema";
import { GrokBotId } from "./grokBot.ts";
import { ChatAttachmentId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";

const CallId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

/** The only realtime origin Grok Bot voice calls may dial (checked server-side and by the client). */
export const GROK_BOT_VOICE_REALTIME_ORIGIN = "wss://api.x.ai/";

/**
 * Short-lived xAI realtime credential. It crosses the wire once, to the client that owns the
 * microphone, and is never persisted, logged, or written to a transcript.
 */
export const GrokBotVoiceCredential = Schema.Struct({
  clientSecret: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  expiresAtUnixSeconds: Schema.Number,
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  websocketUrl: Schema.String.check(Schema.isMaxLength(2048)),
});

export const GrokBotVoiceToolDescriptor = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
});

export const GrokBotVoiceChatContext = Schema.Struct({
  afterSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String.check(Schema.isMaxLength(4_000)),
      attachments: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: ChatAttachmentId,
            name: Schema.String.check(Schema.isMaxLength(255)),
            type: Schema.Literals(["image", "file"]),
          }),
        ).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
      ),
    }),
  ).check(Schema.isMaxLength(40)),
});

export const GrokBotVoiceSession = Schema.Struct({
  chatContext: Schema.optionalKey(GrokBotVoiceChatContext),
  instructions: Schema.String,
  tools: Schema.Array(GrokBotVoiceToolDescriptor),
  hasOverheard: Schema.Boolean,
  greeting: Schema.Struct({ direction: Schema.String, withLandedWork: Schema.String }),
  /**
   * Native's receipt turn: `output` is the tool result sent while earlier work is still under way,
   * `instructions` is what the model speaks once a receipt is owed. Absent when native sends none.
   */
  receipt: Schema.optionalKey(
    Schema.Struct({ output: Schema.String, instructions: Schema.String }),
  ),
});

export const GrokBotVoiceStartInput = Schema.Struct({
  /** The bot's display name is read from the account's own roster; the caller cannot supply it. */
  botId: GrokBotId,
  userName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  spokenLanguage: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
});
/** `callId` identifies this call to T3; it is not the realtime conversation id. */
export const GrokBotVoiceStartResult = Schema.Struct({
  callId: CallId,
  credential: GrokBotVoiceCredential,
  session: GrokBotVoiceSession,
});

/** The desktop harness's "line" flags, sent with every tool call so the broker can pace replies. */
export const GrokBotVoiceLineState = Schema.Struct({
  theyJustTalked: Schema.Boolean,
  newsOwed: Schema.Boolean,
  receiptOwed: Schema.Boolean,
  alreadySpokeThisTurn: Schema.Boolean,
});
export const GrokBotVoiceToolInput = Schema.Struct({
  callId: CallId,
  toolCallId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  input: Schema.Unknown,
  line: GrokBotVoiceLineState,
});
export const GrokBotVoiceToolResult = Schema.Struct({
  chatContext: Schema.optionalKey(GrokBotVoiceChatContext),
  kind: Schema.Literals(["served", "unknown_tool", "invalid_input"]),
  output: Schema.Unknown,
  /** Client-owned completion wait, separate from the model's immediate function result. */
  completion: Schema.optionalKey(
    Schema.Struct({
      requestToolCallId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      pending: Schema.Boolean,
    }),
  ),
});

/** Mints a replacement credential for the same call; the original is good for one handshake. */
export const GrokBotVoiceRefreshInput = Schema.Struct({ callId: CallId });
/** One spoken turn of the call, as the desktop's call store records it. Held only until hang-up. */
export const GrokBotVoiceTurn = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  speaker: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(16_000)),
  atMs: Schema.Number,
});
/**
 * Sent once the client's realtime session acknowledges it is live. The server then puts the bot on
 * the line and dates the call from this moment, not from credential setup.
 */
export const GrokBotVoiceConnectedInput = Schema.Struct({ callId: CallId });
/** `first` is true only for the notification that marked the call connected. */
export const GrokBotVoiceConnectedResult = Schema.Struct({ first: Schema.Boolean });
/** How the desktop labels a finished call; `disconnected` is a remote close, `failed` a dropped reconnect. */
export const GrokBotVoiceEnding = Schema.Literals(["hung-up", "disconnected", "failed"]);
/**
 * Ends a call. `ending` is present only when the call connected: that is what makes the server
 * record it natively (the call's history entry and summary). A call that never connected is
 * forgotten without a record, as on the desktop.
 */
export const GrokBotVoiceEndInput = Schema.Struct({
  callId: CallId,
  ending: Schema.optionalKey(GrokBotVoiceEnding),
  realtimeConversationId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  turns: Schema.optionalKey(Schema.Array(GrokBotVoiceTurn).check(Schema.isMaxLength(1_000))),
});
/** `recorded` is true only when native accepted the call record. */
export const GrokBotVoiceEndResult = Schema.Struct({
  ended: Schema.Boolean,
  recorded: Schema.Boolean,
});

export class GrokBotVoiceError extends Schema.TaggedError<GrokBotVoiceError>()(
  "GrokBotVoiceError",
  {
    reason: Schema.Literals([
      "account_unavailable",
      "refused",
      "undialable_endpoint",
      "expired_credential",
      "unknown_call",
      "unavailable",
    ]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "account_unavailable":
        return "Connect a Grok Bot account to start a voice call.";
      case "refused":
        return "Grok Bot declined the voice call.";
      case "undialable_endpoint":
        return "Grok Bot returned a voice endpoint that is not allowed.";
      case "expired_credential":
        return "The voice call credential expired. Start the call again.";
      case "unknown_call":
        return "This voice call is no longer active.";
      default:
        return "The voice call could not be started. Try again.";
    }
  }
}
