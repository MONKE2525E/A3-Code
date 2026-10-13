import * as Schema from "effect/Schema";
import { PullRequestRef } from "./pullRequest.ts";
import { TrimmedNonEmptyString, ThreadId, MessageId, RunId } from "./baseSchemas.ts";

export const GrokBotId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const GrokBotPullRequest = Schema.Struct({
  reference: PullRequestRef,
  url: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
});
export const GrokBotRuntimeActivity = Schema.Struct({
  source: Schema.Literals(["native", "transcript"]),
  observedAtMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  staleAtMs: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  isRunning: Schema.optionalKey(Schema.Boolean),
  isComposingMessage: Schema.optionalKey(Schema.Boolean),
  awaitingUserResponse: Schema.NullOr(
    Schema.Struct({
      reason: Schema.String.check(Schema.isMaxLength(128)),
      sinceMs: Schema.optionalKey(
        Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
      ),
    }),
  ),
  currentActivity: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literals(["thinking", "tool"]),
      tool: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
      hasDetail: Schema.Boolean,
      target: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
    }),
  ),
});
export const GrokBot = Schema.Struct({
  id: GrokBotId,
  /** Native group agent metadata; omitted by older servers. */
  isGroup: Schema.optionalKey(Schema.Boolean),
  memberIds: Schema.optionalKey(Schema.Array(GrokBotId)),
  name: Schema.String,
  label: Schema.String,
  description: Schema.String,
  avatarShape: Schema.String,
  avatarColor: Schema.String,
  notificationEnabled: Schema.Boolean,
  hidden: Schema.Boolean,
  pinned: Schema.Boolean,
  featured: Schema.Boolean,
  pullRequests: Schema.Array(GrokBotPullRequest),
  runtimeActivity: Schema.optionalKey(GrokBotRuntimeActivity),
});
export type GrokBot = typeof GrokBot.Type;

export const GrokBotStatus = Schema.Struct({
  installed: Schema.Boolean,
  managed: Schema.Boolean,
  sessionPresent: Schema.Boolean,
  /** The Grok Bot desktop sign-in can be read, so native features work without the CLI bridge. */
  nativeAvailable: Schema.optionalKey(Schema.Boolean),
});
export const GrokBotReadInput = Schema.Struct({ botId: GrokBotId });
export const GrokBotReaction = Schema.Struct({
  emoji: Schema.String,
  from: Schema.Literals(["bot", "user"]),
  messageId: Schema.String,
  id: Schema.optionalKey(Schema.String),
  timestampMs: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
});
export const GrokBotReactions = Schema.Array(GrokBotReaction);
/**
 * Another bot in a bot-to-bot exchange. `bot` is resolved on id against the roster, so its
 * name is the current one; `unknown` keeps the wire name when the id is not in the roster.
 */
export const GrokBotParticipant = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("bot"), id: Schema.String, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unknown"), label: Schema.String }),
]);
export const GrokBotMessageSender = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  GrokBotParticipant,
]);
/** Native transcript references are display metadata, never instructions to send another turn. */
export const GrokBotWorkflowReferences = Schema.Array(
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
    label: Schema.String.check(Schema.isMaxLength(1024)),
    teachQueueScope: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  }),
).check(Schema.isMaxLength(64));
export type GrokBotWorkflowReferences = typeof GrokBotWorkflowReferences.Type;

/**
 * A voice call that ended in this conversation, shown as a row in its place. Fields are only
 * what native recorded; a missing duration stays missing rather than being estimated.
 */
/** Native's call id; a summary links to its marker by `voice:<callId>` on its channel. */
export const GrokBotVoiceCallId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const GrokBotVoiceCallMarker = Schema.Struct({
  callId: GrokBotVoiceCallId,
  durationMs: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  ending: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type GrokBotVoiceCallMarker = typeof GrokBotVoiceCallMarker.Type;

export const GrokBotMessage = Schema.Struct({
  grokBotWorkflowReferences: Schema.optionalKey(GrokBotWorkflowReferences),
  /** Set on the row that stands for a voice call; its text is empty. */
  voiceCall: Schema.optionalKey(GrokBotVoiceCallMarker),
  id: Schema.String,
  /** Kept for older clients; `sender` is the authority on who wrote the message. */
  role: Schema.Literals(["user", "assistant"]),
  sender: GrokBotMessageSender,
  /** Set on bot-to-bot messages this bot sent to a peer. */
  addressee: Schema.optionalKey(GrokBotParticipant),
  text: Schema.String,
  timestampMs: Schema.Number,
  streaming: Schema.Boolean,
  reactions: Schema.optionalKey(GrokBotReactions),
  reactionOnly: Schema.optionalKey(Schema.Boolean),
});
export const GrokBotConversation = Schema.Struct({
  bot: GrokBot,
  messages: Schema.Array(GrokBotMessage),
  runtimeActivity: Schema.optionalKey(GrokBotRuntimeActivity),
});
export const GrokBotSendInput = Schema.Struct({
  botId: GrokBotId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(64000)),
  clientRequestId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
const AGENT_STAMP_PREFIX = "[message from another agent, ";
const AGENT_STAMP_END = "]\n\n";
/** The line that opens text a T3 agent sent to a bot. Bots read only text, so the sender is stated in it. */
export function grokBotAgentStamp(agentName: string): string {
  return `${AGENT_STAMP_PREFIX}${agentName}]`;
}
/** Removes the stamp line; user-typed text comes back unchanged with `fromAgent: false`. */
export function splitGrokBotAgentStamp(text: string): {
  readonly fromAgent: boolean;
  readonly text: string;
} {
  const end = text.startsWith(AGENT_STAMP_PREFIX) ? text.indexOf(AGENT_STAMP_END) : -1;
  return end === -1
    ? { fromAgent: false, text }
    : { fromAgent: true, text: text.slice(end + AGENT_STAMP_END.length) };
}
export const GrokBotSendResult = Schema.Struct({
  accepted: Schema.Boolean,
  threadId: Schema.optionalKey(ThreadId),
  messageId: Schema.optionalKey(MessageId),
  runId: Schema.optionalKey(RunId),
  delivery: Schema.optionalKey(Schema.Literals(["started", "queued"])),
});
export const GrokBotUpdateInput = Schema.Struct({
  botId: GrokBotId,
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16000))),
  avatarShape: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  avatarColor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  notificationEnabled: Schema.optionalKey(Schema.Boolean),
  hidden: Schema.optionalKey(Schema.Boolean),
  pinned: Schema.optionalKey(Schema.Boolean),
  featured: Schema.optionalKey(Schema.Boolean),
});
/** Members select native group creation through the same guarded create command. */
export const GrokBotCreateInput = Schema.Struct({
  memberIds: Schema.optionalKey(
    Schema.Array(GrokBotId).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  ),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16000))),
  avatarShape: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  avatarColor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
});
export const GrokBotLinkInput = Schema.Struct({
  botId: GrokBotId,
  reference: PullRequestRef,
  remove: Schema.optionalKey(Schema.Boolean),
});
/** Deletes the bot from the Grok Bot account, along with its linked T3 thread and T3-side preferences. */
export const GrokBotDeleteInput = Schema.Struct({ botId: GrokBotId });
export const GrokBotDeleteResult = Schema.Struct({ botId: GrokBotId });
export class GrokBotError extends Schema.TaggedError<GrokBotError>()("GrokBotError", {
  reason: Schema.Literals([
    "cli_unavailable",
    "signed_out",
    "gateway_failed",
    "invalid_response",
    "bot_not_found",
    "storage_failed",
    "delivery_unknown",
    "setup_failed",
    "pr_failed",
    "invalid_avatar",
    "native_unavailable",
    "profile_save_uncertain",
    "permission_denied",
    "delete_running",
    "delete_uncertain",
  ]),
  /** The CLI's own failure text, shown in place of the generic reason copy when present. */
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
}) {
  override get message(): string {
    if (this.detail !== undefined) return this.detail;
    switch (this.reason) {
      case "cli_unavailable":
        return "Set up the Grok Bot bridge in Settings → Grok Bots.";
      case "signed_out":
        return "Open Grok Bot and sign in, then refresh the connection.";
      case "bot_not_found":
        return "This bot is no longer in your Grok Bot account.";
      case "storage_failed":
        return "Grok Bot preferences could not be saved or loaded.";
      case "delivery_unknown":
        return "Message delivery is uncertain. Refresh the conversation before sending again.";
      case "setup_failed":
        return "The bridge could not be installed. Check that Node.js and npm are available.";
      case "invalid_avatar":
        return "Grok Bot does not support that shape or color. Pick another look.";
      case "native_unavailable":
        return "The Grok Bot desktop profile connection is unavailable. Open Grok Bot and refresh before saving again.";
      case "profile_save_uncertain":
        return "The Grok Bot profile save could not be confirmed. Refresh the bot before saving again.";
      case "delete_running":
        return "Stop this bot's current run before deleting it.";
      case "delete_uncertain":
        return "The bot deletion could not be confirmed. Refresh the bot list before trying again.";
      case "permission_denied":
        return "Your selected Grok Bot account cannot edit this bot. Check the account and team in Grok Bot.";
      case "pr_failed":
        return "The pull request could not be read. Check the selected project and source control sign-in.";
      case "invalid_response":
        return "The Grok Bot bridge returned an unsupported response.";
      default:
        return "Grok Bot could not be reached. Open the desktop app and refresh the connection.";
    }
  }
}
