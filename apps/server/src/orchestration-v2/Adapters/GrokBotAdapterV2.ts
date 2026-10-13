import {
  ProviderDriverKind,
  ProviderTurnId,
  type OrchestrationV2ConversationMessage,
  type ChatAttachment,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type { GrokBotProviderSettings } from "@t3tools/contracts/grokBotProvider";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderDriverCreateInput } from "@t3tools/provider-core/server/driver";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  grokBotConnectorCard,
  grokBotConnectorCardLabel,
} from "../../grokBot/GrokBotConnectorCard.ts";
import { grokBotWorkflowReferences } from "../../grokBot/GrokBotWorkflowReferences.ts";
import { grokBotMessagePeer } from "../../grokBot/GrokBotMessagePeer.ts";
import {
  grokBotVoiceCallIdFromChannel,
  grokBotVoiceCallMarker,
  isGrokBotVoiceCallInstruction,
} from "../../grokBot/GrokBotVoiceCall.ts";
import {
  GrokBotNativeRuntimeService,
  NativeRuntimeError,
  type RuntimeFrame,
  type SettlementFrame,
  type RuntimeError,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import {
  GrokBotManagedBinding,
  GrokBotBindingError,
  GROK_BOT_PROTOCOL_BLOCKER,
  grokBotUserEchoText,
  type GrokBotBoundSession,
} from "./GrokBotManagedBinding.ts";
import { makeGrokBotApprovalProjection } from "./GrokBotApprovalProjection.ts";
import { makeGrokBotManagedTurn } from "./GrokBotManagedTurn.ts";
import { GROK_BOT_WATCHDOG_INTERVAL_MS, makeGrokBotTurnWatchdog } from "./GrokBotTurnWatchdog.ts";
import {
  grokBotTurnIdentity,
  grokBotMessageTurnItem,
  makeGrokBotSettlementProjection,
  type GrokBotTurnIdentity,
} from "./GrokBotSettlementProjection.ts";

export const GROK_BOT_DRIVER_KIND = ProviderDriverKind.make("grok-bot");

export const GrokBotCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: false,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: false,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "weak",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "client-boundary" },
} satisfies OrchestrationV2ProviderCapabilities;

const NativeTextEntry = Schema.Struct({
  fromAgent: Schema.optionalKey(Schema.Unknown),
  toAgent: Schema.optionalKey(Schema.Unknown),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  kind: Schema.String,
  role: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.Unknown),
  suppressed: Schema.optionalKey(Schema.Unknown),
  /** The call record of a `voice-call` entry; decoded by `grokBotVoiceCallMarker`. */
  call: Schema.optionalKey(Schema.Unknown),
  clientNonce: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  richText: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(
    Schema.Struct({
      type: Schema.String,
      /** A voice call's summary names its call here, as `voice:<callId>`. */
      channel: Schema.optionalKey(Schema.Unknown),
      /** A connector card's host, native server id, and variant; decoded by `grokBotConnectorCard`. */
      connector: Schema.optionalKey(Schema.Unknown),
      serverId: Schema.optionalKey(Schema.Unknown),
      variant: Schema.optionalKey(Schema.Unknown),
      content: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
      file_name: Schema.optionalKey(Schema.String),
      images: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            url: Schema.String,
            alt: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
  isStreaming: Schema.optionalKey(Schema.Boolean),
  timestampMs: Schema.optionalKey(
    Schema.Number.check(
      Schema.isFinite(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(8640000000000000),
    ),
  ),
});
const decodeTextEntry = Schema.decodeUnknownOption(NativeTextEntry);

/** Stable identities are scoped to account, bot, native session, and transcript generation. */
export function grokBotNativeThreadId(native: GrokBotBoundSession): string {
  return [native.binding, native.botId, native.sessionId].map(encodeURIComponent).join("/");
}

export const makeGrokBotTranscriptProjection = (input: {
  readonly native: GrokBotBoundSession;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly lookupTranscriptTurn?: (
    messageId: string,
  ) => Effect.Effect<GrokBotTurnIdentity | undefined, GrokBotBindingError>;
  readonly importAttachments?: (
    entryId: string,
    attachments: readonly {
      readonly url: string;
      readonly name?: string;
      readonly image: boolean;
    }[],
  ) => Effect.Effect<readonly ChatAttachment[], GrokBotBindingError>;
  readonly existingMessage?: (
    id: OrchestrationV2ConversationMessage["id"],
  ) => Effect.Effect<OrchestrationV2ConversationMessage | undefined, GrokBotBindingError>;
  /** Native answer rows attributed to a managed turn; replayed history carries its own write time. */
  readonly onOwnedOutput?: (turn: GrokBotTurnIdentity, streaming: boolean, atMs: number) => void;
}) => {
  const messages = new Map<string, OrchestrationV2ConversationMessage>();
  const versions = new Map<string, bigint>();
  const managedMessageIds = new Set<string>();
  const turns = new Map<string, GrokBotTurnIdentity>();
  const requests = new Map<string, GrokBotTurnIdentity>();
  const messageRequests = new Map<string, string>();
  let generation = input.native.generation;
  let receivedRows = false;
  /** Set when native asked for a re-attach at the adopted generation; the watch loop consumes it. */
  let restartRequested = false;
  /** Voice user rows link a native requestId to their call; the summary is linked by that id alone. */
  const voiceRequests = new Map<string, string>();
  const voiceMarkerSeqs = new Map<string, bigint>();
  const registerManagedMessageId = (messageId: string) => {
    managedMessageIds.add(messageId);
  };
  const registerManagedTurn = (turn: GrokBotTurnIdentity) => {
    registerManagedMessageId(turn.messageId);
    turns.set(turn.messageId, turn);
  };
  const project = Effect.fnUntraced(function* (frame: RuntimeFrame) {
    const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
    if (frame._tag === "Cleared") {
      // A bootstrap cursor uses generation zero. Native clear then announces the replay generation.
      // Once rows or a durable generation exist, a different generation needs a snapshot with tombstones.
      if (!receivedRows && (generation === 0 || frame.generation === generation)) {
        generation = frame.generation;
        return events;
      }
      return yield* new GrokBotBindingError({
        reason: "The native transcript requires a verified snapshot resync.",
      });
    }
    if (frame._tag === "CursorTooOld") {
      // Before any row, or within the generation already imported, nothing durable is orphaned:
      // adopt the announced generation and re-attach. Replayed rows dedupe by version.
      if (!receivedRows || frame.generation === generation) {
        generation = frame.generation;
        restartRequested = true;
        return events;
      }
      return yield* new GrokBotBindingError({
        reason: "The native transcript requires a verified snapshot resync.",
      });
    }
    if (frame._tag !== "Rows") return events;
    if (frame.generation !== generation || frame.deletes.length > 0)
      return yield* new GrokBotBindingError({
        reason: "The native transcript changed its generation or deleted rows; resync is required.",
      });
    receivedRows = true;
    const now = yield* DateTime.now;
    const decodedRows: {
      row: (typeof frame.entries)[number];
      entry: typeof NativeTextEntry.Type;
    }[] = [];
    const newlyOwnedRequests = new Set<string>();
    // Voice linkage comes from the whole frame first, so a summary that precedes its voice rows
    // in the same batch, or a replay, links the same way.
    for (const row of frame.entries) {
      const probe = Option.getOrUndefined(decodeTextEntry(row.value));
      if (probe === undefined) continue;
      if (probe.kind === "voice-call") {
        const marker = grokBotVoiceCallMarker(probe.call);
        if (marker !== undefined && !voiceMarkerSeqs.has(marker.callId))
          voiceMarkerSeqs.set(marker.callId, BigInt(row.seq));
      } else if (
        probe.kind === "message" &&
        probe.role === "user" &&
        probe.requestId !== undefined &&
        !voiceRequests.has(probe.requestId)
      ) {
        const callId = grokBotVoiceCallIdFromChannel(probe.channel);
        if (callId !== undefined) voiceRequests.set(probe.requestId, callId);
      }
    }
    for (const row of frame.entries) {
      if (row.bodyOmitted || (row.blobHash && row.value === undefined))
        return yield* new GrokBotBindingError({
          reason: "A native transcript body is unavailable.",
        });
      const decoded = decodeTextEntry(row.value);
      if (Option.isNone(decoded)) continue;
      const entry = decoded.value;
      if (row.entryId !== undefined && row.entryId !== entry.id)
        return yield* new GrokBotBindingError({
          reason: "Native transcript row identity does not match its body.",
        });
      if (isGrokBotVoiceCallInstruction(entry)) continue;
      if (
        entry.kind === "message" &&
        entry.role === "user" &&
        entry.clientNonce !== undefined &&
        grokBotMessagePeer(input.native.botId, entry) === undefined &&
        !managedMessageIds.has(entry.clientNonce) &&
        input.lookupTranscriptTurn !== undefined
      ) {
        const restored = yield* input.lookupTranscriptTurn(entry.clientNonce);
        if (restored !== undefined) registerManagedTurn(restored);
      }
      decodedRows.push({ row, entry });
      // The owned user echo proves request ownership, even when replies precede it in a frame.
      const turn = entry.clientNonce === undefined ? undefined : turns.get(entry.clientNonce);
      if (
        entry.kind === "message" &&
        entry.role === "user" &&
        grokBotMessagePeer(input.native.botId, entry) === undefined &&
        turn !== undefined &&
        entry.requestId
      ) {
        const previous = requests.get(entry.requestId);
        if (previous !== undefined && previous.messageId !== turn.messageId)
          return yield* new GrokBotBindingError({
            reason: "A native request belongs to another managed turn.",
          });
        requests.set(entry.requestId, turn);
        if (previous === undefined) newlyOwnedRequests.add(entry.requestId);
      }
    }
    for (const { row, entry } of decodedRows) {
      const nativeItemId = `${grokBotNativeThreadId(input.native)}/${generation}/${row.seq}/${entry.id}`;
      const messageId = input.idAllocator.derive.messageFromProviderItem({
        driver: GROK_BOT_DRIVER_KIND,
        nativeItemId,
      });
      // Native rows can omit their timestamp. Preserve the first import time
      // across reconnects so old replies cannot move into the newest run.
      const persisted =
        messages.has(`${generation}/${row.seq}/${entry.id}`) || input.existingMessage === undefined
          ? undefined
          : yield* input.existingMessage(messageId);
      if (
        entry.kind === "message" &&
        entry.role === "user" &&
        grokBotMessagePeer(input.native.botId, entry) === undefined &&
        entry.clientNonce !== undefined &&
        managedMessageIds.has(entry.clientNonce) &&
        // A previously imported echo may predate durable ownership. Repair that exact existing
        // provider bubble through normal events while still suppressing all new owned echoes.
        !(
          persisted?.threadId === input.native.threadId &&
          persisted.role === "user" &&
          persisted.creationSource === "provider" &&
          grokBotUserEchoText(persisted.text, entry.clientNonce) !== persisted.text
        )
      )
        continue;
      // A voice-call row is a marker, not text: native's summary arrives as its own message.
      const voiceCall =
        entry.kind === "voice-call" ? grokBotVoiceCallMarker(entry.call) : undefined;
      if (entry.kind === "voice-call" && voiceCall === undefined) continue;
      const connectorCard =
        entry.kind === "send-message" ? grokBotConnectorCard(entry.message) : undefined;
      const text =
        entry.kind === "voice-call"
          ? ""
          : connectorCard !== undefined
            ? grokBotConnectorCardLabel(connectorCard)
            : entry.kind === "send-message" && entry.message?.type === "text"
              ? entry.message.content
              : entry.kind === "message"
                ? entry.role === "user" &&
                  grokBotMessagePeer(input.native.botId, entry) === undefined
                  ? entry.content === undefined
                    ? undefined
                    : grokBotUserEchoText(entry.content, entry.clientNonce)
                  : entry.content
                : undefined;
      const media =
        entry.kind !== "send-message"
          ? []
          : [
              ...(entry.message?.images ?? []).map((image) => ({ url: image.url, image: true })),
              ...(entry.message?.type === "attachment" && entry.message.url !== undefined
                ? [
                    {
                      url: entry.message.url,
                      image: false,
                      ...(entry.message.file_name === undefined
                        ? {}
                        : { name: entry.message.file_name }),
                    },
                  ]
                : []),
            ];
      if (text === undefined && media.length === 0) continue;
      const workflowReferences = grokBotWorkflowReferences(entry.richText);
      const peer = grokBotMessagePeer(input.native.botId, entry);
      const assistant =
        peer !== undefined || entry.kind === "send-message" || entry.role !== "user";
      // Native's post-call summary has no channel; it shares a requestId with the call's voice user
      // rows and follows its marker. In-call speech precedes the marker, and requests owned by a
      // managed turn or unrelated to the call are never claimed.
      const linkedCallId =
        assistant && entry.kind === "send-message" && entry.requestId !== undefined
          ? voiceRequests.get(entry.requestId)
          : undefined;
      const markerSeq = linkedCallId === undefined ? undefined : voiceMarkerSeqs.get(linkedCallId);
      const voiceCallId =
        linkedCallId !== undefined &&
        entry.message?.channel === undefined &&
        markerSeq !== undefined &&
        BigInt(row.seq) > markerSeq &&
        !requests.has(entry.requestId ?? "")
          ? linkedCallId
          : undefined;
      const key = `${generation}/${row.seq}/${entry.id}`;
      const version = BigInt(row.updatedSeq);
      if (version <= (versions.get(key) ?? -1n)) continue;
      const attachments: ChatAttachment[] = [];
      let unavailableAttachments = 0;
      for (const attachment of media) {
        const imported = yield* Effect.result(
          input.importAttachments === undefined
            ? Effect.fail(
                new GrokBotBindingError({
                  reason: "Native message attachments cannot be imported.",
                }),
              )
            : input.importAttachments(`${grokBotNativeThreadId(input.native)}/${key}`, [
                attachment,
              ]),
        );
        if (imported._tag === "Success") attachments.push(...imported.success);
        else unavailableAttachments++;
      }
      const existing = messages.get(key);
      const requestId = entry.requestId || messageRequests.get(key);
      const turn = assistant && requestId !== undefined ? requests.get(requestId) : undefined;
      const timestamp =
        entry.timestampMs === undefined ? now : DateTime.makeUnsafe(entry.timestampMs);
      const message: OrchestrationV2ConversationMessage = {
        id: input.idAllocator.derive.messageFromProviderItem({
          driver: GROK_BOT_DRIVER_KIND,
          nativeItemId: `${grokBotNativeThreadId(input.native)}/${key}`,
        }),
        threadId: input.native.threadId,
        runId: turn?.runId ?? null,
        nodeId: turn?.rootNodeId ?? null,
        role: assistant ? "assistant" : "user",
        createdBy: assistant || peer !== undefined ? "agent" : "user",
        ...(peer === undefined ? {} : { grokBotPeer: peer }),
        creationSource: "provider",
        ...(entry.kind === "message" &&
        entry.role === "user" &&
        grokBotVoiceCallIdFromChannel(entry.channel) !== undefined
          ? { grokBotVoiceUtterance: true as const }
          : {}),
        text:
          unavailableAttachments === 0
            ? (text ?? "")
            : [
                text,
                `${unavailableAttachments} attachment${unavailableAttachments === 1 ? " is" : "s are"} temporarily unavailable.`,
              ]
                .filter(Boolean)
                .join("\n\n"),
        ...(workflowReferences.length === 0
          ? {}
          : { grokBotWorkflowReferences: workflowReferences }),
        ...(voiceCall === undefined ? {} : { grokBotVoiceCall: voiceCall }),
        ...(connectorCard === undefined ? {} : { grokBotConnectorCard: connectorCard }),
        ...(voiceCallId === undefined ? {} : { grokBotVoiceCallId: voiceCallId }),
        attachments,
        streaming: entry.isStreaming === true,
        createdAt: existing?.createdAt ?? persisted?.createdAt ?? timestamp,
        // Transcript replay is an import, not new bot work. Settled history keeps
        // the native send time so reconnects cannot extend its displayed duration.
        updatedAt:
          entry.isStreaming === true
            ? now
            : entry.timestampMs === undefined
              ? (existing?.updatedAt ?? persisted?.updatedAt ?? timestamp)
              : timestamp,
      };
      messages.set(key, message);
      if (assistant && requestId !== undefined) messageRequests.set(key, requestId);
      if (
        input.onOwnedOutput !== undefined &&
        assistant &&
        peer === undefined &&
        voiceCall === undefined &&
        (entry.kind === "send-message" || entry.kind === "message") &&
        (message.text.trim() !== "" || attachments.length > 0)
      ) {
        // Only an answer carrying the turn's own request id can end that turn successfully. Position
        // after the echo is not ownership: bot-to-bot, voice, or native-client answers interleave.
        if (turn !== undefined)
          input.onOwnedOutput(
            turn,
            message.streaming,
            frame.replay ? (entry.timestampMs ?? 0) : DateTime.toEpochMillis(now),
          );
      }
      // A failed download remains retryable when the same native row is replayed.
      if (unavailableAttachments === 0) versions.set(key, version);
      events.push({ type: "message.updated", driver: GROK_BOT_DRIVER_KIND, message });
      events.push(
        grokBotMessageTurnItem(message, {
          native: input.native,
          ...(turn === undefined ? {} : { turn }),
          nativeItemId: `${grokBotNativeThreadId(input.native)}/${key}`,
        }),
      );
    }
    // An echo can arrive after an earlier reply frame. Keep its message id while adding run ownership.
    if (newlyOwnedRequests.size === 0) return events;
    for (const [key, requestId] of messageRequests) {
      if (!newlyOwnedRequests.has(requestId)) continue;
      const message = messages.get(key);
      const turn = requests.get(requestId);
      if (message === undefined || turn === undefined || message.runId !== null) continue;
      const associated = { ...message, runId: turn.runId, nodeId: turn.rootNodeId };
      messages.set(key, associated);
      events.push({ type: "message.updated", driver: GROK_BOT_DRIVER_KIND, message: associated });
      events.push(
        grokBotMessageTurnItem(associated, {
          native: input.native,
          turn,
          nativeItemId: `${grokBotNativeThreadId(input.native)}/${key}`,
        }),
      );
    }
    return events;
  });
  return {
    project,
    registerManagedMessageId,
    registerManagedTurn,
    messages: () => [...messages.values()],
    /** The generation to re-attach at, once native has asked for it. Reading clears the request. */
    takeRestart: () => {
      if (!restartRequested) return undefined;
      restartRequested = false;
      return generation;
    },
    peekRestart: () => restartRequested,
    turnForRequest: (requestId: string) => requests.get(requestId),
  };
};

/** Consecutive re-attaches that import no rows before the watch is declared failed. */
const GROK_BOT_MAX_FRUITLESS_RESTARTS = 3;

export type GrokBotAdapterV2DriverEnv =
  | GrokBotNativeRuntimeService
  | GrokBotManagedBinding
  | ProviderHost.ProviderHost
  | IdAllocator.IdAllocatorV2;

export const createGrokBotAdapterV2 = Effect.fnUntraced(function* (
  options: ProviderDriverCreateInput<GrokBotProviderSettings>,
) {
  const native = yield* GrokBotNativeRuntimeService;
  const bindings = yield* GrokBotManagedBinding;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const host = Option.getOrUndefined(yield* Effect.serviceOption(ProviderHost.ProviderHost));
  const managed = yield* makeGrokBotManagedTurn({ native, bindings });
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: GROK_BOT_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(GrokBotCapabilitiesV2),
    planSelectionTransition: ({ current, target }) =>
      Effect.succeed(
        current.instanceId === target.instanceId &&
          current.model === target.model &&
          (target.options === undefined || target.options.length === 0)
          ? { type: "apply_on_next_turn" as const }
          : {
              type: "reject" as const,
              reason: "A bound Grok Bot session cannot switch bots or accept model options.",
            },
      ),
    openSession: (input) =>
      Effect.gen(function* () {
        if (!options.enabled || options.config.accountBinding === null)
          return yield* new GrokBotBindingError({
            reason: "Choose the native account before enabling this provider.",
          });
        if (input.modelSelection.options !== undefined && input.modelSelection.options.length > 0)
          return yield* new GrokBotBindingError({
            reason: "Grok Bot does not expose model options.",
          });
        if (
          input.runtimePolicy.runtimeMode !== "full-access" ||
          input.runtimePolicy.interactionMode !== "default"
        )
          return yield* new GrokBotBindingError({
            reason: "Native Grok Bot execution does not expose T3 sandbox or plan policies.",
          });
        if ((yield* native.accountBinding) !== options.config.accountBinding)
          return yield* new GrokBotBindingError({
            reason: "The selected Grok Bot account or team changed.",
          });
        const owned = yield* bindings.resolve({
          threadId: input.threadId,
          providerInstanceId: options.instanceId,
          accountBinding: options.config.accountBinding,
          botId: input.modelSelection.model,
        });
        if (
          owned.binding !== options.config.accountBinding ||
          owned.threadId !== input.threadId ||
          owned.providerInstanceId !== options.instanceId ||
          owned.botId !== input.modelSelection.model
        )
          return yield* new GrokBotBindingError({
            reason: "The trusted native binding does not match this app thread.",
          });
        yield* Effect.addFinalizer(() =>
          bindings.release({ native: owned, providerSessionId: input.providerSessionId }),
        );
        const now = yield* DateTime.now;
        const nativeId = grokBotNativeThreadId(owned);
        const thread: OrchestrationV2ProviderThread = {
          id: ids.derive.providerThread({
            driver: GROK_BOT_DRIVER_KIND,
            nativeThreadId: nativeId,
            providerInstanceId: options.instanceId,
          }),
          driver: GROK_BOT_DRIVER_KIND,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          appThreadId: input.threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver: GROK_BOT_DRIVER_KIND, nativeId, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const assertThread = (candidate: OrchestrationV2ProviderThread) =>
          candidate.driver === GROK_BOT_DRIVER_KIND &&
          candidate.providerInstanceId === options.instanceId &&
          candidate.appThreadId === input.threadId &&
          candidate.nativeThreadRef?.driver === GROK_BOT_DRIVER_KIND &&
          candidate.nativeThreadRef?.nativeId === nativeId
            ? Effect.void
            : Effect.fail(
                new GrokBotBindingError({
                  reason: "This provider thread belongs to another native binding.",
                }),
              );
        const watchdog = makeGrokBotTurnWatchdog(yield* Clock.currentTimeMillis);
        const projection = makeGrokBotTranscriptProjection({
          native: owned,
          idAllocator: ids,
          onOwnedOutput: (turn, streaming, atMs) =>
            watchdog.observeOutput(turn.messageId, streaming, atMs),
          ...(bindings.lookupTranscriptTurn === undefined
            ? {}
            : {
                lookupTranscriptTurn: (messageId: string) =>
                  bindings.lookupTranscriptTurn!(owned, messageId),
              }),
          importAttachments: (entryId, attachments) =>
            host === undefined
              ? Effect.fail(
                  new GrokBotBindingError({
                    reason: "The native attachment store is unavailable.",
                  }),
                )
              : native
                  .receiveAttachments({
                    binding: owned.binding,
                    botId: owned.botId,
                    threadId: owned.threadId,
                    entryId,
                    attachmentsDir: host.paths.attachmentsDir,
                    attachments,
                  })
                  .pipe(
                    Effect.mapError(
                      () =>
                        new GrokBotBindingError({
                          reason: "Native message attachments could not be imported.",
                        }),
                    ),
                  ),
          ...(bindings.existingMessage === undefined
            ? {}
            : { existingMessage: (id) => bindings.existingMessage!(owned, id) }),
        });
        const settlements = makeGrokBotSettlementProjection(owned, bindings.lookupCompletion);
        const approvals = makeGrokBotApprovalProjection({
          native: owned,
          providerThreadId: thread.id,
          providerSessionId: input.providerSessionId,
          idAllocator: ids,
          runtime: native,
          turnForRequest: projection.turnForRequest,
        });
        for (const messageId of yield* bindings.restoreManagedMessageIds(owned))
          projection.registerManagedMessageId(messageId);
        for (const identity of yield* bindings.restoreTranscriptTurns(owned))
          projection.registerManagedTurn(identity);
        const restoredTurns = yield* bindings.restoreTurns(owned);
        const openedAtMs = yield* Clock.currentTimeMillis;
        for (const identity of restoredTurns) {
          yield* settlements.register(identity);
          projection.registerManagedTurn(identity);
          // A persisted turn restarts the watchdog's clock; replayed rows and native live state refine it.
          watchdog.track(identity, openedAtMs);
        }
        // A readable authoritative snapshot is required before any cloud send is permitted.
        const settlementWatch = yield* native.openSettlementWatch(owned);
        const completionWatch = yield* bindings.openCompletionWatch(owned);
        const inbox = yield* Queue.unbounded<
          ProviderAdapter.ProviderAdapterV2Event,
          GrokBotBindingError | RuntimeError
        >();
        yield* Effect.addFinalizer(() => Queue.shutdown(inbox));
        // This projection starts empty on each attachment. Replaying native history repairs
        // previously imported rows when support for their media or metadata changes.
        const projectFrame = (frame: RuntimeFrame) =>
          Effect.gen(function* () {
            watchdog.observeFrame(frame, yield* Clock.currentTimeMillis);
            return yield* Effect.zipWith(
              projection.project(frame),
              approvals.project(frame),
              (a, b) => [...a, ...b],
            );
          });
        const assertAccount = Effect.gen(function* () {
          if ((yield* native.accountBinding) !== owned.binding)
            return yield* new GrokBotBindingError({
              reason: "The selected Grok Bot account or team changed.",
            });
        });
        // Only the owned read stream recovers. Projection failures and writes never enter this path.
        const recoverRead = <A>(stream: Stream.Stream<A, RuntimeError>) =>
          stream.pipe(
            Stream.catchTags({
              GrokBotNativeReadError: (error) =>
                error.transient === true ? Stream.empty : Stream.fail(error),
            }),
          );
        // A 30-second attachment is healthy even without chat rows; brief connected frames alone
        // cannot reset the budget of a transport that repeatedly fails immediately.
        const backoff = (attempts: number) =>
          attempts > GROK_BOT_MAX_FRUITLESS_RESTARTS
            ? Effect.fail(new NativeRuntimeError({ kind: "uncertain" }))
            : Effect.sleep(Duration.millis(Math.max(1, attempts) * 1000));
        // Replay from zero retains the projection's row/version dedupe across reattachments.
        const watchFrom = (
          generation: number,
          fruitless: number,
        ): Stream.Stream<
          ProviderAdapter.ProviderAdapterV2Event[],
          GrokBotBindingError | RuntimeError
        > =>
          Stream.suspend(() => {
            let sawRows = false;
            let replayGeneration = generation;
            let startedAt = 0;
            const attempt = Stream.unwrap(
              Effect.gen(function* () {
                yield* assertAccount;
                startedAt = yield* Clock.currentTimeMillis;
                const scope = yield* Effect.scope;
                const renewal = yield* Deferred.make<void>();
                let scheduledRenewal = false;
                return recoverRead(
                  native.watch({ ...owned, generation, afterUpdatedSeq: "0" }),
                ).pipe(
                  Stream.mapEffect((frame) =>
                    Effect.gen(function* () {
                      if (frame._tag === "Connected" && !scheduledRenewal) {
                        const lifetime = Number(frame.absoluteLifetimeMs);
                        if (Number.isFinite(lifetime) && lifetime >= 1000) {
                          scheduledRenewal = true;
                          yield* Effect.sleep(
                            Duration.millis(Math.min(270000, Math.max(1000, lifetime * 0.9))),
                          ).pipe(
                            Effect.andThen(Deferred.succeed(renewal, undefined)),
                            Effect.forkIn(scope),
                          );
                        }
                      }
                      return frame;
                    }),
                  ),
                  Stream.interruptWhen(Deferred.await(renewal)),
                  // Durable cursors must commit with their ingested events, never before yielding them.
                  Stream.mapEffect((frame) =>
                    Effect.gen(function* () {
                      const batch = yield* projectFrame(frame);
                      if (frame._tag === "Rows") sawRows ||= frame.entries.length > 0;
                      if (frame._tag === "Rows" || frame._tag === "Cleared")
                        replayGeneration = frame.generation;
                      return batch;
                    }),
                  ),
                  Stream.takeUntil(() => projection.peekRestart()),
                );
              }),
            );
            // Close each attempt's scope, including its renewal timer, before opening the next watch.
            return attempt.pipe(
              Stream.concat(
                Stream.unwrap(
                  Effect.gen(function* () {
                    const next = projection.takeRestart();
                    const healthy = (yield* Clock.currentTimeMillis) - startedAt >= 30000;
                    const attempts = (next === undefined ? healthy : sawRows) ? 0 : fruitless + 1;
                    yield* backoff(attempts);
                    return watchFrom(next ?? replayGeneration, attempts);
                  }),
                ),
              ),
            );
          });
        const transcriptEvents = watchFrom(0, 0);
        const settlementFrom = (
          events: typeof settlementWatch.events,
          fruitless: number,
        ): Stream.Stream<SettlementFrame, GrokBotBindingError | RuntimeError> =>
          Stream.unwrap(
            Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis;
              return recoverRead(events).pipe(
                Stream.concat(
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const healthy = (yield* Clock.currentTimeMillis) - startedAt >= 30000;
                      const attempts = healthy ? 0 : fruitless + 1;
                      yield* backoff(attempts);
                      yield* assertAccount;
                      // The runtime subscribes before its fresh snapshot; settlement nonces dedupe replay.
                      return settlementFrom(
                        Stream.unwrap(
                          native
                            .openSettlementWatch(owned)
                            .pipe(Effect.map((watch) => watch.events)),
                        ),
                        attempts,
                      );
                    }),
                  ),
                ),
              );
            }),
          );
        const settlementEvents = settlementFrom(settlementWatch.events, 0).pipe(
          Stream.mapEffect(settlements.project),
        );
        const completionEvents = completionWatch.pipe(
          Stream.mapEffect((declaration) => settlements.projectCompletion(declaration)),
        );
        // Completion batches enqueue the authoritative final answer before terminal, across all sources.
        yield* Stream.merge(
          Stream.merge(transcriptEvents, settlementEvents),
          completionEvents,
        ).pipe(
          Stream.runForEach((batch) =>
            Effect.forEach(batch, (event) => Queue.offer(inbox, event), { discard: true }),
          ),
          Effect.catchCause((cause) => Queue.failCause(inbox, cause)),
          Effect.forkScoped,
        );
        // Bots that never call grok_bot_complete_turn would otherwise wait forever, so settle them
        // from native idle state and answer rows, or from sustained silence. See GrokBotTurnWatchdog.
        yield* Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          for (const identity of watchdog.pending())
            if (settlements.isSettled(identity.messageId)) watchdog.forget(identity.messageId);
          const held = new Set<string>();
          if (bindings.inFlightWork !== undefined)
            for (const identity of watchdog.pending())
              if (yield* bindings.inFlightWork(identity)) held.add(identity.messageId);
          const verdicts = watchdog.evaluate(nowMs, approvals.hasPending(), held);
          for (const verdict of verdicts) {
            const batch = yield* settlements.recover({ ...verdict, settledAtMs: nowMs }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Grok Bot turn recovery could not settle the turn.", {
                  runId: verdict.identity.runId,
                  cause,
                }).pipe(Effect.as([])),
              ),
            );
            if (batch.length > 0) watchdog.forget(verdict.identity.messageId);
            yield* Queue.offerAll(inbox, batch);
          }
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced(Duration.millis(GROK_BOT_WATCHDOG_INTERVAL_MS)),
          }),
          Effect.forkScoped,
        );
        const events = Stream.fromQueue(inbox).pipe(
          Stream.catch((cause) =>
            Stream.fromEffect(
              bindings.release({ native: owned, providerSessionId: input.providerSessionId }),
            ).pipe(Stream.flatMap(() => Stream.fail(cause))),
          ),
          Stream.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterEventStreamError({
                driver: GROK_BOT_DRIVER_KIND,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
        return {
          instanceId: options.instanceId,
          driver: GROK_BOT_DRIVER_KIND,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver: GROK_BOT_DRIVER_KIND,
            providerInstanceId: options.instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? ".",
            model: owned.botId,
            capabilities: GrokBotCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events,
          // Native phone history arrives on this watch, including with no T3 turn.
          // Keep the session through idle; the manager still enforces its pin cap.
          hasPendingBackgroundWork: Effect.succeed(true),
          ensureThread: (request) =>
            Effect.gen(function* () {
              if (
                request.threadId !== owned.threadId ||
                request.modelSelection.model !== owned.botId
              )
                return yield* new GrokBotBindingError({
                  reason: "The app thread or bot selection changed.",
                });
              if (request.existingProviderThread === undefined) return thread;
              const existing = request.existingProviderThread;
              if (
                existing.nativeThreadRef === null &&
                existing.status === "not_loaded" &&
                existing.providerInstanceId === options.instanceId &&
                existing.appThreadId === owned.threadId &&
                existing.driver === GROK_BOT_DRIVER_KIND
              )
                return { ...thread, id: existing.id };
              yield* assertThread(request.existingProviderThread);
              return {
                ...request.existingProviderThread,
                providerSessionId: input.providerSessionId,
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: GROK_BOT_DRIVER_KIND,
                    threadId: request.threadId,
                    cause,
                  }),
              ),
            ),
          resumeThread: (request) =>
            assertThread(request.providerThread).pipe(
              Effect.as({ ...request.providerThread, providerSessionId: input.providerSessionId }),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterResumeThreadError({
                    driver: GROK_BOT_DRIVER_KIND,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: request.providerThread.id,
                    cause,
                  }),
              ),
            ),
          injectHistory: () => Effect.succeed(false),
          startTurn: (request) =>
            Effect.gen(function* () {
              yield* assertThread(request.providerThread);
              if (
                request.threadId !== owned.threadId ||
                request.modelSelection.instanceId !== options.instanceId ||
                request.modelSelection.model !== owned.botId ||
                request.runtimePolicy.runtimeMode !== "full-access" ||
                request.runtimePolicy.interactionMode !== "default" ||
                (request.modelSelection.options !== undefined &&
                  request.modelSelection.options.length > 0)
              )
                return yield* new GrokBotBindingError({
                  reason: "The Grok Bot turn selection is unsupported.",
                });
              // Reconnect observes an already accepted native delivery. It must not
              // need a new cloud endpoint or issue another prompt while relay startup
              // is restoring its address. Only exact durable authority can use this path.
              const restored = restoredTurns.find(
                (identity) =>
                  identity.runId === request.runId &&
                  identity.attemptId === request.attemptId &&
                  identity.rootNodeId === request.rootNodeId &&
                  identity.providerThreadId === request.providerThread.id &&
                  identity.runOrdinal === request.runOrdinal &&
                  identity.providerTurnOrdinal === request.providerTurnOrdinal,
              );
              if (restored !== undefined) {
                const delivery = yield* native.sendStatus({
                  binding: owned.binding,
                  botId: owned.botId,
                  sessionId: owned.sessionId,
                  messageId: restored.messageId,
                });
                if (delivery.status === "accepted") {
                  yield* Queue.offer(inbox, {
                    type: "provider_turn.updated",
                    driver: GROK_BOT_DRIVER_KIND,
                    threadId: owned.threadId,
                    providerTurn: {
                      id: restored.providerTurnId,
                      providerThreadId: restored.providerThreadId,
                      nodeId: restored.rootNodeId,
                      runAttemptId: restored.attemptId,
                      nativeTurnRef: null,
                      ordinal: restored.providerTurnOrdinal,
                      status: "pending",
                      startedAt: null,
                      completedAt: null,
                    },
                  });
                  const completion = yield* bindings.lookupCompletion(restored);
                  if (completion !== undefined)
                    yield* Queue.offerAll(
                      inbox,
                      yield* settlements.projectCompletion(completion, true),
                    );
                  else yield* Queue.offerAll(inbox, yield* approvals.replayPending());
                  return;
                }
              }
              const availability = yield* bindings.availability;
              if (!availability.ready)
                return yield* new GrokBotBindingError({
                  reason: availability.reason ?? GROK_BOT_PROTOCOL_BLOCKER,
                });
              const providerTurnId = ProviderTurnId.make(
                `provider-turn/grok-bot/${encodeURIComponent(request.attemptId)}`,
              );
              const turn = yield* bindings.prepareTurn({
                native: owned,
                turn: request,
                providerTurnId,
                providerSessionId: input.providerSessionId,
              });
              if (
                turn.native.binding !== owned.binding ||
                turn.native.botId !== owned.botId ||
                turn.native.sessionId !== owned.sessionId ||
                turn.input.runId !== request.runId ||
                turn.input.attemptId !== request.attemptId ||
                turn.input.rootNodeId !== request.rootNodeId ||
                turn.providerTurnId !== providerTurnId
              )
                return yield* new GrokBotBindingError({
                  reason: "Prepared native turn authority does not match the committed app run.",
                });
              const identity = grokBotTurnIdentity(turn);
              const firstRegistration = yield* settlements.register(identity);
              projection.registerManagedTurn(identity);
              watchdog.track(identity, yield* Clock.currentTimeMillis);
              if (firstRegistration)
                yield* Queue.offer(inbox, {
                  type: "provider_turn.updated",
                  driver: GROK_BOT_DRIVER_KIND,
                  threadId: owned.threadId,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: request.providerThread.id,
                    nodeId: request.rootNodeId,
                    runAttemptId: request.attemptId,
                    nativeTurnRef: null,
                    ordinal: request.providerTurnOrdinal,
                    status: "pending",
                    startedAt: null,
                    completedAt: null,
                  },
                });
              const attachmentsDir =
                request.message.attachments.length === 0 ? undefined : host?.paths.attachmentsDir;
              yield* managed.send(turn, attachmentsDir).pipe(
                Effect.catchIf(
                  (error) =>
                    error._tag === "GrokBotNativeRuntimeError" && error.kind === "uncertain",
                  (error) =>
                    bindings.uncertain({ turn }).pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning(
                          "Native send remains uncertain after persistence failed.",
                          { runId: turn.input.runId, cause },
                        ),
                      ),
                      Effect.andThen(Effect.fail(error)),
                    ),
                ),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: GROK_BOT_DRIVER_KIND,
                    threadId: request.threadId,
                    providerThreadId: request.providerThread.id,
                    runId: request.runId,
                    cause,
                  }),
              ),
            ),
          steerTurn: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                driver: GROK_BOT_DRIVER_KIND,
                providerThreadId: request.providerThread.id,
              }),
            ),
          interruptTurn: (request) =>
            Effect.gen(function* () {
              yield* assertThread(request.providerThread);
              yield* bindings.verifyInterrupt({
                native: owned,
                providerThreadId: request.providerThread.id,
                providerTurnId: request.providerTurnId,
              });
              yield* native.interrupt(owned);
              // Stop/restart owns the old attempt's settlement. A late
              // watchdog verdict must not revive a superseded native turn.
              for (const identity of watchdog.pending())
                if (
                  identity.providerThreadId === request.providerThread.id &&
                  identity.providerTurnId === request.providerTurnId
                ) {
                  yield* Queue.offerAll(
                    inbox,
                    yield* settlements.project({
                      _tag: "Settlement",
                      clientNonce: identity.messageId,
                      outcome: "cancelled",
                      settledAtMs: yield* Clock.currentTimeMillis,
                    }),
                  );
                  watchdog.forget(identity.messageId);
                }
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: GROK_BOT_DRIVER_KIND,
                    providerThreadId: request.providerThread.id,
                    providerTurnId: request.providerTurnId,
                    cause,
                  }),
              ),
            ),
          respondToRuntimeRequest: (request) =>
            Effect.gen(function* () {
              // Widget questions arrive as answers; approvals and dismissals arrive as a decision.
              const settled =
                request.answers !== undefined
                  ? yield* approvals.answer(request.requestId, request.answers)
                  : request.decision !== undefined
                    ? yield* approvals.respond(request.requestId, request.decision)
                    : yield* new GrokBotBindingError({
                        reason: "Native approvals need an approve, deny, or always decision.",
                      });
              // Offered only after native confirmed dispatch; the request never shows a fake success.
              yield* Queue.offerAll(inbox, settled);
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: GROK_BOT_DRIVER_KIND,
                    requestId: request.requestId,
                    cause,
                  }),
              ),
            ),
          readThreadSnapshot: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                driver: GROK_BOT_DRIVER_KIND,
                providerThreadId: request.providerThread.id,
                cause: "Complete session-scoped native snapshots are not verified.",
              }),
            ),
          rollbackThread: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: GROK_BOT_DRIVER_KIND,
                providerThreadId: request.providerThread.id,
                cause: "Grok Bot does not expose verified rollback.",
              }),
            ),
          forkThread: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: GROK_BOT_DRIVER_KIND,
                providerThreadId: request.sourceProviderThread.id,
                cause: "Grok Bot does not expose verified fork.",
              }),
            ),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: GROK_BOT_DRIVER_KIND,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  });
});
