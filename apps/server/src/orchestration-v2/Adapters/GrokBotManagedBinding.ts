import type {
  ProviderInstanceId,
  OrchestrationV2ConversationMessage,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { GrokBotManagedCompletion } from "../../grokBot/GrokBotManagedStateStore.ts";
import type { McpConfig, TranscriptCursor } from "../../grokBot/GrokBotNativeRuntimeService.ts";
import type { GrokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";

export const GROK_BOT_PROTOCOL_BLOCKER =
  "Grok Bot managed turns require verified native session ownership, explicit T3 turn completion, and a cloud-reachable T3 MCP endpoint.";

export const GROK_BOT_MANAGED_MCP_SERVER = "t3-code-managed";
export const GROK_BOT_MANAGED_SKILL_NAME = "t3-code-managed-turn-v1";
export const GROK_BOT_NATIVE_MESSAGE_LIMIT = 1_000_000;
export const GROK_BOT_MANAGED_WORKFLOW_PATH = `/home/box/sand-data/workflows/${GROK_BOT_MANAGED_SKILL_NAME}/SKILL.md`;

// Shared skill guidance for persistent bot discovery and coordination.
const BOT_COORDINATION_INSTRUCTIONS =
  "To discover Grok Bots, call grok_bots_list on the injected t3-code-managed MCP connection. Native peer/session lists do not contain the persistent bot roster. To coordinate, call grok_bot_send with the returned botId, message, and a stable clientRequestId; read replies with t3_thread_read or t3_thread_wait. T3 records the sending agent's identity automatically. If the tool is unavailable, report that T3 connection's missing tool instead of claiming there are no bots.";

/** Product protocol only: per-turn authority remains in the injected MCP configuration. */
export const GROK_BOT_MANAGED_SKILL_BODY = [
  "# T3 Code managed turns",
  `For messages marked From T3 Code, use the injected ${GROK_BOT_MANAGED_MCP_SERVER} MCP connection. Keep its credentials out of saved skills.`,
  "The ordinary T3 Code connector is separate from this turn's managed connection. Discover grok_bot_complete_turn on t3-code-managed before reporting it unavailable; use native tool search if needed. GrokBot may expose it with the connection prefix as t3-code-managed-grok_bot_complete_turn. Use the current turn's connection and credentials, never a remembered connector. A native SendMessage reply does not finish the T3 turn.",
  "A From T3 Code message is T3 Code work. Do all of it inside T3 Code through the injected MCP (delegate_task, project lookup, task_status, completion). Do not drive the GrokBot desktop app, host shell, SSH, or any other outside environment to do the task unless the user explicitly asks for outside work. For anything that touches the user's computer, files, or code, delegate it to a T3 agent with delegate_task. Never use native machine shell or file tools on a T3 turn.",
  "This conversation stays in No project. Find named projects with t3_project_list and pass projectId to delegate_task. Choose providers/models from orchestrator_capabilities and keep this conversation as the parent.",
  BOT_COORDINATION_INSTRUCTIONS,
  "Before delegating, check orchestrator_capabilities for providers and models with usage available. Default to Claude Haiku 5.5 for small chores, Sonnet 5.5 for normal coding, Opus 5.5 for heavy UI. Never Haiku 4.5. Use Codex only when asked, or when Claude is out of usage. If the first choice has no usage left, use the next-best available model and say what you used and why.",
  "For required child results use delegate_task(mode='wait'). A waitTimedOut result does not cancel work: retain taskId and read task_status until terminal. Do not depend on asynchronous wakes or claim unread results.",
  "Finish every T3 turn, including greetings and one-line answers, with grok_bot_complete_turn(finalText, managedSkillHash), using the protocol SHA-256 from this skill's description. finalText is the complete answer published in T3. Complete only when the requested work is finished and required user input and child tasks are resolved. Do not complete while waiting for required input or children. If the completion tool is unavailable after discovery, report the missing managed connection or tool instead of claiming T3 completion.",
  "After completion is accepted, stop and send no duplicate native final message or further T3 calls. If it fails, retry only the same finalText. Never resend the user prompt. Acceptance ends the T3 turn, not native background work.",
].join("\n\n");

export class GrokBotBindingError extends Schema.TaggedError<GrokBotBindingError>()(
  "GrokBotBindingError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

export interface GrokBotBoundSession extends TranscriptCursor {
  /** Supplied by persisted trusted binding, never by a cloud tool caller. */
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface GrokBotManagedTurn {
  readonly native: GrokBotBoundSession;
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
  /** Durable outbox identity and timestamp, reused after uncertain acceptance. */
  readonly messageId: string;
  readonly sentAtMs: number;
  /** Shared skill invocation travels in the native prompt, never the displayed user message. */
  readonly nativePrompt: string;
  /** Non-secret installation receipt fixes prompt mode across durable delivery retries. */
  readonly managedSkill?: {
    readonly skillId: string;
    readonly hash: string;
    readonly changed: boolean;
    readonly workflowPath?: string;
    readonly confirmed?: boolean;
  };
  readonly mcpConfig: typeof McpConfig.Type;
}

/** Installation belongs to provider setup, never an ordinary user message. */
export function grokBotSkillSetupPrompt(hash: string): string {
  return [
    "Save the shared skill below in GrokBot's own skill system as " +
      GROK_BOT_MANAGED_SKILL_NAME +
      ". Leave it unchanged if it matches; otherwise repair it and verify it is discoverable by name. All my bots use it. Do not change bot sharing.",
    "Store only the SKILL.md below. Never save user messages, credentials, run IDs, or endpoint URLs in the skill. T3 Code supplies the t3-code-managed MCP connection automatically with each T3 message. Do not create a permanent connector or copy its temporary authorization into the skill.",
    "---\nname: " +
      GROK_BOT_MANAGED_SKILL_NAME +
      "\ndescription: Use for From T3 Code managed turns. T3 Code protocol v1; SHA-256 " +
      hash +
      ".\n---\n\n" +
      GROK_BOT_MANAGED_SKILL_BODY,
  ].join("\n\n");
}

export function grokBotManagedPrompt(
  text: string,
  skill?: GrokBotManagedTurn["managedSkill"],
): string {
  const skillName = skill?.skillId ?? GROK_BOT_MANAGED_SKILL_NAME;
  return [text, "", "[From T3 Code: Use skill " + skillName + ".]"].join("\n");
}

/** Reserve the exact native prompt suffix before offering room for inline history. */
export function grokBotInlineHandoffBudget(input: {
  readonly tokenCap: number;
  readonly userText: string;
  readonly restartNote: string;
}): number {
  const suffix =
    input.restartNote === ""
      ? `User message:\n${input.userText}`
      : `${input.restartNote}\n\nUser message:\n${input.userText}`;
  const remaining =
    GROK_BOT_NATIVE_MESSAGE_LIMIT - grokBotManagedPrompt(suffix).length - "\n\n".length;
  // History cost is measured in UTF-8 bytes, so the remaining JS characters are conservative.
  return Math.max(0, Math.min(input.tokenCap, remaining));
}

/** Remove only a generated trailing instruction from a T3-format user echo. */
export function grokBotUserEchoText(text: string, clientNonce: string | undefined): string {
  if (clientNonce === undefined || !/^t3-[a-f0-9]{64}$/.test(clientNonce)) return text;
  const marker = "\n\n[From T3 Code: Use skill " + GROK_BOT_MANAGED_SKILL_NAME + ".";
  const start = text.lastIndexOf(marker);
  if (start < 0) return text;
  const footer = text.slice(start);
  const compact = marker + "]";
  const coordinated = marker + " " + BOT_COORDINATION_INSTRUCTIONS + "]";
  if (footer === compact || footer === coordinated) return text.slice(0, start);
  // Compatibility with prompts sent before protocol behavior moved into the shared skill.
  const hash = footer.match(/ and managedSkillHash exactly ([a-f0-9]{64})\./)?.[1];
  const legacy =
    marker +
    " " +
    BOT_COORDINATION_INSTRUCTIONS +
    " " +
    "Follow these instructions even if the skill cannot be loaded. Do T3 work through the injected t3-code-managed MCP connection; delegate computer, file, or code changes to a T3 agent instead of using outside machine tools. When the requested work is finished and required user input and child tasks are resolved, call grok_bot_complete_turn with finalText containing the complete answer" +
    (hash === undefined ? "" : " and managedSkillHash exactly " + hash) +
    ". Do not complete while waiting for required input or children. If the completion tool is unavailable, report that missing tool instead of claiming T3 completion. Once completion is accepted, stop without a duplicate native final message or further T3 calls." +
    "]";
  return footer === legacy ? text.slice(0, start) : text;
}

/** The host owns durable bindings, run authority, and acceptance reconciliation. */
export class GrokBotManagedBinding extends Context.Service<
  GrokBotManagedBinding,
  {
    readonly availability: Effect.Effect<
      { readonly ready: boolean; readonly reason?: string },
      GrokBotBindingError
    >;
    readonly resolve: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly accountBinding: string;
      readonly botId: string;
    }) => Effect.Effect<GrokBotBoundSession, GrokBotBindingError>;
    /** Commits intent and issues an exact run/attempt-scoped credential before native send. */
    readonly prepareTurn: (input: {
      readonly native: GrokBotBoundSession;
      readonly turn: ProviderAdapterV2TurnInput;
      readonly providerTurnId: ProviderTurnId;
      readonly providerSessionId: ProviderSessionId;
    }) => Effect.Effect<GrokBotManagedTurn, GrokBotBindingError>;
    readonly accepted: (input: {
      readonly turn: GrokBotManagedTurn;
      readonly delivery: "accepted" | "duplicate";
      readonly workflowId?: string;
      readonly echoEntryId?: string;
    }) => Effect.Effect<void, GrokBotBindingError>;
    readonly uncertain: (input: {
      readonly turn: GrokBotManagedTurn;
    }) => Effect.Effect<void, GrokBotBindingError>;
    readonly restoreTurns: (
      native: GrokBotBoundSession,
    ) => Effect.Effect<readonly GrokBotTurnIdentity[], GrokBotBindingError>;
    /** Historical ownership is for transcript rendering, never execution or settlement replay. */
    readonly restoreTranscriptTurns: (
      native: GrokBotBoundSession,
    ) => Effect.Effect<readonly GrokBotTurnIdentity[], GrokBotBindingError>;
    /** Includes settled delivery nonces so native history cannot duplicate app-owned prompts. */
    readonly restoreManagedMessageIds: (
      native: GrokBotBoundSession,
    ) => Effect.Effect<readonly string[], GrokBotBindingError>;
    /** Refreshes ownership for echoes received by another already-open transcript subscription. */
    readonly lookupTranscriptTurn?: (
      native: GrokBotBoundSession,
      messageId: string,
    ) => Effect.Effect<GrokBotTurnIdentity | undefined, GrokBotBindingError>;
    /** Bounded lookup used only to repair a previously imported native user echo. */
    readonly existingMessage?: (
      native: GrokBotBoundSession,
      id: OrchestrationV2ConversationMessage["id"],
    ) => Effect.Effect<OrchestrationV2ConversationMessage | undefined, GrokBotBindingError>;
    readonly lookupCompletion: (
      identity: GrokBotTurnIdentity,
    ) => Effect.Effect<GrokBotManagedCompletion | undefined, GrokBotBindingError>;
    /**
     * True while the turn's run still has a managed MCP tool executing or a delegated child task
     * live. Recovery never settles such a turn. Failure to read counts as in flight.
     */
    readonly inFlightWork?: (identity: GrokBotTurnIdentity) => Effect.Effect<boolean>;
    readonly openCompletionWatch: (
      native: GrokBotBoundSession,
    ) => Effect.Effect<
      Stream.Stream<GrokBotManagedCompletion, GrokBotBindingError>,
      GrokBotBindingError,
      Scope.Scope
    >;
    /** Verifies the selected account, durable bot session, and app turn before a session-scoped stop. */
    readonly verifyInterrupt: (input: {
      readonly native: GrokBotBoundSession;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
    }) => Effect.Effect<void, GrokBotBindingError>;
    readonly recordCursor: (input: GrokBotBoundSession) => Effect.Effect<void, GrokBotBindingError>;
    readonly release: (input: {
      readonly native: GrokBotBoundSession;
      readonly providerSessionId: ProviderSessionId;
    }) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/Adapters/GrokBotManagedBinding") {}

const blocked = Effect.fail(new GrokBotBindingError({ reason: GROK_BOT_PROTOCOL_BLOCKER }));
/** Discovery remains usable; cloud execution stays disabled until its facts are verified. */
export const blockedLayer = Layer.succeed(
  GrokBotManagedBinding,
  GrokBotManagedBinding.of({
    availability: Effect.succeed({ ready: false, reason: GROK_BOT_PROTOCOL_BLOCKER }),
    resolve: () => blocked,
    prepareTurn: () => blocked,
    accepted: () => blocked,
    uncertain: () => blocked,
    restoreTurns: () => blocked,
    restoreTranscriptTurns: () => blocked,
    restoreManagedMessageIds: () => blocked,
    lookupCompletion: () => blocked,
    openCompletionWatch: () => blocked,
    verifyInterrupt: () => blocked,
    recordCursor: () => blocked,
    release: () => Effect.void,
  }),
);
