import { ProviderDriverKind } from "@t3tools/contracts";
import type {
  NodeId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
  MessageId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import type { GrokBotManagedCompletion } from "../../grokBot/GrokBotManagedStateStore.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  GrokBotBindingError,
  type GrokBotBoundSession,
  type GrokBotManagedTurn,
} from "./GrokBotManagedBinding.ts";
const GROK_BOT_DRIVER_KIND = ProviderDriverKind.make("grok-bot");

/** Durable correlation contains no prompt, account token, or MCP bearer. */
export interface GrokBotTurnIdentity {
  readonly native: GrokBotBoundSession;
  /** App-owned user message that initiated this native turn; absent on pre-reaction records. */
  readonly userMessageId?: MessageId;
  readonly messageId: string;
  readonly sentAtMs: number;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly runOrdinal: number;
  readonly providerTurnOrdinal: number;
  readonly managedSkill?: NonNullable<GrokBotManagedTurn["managedSkill"]>;
}

export interface GrokBotSettlement {
  readonly _tag: "Settlement";
  readonly clientNonce: string;
  readonly outcome: "success" | "error" | "cancelled";
  readonly settledAtMs: number;
  readonly errorCode?: string;
  readonly errorDomain?: string;
  readonly errorRetryable?: boolean | null;
}
const Settlement = Schema.TaggedStruct("Settlement", {
  clientNonce: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  outcome: Schema.Literals(["success", "error", "cancelled"]),
  settledAtMs: Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(8640000000000000),
  ),
  errorCode: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  errorDomain: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  errorRetryable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
const decodeSettlement = Schema.decodeEffect(Settlement);

/** Recovery codes come from the host's own watchdog, so their wording is not the bot's claim. */
function failureMessage(code: string | undefined) {
  switch (code) {
    case "native_idle_without_completion":
      return "The Grok Bot stopped working without finishing this T3 turn.";
    case "completion_inactivity_timeout":
      return "The Grok Bot showed no activity and never finished this T3 turn.";
    default:
      return "The native Grok Bot turn failed.";
  }
}

export function grokBotTurnIdentity(turn: GrokBotManagedTurn): GrokBotTurnIdentity {
  return {
    ...(turn.managedSkill === undefined ? {} : { managedSkill: turn.managedSkill }),
    native: turn.native,
    userMessageId: turn.input.message.messageId,
    messageId: turn.messageId,
    sentAtMs: turn.sentAtMs,
    runId: turn.input.runId,
    attemptId: turn.input.attemptId,
    rootNodeId: turn.input.rootNodeId,
    providerThreadId: turn.input.providerThread.id,
    providerTurnId: turn.providerTurnId,
    runOrdinal: turn.input.runOrdinal,
    providerTurnOrdinal: turn.input.providerTurnOrdinal,
  };
}

/** Shared by live adapter projection and the terminal commit's last-chance durable answer read. */
export function grokBotCompletionMessage(declaration: GrokBotManagedCompletion) {
  const at = DateTime.makeUnsafe(declaration.declaredAtMs);
  return {
    type: "message.updated",
    driver: GROK_BOT_DRIVER_KIND,
    message: {
      id: derive.messageFromProviderItem({
        driver: GROK_BOT_DRIVER_KIND,
        nativeItemId: `t3-managed-completion/${declaration.identity.providerTurnId}`,
      }),
      threadId: declaration.identity.native.threadId,
      runId: declaration.identity.runId,
      nodeId: declaration.identity.rootNodeId,
      role: "assistant",
      createdBy: "agent",
      creationSource: "provider",
      text: declaration.finalText,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  } satisfies ProviderAdapterV2Event;
}

/** Chat renders turn items; their persisted positions are allocated by the event sink. */
export function grokBotMessageTurnItem(
  message: OrchestrationV2ConversationMessage,
  input: {
    readonly native: GrokBotBoundSession;
    readonly turn?: GrokBotTurnIdentity;
    readonly nativeItemId?: string;
  },
) {
  const base = {
    id: derive.turnItemFromProviderItem({ driver: GROK_BOT_DRIVER_KIND, nativeItemId: message.id }),
    threadId: message.threadId,
    runId: message.runId,
    nodeId: message.nodeId,
    providerThreadId:
      input.turn?.providerThreadId ??
      derive.providerThread({
        driver: GROK_BOT_DRIVER_KIND,
        providerInstanceId: input.native.providerInstanceId,
        nativeThreadId: [input.native.binding, input.native.botId, input.native.sessionId]
          .map(encodeURIComponent)
          .join("/"),
      }),
    providerTurnId: input.turn?.providerTurnId ?? null,
    nativeItemRef:
      input.nativeItemId === undefined
        ? null
        : {
            driver: GROK_BOT_DRIVER_KIND,
            nativeId: input.nativeItemId,
            strength: "strong" as const,
          },
    parentItemId: null,
    ordinal: 0,
    status: message.streaming ? ("running" as const) : ("completed" as const),
    title: null,
    startedAt: message.createdAt,
    completedAt: message.streaming ? null : message.updatedAt,
    updatedAt: message.updatedAt,
    messageId: message.id,
    text: message.text,
    attachments: message.attachments,
    ...(message.grokBotPeer === undefined ? {} : { grokBotPeer: message.grokBotPeer }),
    ...(message.grokBotAuthor === undefined ? {} : { grokBotAuthor: message.grokBotAuthor }),
    ...(message.grokBotReactions === undefined
      ? {}
      : { grokBotReactions: message.grokBotReactions }),
    ...(message.grokBotWorkflowReferences === undefined
      ? {}
      : { grokBotWorkflowReferences: message.grokBotWorkflowReferences }),
    ...(message.grokBotVoiceCall === undefined
      ? {}
      : { grokBotVoiceCall: message.grokBotVoiceCall }),
    ...(message.grokBotVoiceCallId === undefined
      ? {}
      : { grokBotVoiceCallId: message.grokBotVoiceCallId }),
    ...(message.grokBotConnectorCard === undefined
      ? {}
      : { grokBotConnectorCard: message.grokBotConnectorCard }),
  };
  const turnItem: OrchestrationV2TurnItem =
    message.role === "user"
      ? {
          ...base,
          type: "user_message",
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          inputIntent: "turn_start",
        }
      : { ...base, type: "assistant_message", streaming: message.streaming };
  return {
    type: "turn_item.updated",
    driver: GROK_BOT_DRIVER_KIND,
    turnItem,
  } satisfies ProviderAdapterV2Event;
}

export function grokBotCompletionTurnItem(declaration: GrokBotManagedCompletion) {
  return grokBotMessageTurnItem(grokBotCompletionMessage(declaration).message, {
    native: declaration.identity.native,
    turn: declaration.identity,
  });
}

/** Called only with settlement frames from the account-bound, exact-bot gateway stream. */
export const makeGrokBotSettlementProjection = (
  native: GrokBotBoundSession,
  lookupCompletion: (
    identity: GrokBotTurnIdentity,
  ) => Effect.Effect<GrokBotManagedCompletion | undefined, GrokBotBindingError> = () =>
    Effect.sync(() => undefined),
) => {
  const turns = new Map<string, GrokBotTurnIdentity>();
  const settled = new Set<string>();
  const register = Effect.fnUntraced(function* (turn: GrokBotTurnIdentity) {
    if (
      turn.native.binding !== native.binding ||
      turn.native.botId !== native.botId ||
      turn.native.sessionId !== native.sessionId ||
      turn.native.threadId !== native.threadId ||
      turn.native.providerInstanceId !== native.providerInstanceId
    )
      return yield* new GrokBotBindingError({
        reason: "Turn correlation belongs to another native binding.",
      });
    const previous = turns.get(turn.messageId);
    if (
      previous !== undefined &&
      (previous.runId !== turn.runId ||
        previous.attemptId !== turn.attemptId ||
        previous.rootNodeId !== turn.rootNodeId)
    )
      return yield* new GrokBotBindingError({
        reason: "The native nonce was already assigned to another run.",
      });
    turns.set(turn.messageId, turn);
    return previous === undefined;
  });
  const assertCompletion = Effect.fnUntraced(function* (
    turn: GrokBotTurnIdentity,
    declaration: GrokBotManagedCompletion,
  ) {
    const identity = declaration.identity;
    if (
      turn.messageId !== identity.messageId ||
      turn.sentAtMs !== identity.sentAtMs ||
      turn.runOrdinal !== identity.runOrdinal ||
      turn.providerTurnOrdinal !== identity.providerTurnOrdinal ||
      turn.runId !== identity.runId ||
      turn.attemptId !== identity.attemptId ||
      turn.rootNodeId !== identity.rootNodeId ||
      turn.providerTurnId !== identity.providerTurnId ||
      turn.providerThreadId !== identity.providerThreadId ||
      identity.native.binding !== native.binding ||
      identity.native.botId !== native.botId ||
      identity.native.sessionId !== native.sessionId ||
      identity.native.threadId !== native.threadId ||
      identity.native.providerInstanceId !== native.providerInstanceId
    )
      return yield* new GrokBotBindingError({
        reason: "Completion declaration belongs to another turn.",
      });
  });
  const terminalEvents = (
    turn: GrokBotTurnIdentity,
    status: "completed" | "failed" | "cancelled",
    completedAt: DateTime.Utc,
    error?: Pick<GrokBotSettlement, "errorCode" | "errorRetryable">,
  ): ProviderAdapterV2Event[] => {
    const events: ProviderAdapterV2Event[] = [
      {
        type: "provider_turn.updated",
        driver: GROK_BOT_DRIVER_KIND,
        threadId: native.threadId,
        providerTurn: {
          id: turn.providerTurnId,
          providerThreadId: turn.providerThreadId,
          nodeId: turn.rootNodeId,
          runAttemptId: turn.attemptId,
          // clientNonce is an exact delivery correlation, not a native execution turn id.
          nativeTurnRef: null,
          ordinal: turn.providerTurnOrdinal,
          status,
          startedAt: null,
          completedAt,
        },
      },
    ];
    if (status === "failed") {
      events.push({
        type: "turn.terminal",
        driver: GROK_BOT_DRIVER_KIND,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.providerTurnId,
        runOrdinal: turn.runOrdinal,
        failureItemOrdinal: 1,
        status,
        failure: {
          class: "provider_error",
          message: failureMessage(error?.errorCode),
          code: error?.errorCode?.trim() || null,
          retryable: error?.errorRetryable ?? null,
        },
        threadDisposition: "reusable",
      });
    } else {
      events.push({
        type: "turn.terminal",
        driver: GROK_BOT_DRIVER_KIND,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.providerTurnId,
        runOrdinal: turn.runOrdinal,
        status,
        failure: null,
        threadDisposition: "reusable",
      });
    }
    settled.add(turn.messageId);
    return events;
  };
  const project = Effect.fnUntraced(function* (input: GrokBotSettlement) {
    const frame = yield* decodeSettlement(input).pipe(
      Effect.mapError(
        () => new GrokBotBindingError({ reason: "Native settlement data is invalid." }),
      ),
    );
    const turn = turns.get(frame.clientNonce);
    if (turn === undefined || settled.has(frame.clientNonce)) return [];
    const declaration = yield* lookupCompletion(turn);
    // Completion projection may have won while the immutable row was being read.
    if (settled.has(frame.clientNonce)) return [];
    if (declaration !== undefined) yield* assertCompletion(turn, declaration);
    const finalMessage =
      declaration === undefined
        ? []
        : [grokBotCompletionMessage(declaration), grokBotCompletionTurnItem(declaration)];
    return [
      ...finalMessage,
      ...terminalEvents(
        turn,
        frame.outcome === "success"
          ? "completed"
          : frame.outcome === "cancelled"
            ? "cancelled"
            : "failed",
        DateTime.makeUnsafe(frame.settledAtMs),
        frame,
      ),
    ];
  });
  const projectCompletion = Effect.fnUntraced(function* (
    declaration: GrokBotManagedCompletion,
    replay = false,
  ) {
    const identity = declaration.identity;
    const turn = turns.get(identity.messageId);
    if (turn === undefined || (!replay && settled.has(identity.messageId))) return [];
    yield* assertCompletion(turn, declaration);
    const at = DateTime.makeUnsafe(declaration.declaredAtMs);
    const finalMessage = grokBotCompletionMessage(declaration);
    // This is the agent's declared T3 completion, not a synthetic native settlement frame.
    return [
      finalMessage,
      grokBotCompletionTurnItem(declaration),
      ...terminalEvents(turn, "completed", at),
    ];
  });
  /**
   * Settles a turn the bot never completed. An accepted declaration always wins and completes the turn,
   * so a late answer is published once whether it lands before or after the watchdog's verdict.
   */
  const recover = Effect.fnUntraced(function* (input: {
    readonly identity: GrokBotTurnIdentity;
    readonly outcome: "success" | "error";
    readonly code?: string;
    readonly settledAtMs: number;
  }) {
    const turn = turns.get(input.identity.messageId);
    if (turn === undefined || settled.has(turn.messageId)) return [];
    const declaration = yield* lookupCompletion(turn);
    if (settled.has(turn.messageId)) return [];
    if (declaration !== undefined) return yield* projectCompletion(declaration);
    return yield* project({
      _tag: "Settlement",
      clientNonce: turn.messageId,
      outcome: input.outcome,
      settledAtMs: input.settledAtMs,
      ...(input.code === undefined ? {} : { errorCode: input.code }),
      errorRetryable: true,
    });
  });
  const isSettled = (messageId: string) => settled.has(messageId);
  return { register, project, projectCompletion, recover, isSettled };
};
