import {
  ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderDriverKind,
  ProviderTurnId,
  type ProviderInstanceId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { MuseAgentReceipt } from "../../museAgent/MuseAgentDeliveryStore.ts";
import type {
  MuseAgentDeliveryContext,
  MuseAgentHistoryOwnership,
} from "../../museAgent/MuseAgentDeliveryOwnership.ts";
import type { MuseAgentNativeEvent } from "../../museAgent/MuseAgentTransport.ts";

export const MUSE_AGENT_DRIVER_KIND = ProviderDriverKind.make("muse-agent");
const Payload = Schema.Struct({
  session_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  host_message_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parent_message_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parent_agent_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  root_agent_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  task_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  active_subagent_count: Schema.optionalKey(Schema.Number),
  occurred_at_ms: Schema.optionalKey(Schema.Number),
  reply_to_message_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  seq: Schema.optionalKey(Schema.Number),
  text: Schema.optionalKey(Schema.String),
  display_text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  display_text_ready: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  content: Schema.optionalKey(Schema.String),
  fallback_text: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  stream_lane: Schema.optionalKey(Schema.String),
  transcript_surface: Schema.optionalKey(Schema.String),
  transcript: Schema.optionalKey(Schema.Unknown),
});
const decodePayload = Schema.decodeUnknownOption(Payload);
const HistoryRow = Schema.Struct({
  event_name: Schema.String,
  payload: Schema.Unknown,
  message_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  host_message_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reply_to_message_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  session_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  display_text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  display_text_ready: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  seq: Schema.Number,
  occurred_at_ms: Schema.Number,
});
const decodeHistoryRow = Schema.decodeUnknownOption(HistoryRow);
export interface MuseAgentPresentationOwnership {
  readonly nativeMessageId: string;
  readonly deliveryKey: string;
  readonly context: Pick<
    MuseAgentDeliveryContext,
    "runId" | "nodeId" | "providerThreadId" | "providerTurnId"
  >;
}
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Message completion alone does not settle execution; root task or turn evidence is required. */
export function museTerminalStatus(status: string | undefined) {
  if (status === "completed" || status === "done") return "completed" as const;
  if (status === "interrupted") return "interrupted" as const;
  if (status === "cancelled") return "cancelled" as const;
  if (status === "failed" || status === "error") return "failed" as const;
  return null;
}

/** Only standalone native metadata is hidden; bracketed prose and inline examples stay literal. */
const MUSE_INLINE_MARKER =
  /^[\t ]*(?:\[\[hatch_widget:[^\]\r\n]*\]\]|\[(?:image|file|audio|video|document):[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+[\t ]+workspace\/[^\]\r\n]+\])[\t ]*\r?$/gm;
export function stripMuseInlineMarkers(text: string): string {
  const stripped = text.replace(MUSE_INLINE_MARKER, "");
  return stripped === text ? text : stripped.trimEnd();
}

function canonicalText(payload: typeof Payload.Type): string | undefined {
  const text = rawCanonicalText(payload);
  return text === undefined ? undefined : stripMuseInlineMarkers(text);
}

function rawCanonicalText(payload: typeof Payload.Type): string | undefined {
  let transcript: unknown = payload.transcript;
  if (typeof transcript === "string") {
    try {
      transcript = JSON.parse(transcript);
    } catch {
      transcript = null;
    }
  }
  const envelope = record(transcript);
  const messages = envelope?.messages;
  if (Array.isArray(messages)) {
    const match = messages
      .map(record)
      .find((message) => message?.role === "assistant" && message.id === payload.message_id);
    const last =
      envelope?.message_id === payload.message_id
        ? messages.map(record).findLast((message) => message?.role === "assistant")
        : undefined;
    const content = (match ?? last)?.content;
    if (Array.isArray(content)) {
      const text = content
        .map(record)
        .filter((block) => block?.type === "text")
        .map((block) => (typeof block?.text === "string" ? block.text : ""))
        .join("");
      if (text) return text;
    }
  }
  return payload.display_text ?? payload.content ?? payload.fallback_text;
}

export function museHistoryFrame(raw: unknown, sessionId: string): MuseAgentNativeEvent | null {
  const row = decodeHistoryRow(raw);
  if (row._tag === "None") return null;
  // Native history includes ancillary rows without an object payload. They still
  // advance the cursor; the message projection ignores unsupported event names.
  const payload = record(row.value.payload) ?? {};
  return {
    event: row.value.event_name,
    payload: {
      ...payload,
      session_id: row.value.session_id ?? sessionId,
      ...(row.value.message_id ? { message_id: row.value.message_id } : {}),
      ...(row.value.host_message_id ? { host_message_id: row.value.host_message_id } : {}),
      ...(row.value.reply_to_message_id
        ? { reply_to_message_id: row.value.reply_to_message_id }
        : {}),
      ...(row.value.display_text !== undefined ? { display_text: row.value.display_text } : {}),
      ...(row.value.display_text_ready !== undefined
        ? { display_text_ready: row.value.display_text_ready }
        : {}),
      seq: row.value.seq,
    },
    meta: { seq: row.value.seq, ts_ms: row.value.occurred_at_ms },
  };
}

/** Pure projection; account/session identity and native reply links gate managed attribution. */
export function makeMuseAgentProjection(input: {
  readonly binding: string;
  readonly sessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ProviderAdapter.ProviderAdapterV2OpenSessionInput["threadId"];
  readonly ownership?: MuseAgentHistoryOwnership;
}) {
  const messages = new Map<string, OrchestrationV2ConversationMessage>();
  const importedAttachments = new Map<string, readonly ChatAttachment[]>();
  const importedPresentations = new Set<string>();
  const attachmentNotices = new Set<string>();
  const decodeAttachments = Schema.decodeUnknownSync(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  );
  const replyLinks = new Map<string, string | null | undefined>();
  const turnLinks = new Map<
    string,
    {
      providerThreadId: ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"]["id"];
      providerTurnId: ProviderTurnId;
    }
  >();
  const latestCanonicalSeq = new Map<string, number>();
  const firstCanonicalSeq = new Map<string, number>();
  const latestStreamSeq = new Map<string, number>();
  const finalized = new Set<string>();
  // One watermark per event kind/message, independent of the number of streamed chunks.
  const latestEventSeq = new Map<string, number>();
  const buffered: MuseAgentNativeEvent[] = [];
  let active:
    | {
        turn: ProviderAdapter.ProviderAdapterV2TurnInput;
        id: ProviderTurnId;
        receipt?: MuseAgentReceipt;
        terminal: boolean;
        ownerBoundaryMs?: number;
        latestForeignUserMs?: number;
        ownerRootAgentId?: string | undefined;
        ownershipRevoked?: boolean;
        rootTask?: { id: string; startedAtMs: number } | undefined;
        canonicalAssistantSeen?: boolean;
        pendingTaskTerminal?: MuseAgentNativeEvent | undefined;
        runningCandidates: MuseAgentNativeEvent[];
      }
    | undefined;
  const ownedAssistantIds = new Set<string>();
  const ownedUserIds = new Set<string>();
  const observerProtectedAssistantIds = new Set<string>();
  const historicalContexts = new Map<string, MuseAgentDeliveryContext>();
  const frozenMessageIds = new Set<string>();
  const ownedDeliveryKeys = new Map<string, string>();
  const ownedReceiptIds = new Map<string, ReadonlySet<string>>();
  const validateContext = (context: MuseAgentDeliveryContext) => {
    if (
      context.threadId !== input.threadId ||
      context.providerInstanceId !== input.providerInstanceId
    )
      throw new Error("muse_history_ownership_scope");
  };
  const retainOwnedUserReceipts = (receipts: MuseAgentHistoryOwnership["receipts"]) => {
    for (const receipt of receipts) {
      validateContext(receipt.context);
      ownedUserIds.add(receipt.messageId);
      ownedUserIds.add(receipt.replyToMessageId);
    }
  };
  retainOwnedUserReceipts(input.ownership?.receipts ?? []);
  for (const message of input.ownership?.messages ?? []) {
    validateContext(message.context);
    if (!message.nativeMessageId || message.nativeMessageId.length > 1024)
      throw new Error("muse_history_message_identity");
    historicalContexts.set(message.nativeMessageId, message.context);
    ownedDeliveryKeys.set(message.nativeMessageId, message.deliveryKey);
    messages.set(message.nativeMessageId, message.snapshot.message);
    if (message.frozen) frozenMessageIds.add(message.nativeMessageId);
    const receipt = input.ownership?.receipts.find(
      (receipt) =>
        receipt.context.runId === message.context.runId &&
        receipt.context.providerTurnId === message.context.providerTurnId,
    );
    if (receipt) replyLinks.set(message.nativeMessageId, receipt.messageId);
    if (receipt)
      ownedReceiptIds.set(
        message.nativeMessageId,
        new Set([receipt.messageId, receipt.replyToMessageId]),
      );
    turnLinks.set(message.nativeMessageId, {
      providerThreadId: message.context.providerThreadId,
      providerTurnId: message.context.providerTurnId,
    });
  }
  const nativeThreadId = `${input.binding}/${encodeURIComponent(input.sessionId)}`;
  const providerThreadId = IdAllocator.derive.providerThread({
    driver: MUSE_AGENT_DRIVER_KIND,
    providerInstanceId: input.providerInstanceId,
    nativeThreadId,
  });
  // Chat renders turn items; the sink preserves their first persisted position on updates.
  const messageEvents = (
    nativeId: string,
    message: OrchestrationV2ConversationMessage,
  ): ProviderAdapter.ProviderAdapterV2Event[] => {
    const link = turnLinks.get(nativeId);
    const base = {
      id: IdAllocator.derive.turnItemFromProviderItem({
        driver: MUSE_AGENT_DRIVER_KIND,
        nativeItemId: message.id,
      }),
      threadId: message.threadId,
      runId: message.runId,
      nodeId: message.nodeId,
      providerThreadId: link?.providerThreadId ?? providerThreadId,
      providerTurnId: link?.providerTurnId ?? null,
      nativeItemRef: { driver: MUSE_AGENT_DRIVER_KIND, nativeId, strength: "strong" as const },
      parentItemId: null,
      ordinal: 0,
      ...(message.runId === null && firstCanonicalSeq.has(nativeId)
        ? { canonicalNativeSequence: firstCanonicalSeq.get(nativeId)! }
        : {}),
      status: message.streaming ? ("running" as const) : ("completed" as const),
      title: null,
      startedAt: message.createdAt,
      completedAt: message.streaming ? null : message.updatedAt,
      updatedAt: message.updatedAt,
      messageId: message.id,
      text: message.text,
      attachments: message.attachments,
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
    return [
      { type: "message.updated", driver: MUSE_AGENT_DRIVER_KIND, message },
      { type: "turn_item.updated", driver: MUSE_AGENT_DRIVER_KIND, turnItem },
    ];
  };
  const ownsReply = (payload: typeof Payload.Type) =>
    active?.receipt &&
    !active.ownershipRevoked &&
    (payload.reply_to_message_id === active.receipt.replyToMessageId ||
      payload.reply_to_message_id === active.receipt.messageId);
  const nativeTimestamp = (frame: MuseAgentNativeEvent, payload: typeof Payload.Type) => {
    const value = frame.meta?.ts_ms ?? payload.occurred_at_ms;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const pinRootTask = (frame: MuseAgentNativeEvent, payload: typeof Payload.Type) => {
    const owner = active;
    const time = nativeTimestamp(frame, payload);
    if (
      !owner?.receipt ||
      owner.terminal ||
      owner.ownershipRevoked ||
      owner.rootTask ||
      owner.ownerBoundaryMs === undefined ||
      time === undefined ||
      time < owner.ownerBoundaryMs ||
      payload.status !== "running" ||
      !payload.task_id ||
      payload.task_id.length > 1024 ||
      payload.agent_id !== payload.task_id ||
      payload.root_agent_id !== payload.task_id ||
      (owner.ownerRootAgentId !== undefined && owner.ownerRootAgentId !== payload.task_id)
    )
      return;
    owner.rootTask = { id: payload.task_id, startedAtMs: time };
  };
  const finish = (
    status: NonNullable<ReturnType<typeof museTerminalStatus>>,
    now: DateTime.Utc,
  ) => {
    const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
    if (!active?.receipt || active.terminal) return [];
    // Preserve every partial answer, finalize it before emitting terminal.
    for (const [key, message] of messages)
      if (message.runId === active.turn.runId) {
        frozenMessageIds.add(key);
        if (message.streaming) {
          const final = { ...message, streaming: false, updatedAt: now };
          messages.set(key, final);
          events.push(...messageEvents(key, final));
        }
      }
    active.terminal = true;
    events.push({
      type: "provider_turn.updated",
      driver: MUSE_AGENT_DRIVER_KIND,
      threadId: input.threadId,
      providerTurn: { ...providerTurn(active.turn, active.id), status, completedAt: now },
    });
    const terminal = {
      type: "turn.terminal" as const,
      driver: MUSE_AGENT_DRIVER_KIND,
      providerThreadId: active.turn.providerThread.id,
      providerTurnId: active.id,
      runOrdinal: active.turn.runOrdinal,
      threadDisposition: "reusable" as const,
    };
    events.push(
      status === "failed"
        ? {
            ...terminal,
            status,
            failureItemOrdinal: 1,
            failure: {
              class: "unknown",
              message: "Muse reported that the native turn failed.",
              code: "muse_native_failure",
              retryable: false,
            },
          }
        : { ...terminal, status, failure: null },
    );
    return events;
  };
  const project = (
    frame: MuseAgentNativeEvent,
    presentationOwner?: MuseAgentPresentationOwnership,
  ): ProviderAdapter.ProviderAdapterV2Event[] => {
    if (frame.event === "transport.turn_superseded") {
      if (!active || active.terminal) return [];
      const decoded = decodePayload(frame.payload);
      if (
        decoded._tag === "None" ||
        decoded.value.session_id !== input.sessionId ||
        !decoded.value.message_id ||
        !decoded.value.reply_to_message_id
      )
        return [];
      if (!active.receipt) {
        if (buffered.length >= 4096) throw new Error("muse_admission_buffer_full");
        buffered.push(frame);
        return [];
      }
      if (
        decoded.value.message_id !== active.receipt.messageId ||
        decoded.value.reply_to_message_id !== active.receipt.replyToMessageId
      )
        return [];
      // The authenticated transport revoked the exact admitted delivery. Interrupt our
      // local run without cancelling or attributing the replacement native turn.
      active.ownershipRevoked = true;
      active.rootTask = undefined;
      active.pendingTaskTerminal = undefined;
      active.runningCandidates.length = 0;
      return finish("interrupted", DateTime.nowUnsafe());
    }
    const parsed = decodePayload(frame.payload);
    if (parsed._tag === "None") return [];
    const payload = parsed.value;
    if (
      payload.session_id !== input.sessionId ||
      payload.stream_lane === "subagent" ||
      payload.transcript_surface === "subagent"
    )
      return [];
    if (active && !active.receipt) {
      if (buffered.length >= 4096) throw new Error("muse_admission_buffer_full");
      buffered.push(frame);
      return [];
    }
    const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
    const timeMs = frame.meta?.ts_ms;
    const now =
      typeof timeMs === "number" &&
      Number.isFinite(timeMs) &&
      timeMs >= 0 &&
      timeMs < 8640000000000000
        ? DateTime.makeUnsafe(timeMs)
        : DateTime.nowUnsafe();
    const nativeId =
      frame.event === "delta.text_append"
        ? (payload.parent_message_id ?? payload.message_id)
        : frame.event === "delta.presentation"
          ? (payload.host_message_id ?? payload.message_id)
          : payload.message_id;
    if (frame.event === "message.user" && active?.receipt && !active.terminal) {
      if (nativeId === active.receipt.messageId || nativeId === active.receipt.replyToMessageId) {
        const time = nativeTimestamp(frame, payload);
        if (
          !active.ownershipRevoked &&
          time !== undefined &&
          active.ownerBoundaryMs === undefined
        ) {
          active.ownerBoundaryMs = time;
          active.ownerRootAgentId = payload.parent_agent_id ?? undefined;
          if (active.latestForeignUserMs !== undefined && active.latestForeignUserMs >= time) {
            active.ownershipRevoked = true;
          }
          for (const candidate of active.runningCandidates) {
            const decoded = decodePayload(candidate.payload);
            if (decoded._tag === "Some") pinRootTask(candidate, decoded.value);
          }
          active.runningCandidates.length = 0;
        }
      } else {
        const time = nativeTimestamp(frame, payload);
        if (time !== undefined)
          active.latestForeignUserMs = Math.max(active.latestForeignUserMs ?? -1, time);
        // Historical messages cannot supersede the exact admitted native user message.
        if (
          time === undefined ||
          (active.ownerBoundaryMs !== undefined && time >= active.ownerBoundaryMs)
        ) {
          active.ownershipRevoked = true;
          active.rootTask = undefined;
          active.pendingTaskTerminal = undefined;
          active.runningCandidates.length = 0;
        }
      }
    }
    const time = nativeTimestamp(frame, payload);
    const rootRelated =
      active?.rootTask !== undefined &&
      !active.terminal &&
      !active.ownershipRevoked &&
      time !== undefined &&
      time >= active.rootTask.startedAtMs &&
      payload.agent_id === active.rootTask.id &&
      !payload.reply_to_message_id;
    const managed =
      !active?.ownershipRevoked &&
      (ownsReply(payload) || rootRelated || (nativeId != null && ownedAssistantIds.has(nativeId)));

    if (frame.event === "task.status") {
      if (!active?.receipt || active.terminal || active.ownershipRevoked) return [];
      if (payload.status === "running") {
        if (
          active.pendingTaskTerminal &&
          active.rootTask &&
          time !== undefined &&
          payload.task_id === active.rootTask.id &&
          payload.agent_id === active.rootTask.id &&
          payload.root_agent_id === active.rootTask.id
        ) {
          const pending = decodePayload(active.pendingTaskTerminal.payload);
          const pendingTime =
            pending._tag === "Some"
              ? nativeTimestamp(active.pendingTaskTerminal, pending.value)
              : undefined;
          if (pendingTime !== undefined && time >= pendingTime)
            active.pendingTaskTerminal = undefined;
        }
        if (active.ownerBoundaryMs === undefined) {
          // Native running and canonical user messages use different sequence spaces and
          // can arrive in the opposite order from their timestamps.
          if (active.runningCandidates.length < 32) active.runningCandidates.push(frame);
        } else pinRootTask(frame, payload);
        return [];
      }
      const status = museTerminalStatus(payload.status);
      if (
        !status ||
        !active.rootTask ||
        time === undefined ||
        time < active.rootTask.startedAtMs ||
        payload.task_id !== active.rootTask.id ||
        payload.agent_id !== active.rootTask.id ||
        payload.root_agent_id !== active.rootTask.id ||
        payload.active_subagent_count !== 0
      )
        return [];
      if (status === "completed" && !active.canonicalAssistantSeen) {
        active.pendingTaskTerminal = frame;
        return [];
      }
      return finish(status, now);
    }
    if (frame.event === "delta.turn_done") {
      if (!active?.receipt || active.terminal) return [];
      const receipt = active.receipt;
      const matches =
        ownsReply(payload) ||
        (!payload.reply_to_message_id &&
          payload.message_id != null &&
          (payload.message_id === receipt.messageId ||
            payload.message_id === receipt.replyToMessageId ||
            ownedAssistantIds.has(payload.message_id)));
      const status = museTerminalStatus(payload.status);
      return matches && status ? finish(status, now) : [];
    }
    if (!nativeId || nativeId.length > 1024) return [];
    const role = frame.event === "message.user" ? ("user" as const) : ("assistant" as const);
    if (
      ![
        "message.user",
        "message.assistant",
        "delta.message_start",
        "delta.text_append",
        "delta.message_done",
        "delta.presentation",
      ].includes(frame.event)
    )
      return [];
    if (
      role === "assistant" &&
      !active &&
      payload.reply_to_message_id &&
      ownedUserIds.has(payload.reply_to_message_id)
    ) {
      observerProtectedAssistantIds.add(nativeId);
    }
    if (role === "assistant" && observerProtectedAssistantIds.has(nativeId)) return [];
    const presentation = frame.event === "delta.presentation";
    const captured =
      presentation && presentationOwner?.nativeMessageId === nativeId
        ? presentationOwner
        : undefined;
    if (role === "assistant" && frozenMessageIds.has(nativeId) && !presentation) return [];
    const historicalContext = historicalContexts.get(nativeId);
    if (
      role === "assistant" &&
      historicalContext &&
      !captured &&
      (frozenMessageIds.has(nativeId) ||
        !managed ||
        active?.id !== historicalContext.providerTurnId)
    )
      return [];
    if (presentation && !importedPresentations.has(nativeId)) return [];
    if (role === "user" && ownedUserIds.has(nativeId)) return [];
    const seq = frame.meta?.seq ?? payload.seq;
    if (seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return [];
    const existing = messages.get(nativeId);
    if (captured && existing?.runId != null && existing.runId !== captured.context.runId) return [];
    if (active?.terminal && existing?.runId === active.turn.runId && !presentation) return [];
    // Muse can keep one assistant message id while a newer native user message
    // redirects the root task. Preserve our interrupted partial instead of replacing
    // it with text produced after that delivery lost ownership.
    if (active?.ownershipRevoked && existing?.runId === active.turn.runId) return [];
    const streamEvent = frame.event.startsWith("delta.");
    const previousSeq = (streamEvent ? latestStreamSeq : latestCanonicalSeq).get(nativeId) ?? -1;
    const previousOrder = firstCanonicalSeq.get(nativeId);
    const canonicalMessage = frame.event === "message.user" || frame.event === "message.assistant";
    const orderChanged =
      canonicalMessage && seq < 999_999 && (previousOrder === undefined || seq < previousOrder);
    if (orderChanged) firstCanonicalSeq.set(nativeId, seq);
    if (seq < previousSeq)
      return orderChanged && existing?.runId === null ? messageEvents(nativeId, existing) : [];
    const eventKey = `${frame.event}:${nativeId}`;
    if (seq <= (latestEventSeq.get(eventKey) ?? -1)) return [];
    latestEventSeq.set(eventKey, seq);
    if (streamEvent && !presentation && (finalized.has(nativeId) || (managed && active?.terminal)))
      return [];
    if (streamEvent) latestStreamSeq.set(nativeId, seq);
    const append = frame.event === "delta.text_append";
    const canonical =
      (frame.event === "message.assistant" && payload.display_text_ready !== false) ||
      frame.event === "message.user" ||
      frame.event === "delta.message_done" ||
      presentation;
    const text = append
      ? (existing?.text ?? "") + (payload.text ?? "")
      : presentation
        ? (existing?.text ?? canonicalText(payload) ?? "")
        : (canonicalText(payload) ?? existing?.text ?? "");
    if (text.length > 4_194_304) throw new Error("muse_message_limit");
    const streaming =
      role === "assistant" && (presentation ? (existing?.streaming ?? false) : !canonical);
    if (managed && role === "assistant" && active) {
      ownedAssistantIds.add(nativeId);
      ownedDeliveryKeys.set(nativeId, active.turn.attemptId);
      if (active.receipt)
        ownedReceiptIds.set(
          nativeId,
          new Set([active.receipt.messageId, active.receipt.replyToMessageId]),
        );
      turnLinks.set(nativeId, {
        providerThreadId: active.turn.providerThread.id,
        providerTurnId: active.id,
      });
    }
    if (captured) {
      ownedDeliveryKeys.set(nativeId, captured.deliveryKey);
      turnLinks.set(nativeId, {
        providerThreadId: captured.context.providerThreadId,
        providerTurnId: captured.context.providerTurnId,
      });
    }
    const message: OrchestrationV2ConversationMessage = {
      id: IdAllocator.derive.messageFromProviderItem({
        driver: MUSE_AGENT_DRIVER_KIND,
        nativeItemId: `${nativeThreadId}/${encodeURIComponent(nativeId)}`,
      }),
      threadId: input.threadId,
      runId:
        captured?.context.runId ??
        (managed
          ? (active?.turn.runId ?? null)
          : (historicalContexts.get(nativeId)?.runId ?? existing?.runId ?? null)),
      nodeId:
        captured?.context.nodeId ??
        (managed
          ? (active?.turn.rootNodeId ?? null)
          : (historicalContexts.get(nativeId)?.nodeId ?? existing?.nodeId ?? null)),
      role,
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "provider",
      text,
      attachments: importedAttachments.get(nativeId) ?? existing?.attachments ?? [],
      streaming,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!streamEvent) latestCanonicalSeq.set(nativeId, seq);
    if (canonical && !presentation) finalized.add(nativeId);
    if (canonical && role === "assistant" && managed && active && !streaming)
      active.canonicalAssistantSeen = true;
    if (
      existing?.text === text &&
      existing.streaming === streaming &&
      existing.runId === message.runId &&
      !orderChanged
    )
      return [];
    messages.set(nativeId, message);
    replyLinks.set(nativeId, payload.reply_to_message_id ?? replyLinks.get(nativeId));
    events.push(...messageEvents(nativeId, message));
    if (active?.pendingTaskTerminal && active.canonicalAssistantSeen && !active.ownershipRevoked) {
      const pending = active.pendingTaskTerminal;
      active.pendingTaskTerminal = undefined;
      events.push(...project(pending));
    }
    return events;
  };
  return {
    nativeThreadId,
    project,
    capturePresentation(frame: MuseAgentNativeEvent): MuseAgentPresentationOwnership | undefined {
      if (frame.event !== "delta.presentation") return;
      const decoded = decodePayload(frame.payload);
      if (
        decoded._tag === "None" ||
        decoded.value.session_id !== input.sessionId ||
        decoded.value.stream_lane === "subagent" ||
        decoded.value.transcript_surface === "subagent"
      )
        return;
      const payload = decoded.value;
      const nativeMessageId = payload.host_message_id ?? payload.message_id;
      if (!nativeMessageId || nativeMessageId.length > 1024) return;
      const key = ownedDeliveryKeys.get(nativeMessageId),
        message = messages.get(nativeMessageId),
        link = turnLinks.get(nativeMessageId);
      const reply = payload.reply_to_message_id;
      const explicit = reply != null && ownedReceiptIds.get(nativeMessageId)?.has(reply);
      const current =
        active?.receipt !== undefined &&
        !active.terminal &&
        !active.ownershipRevoked &&
        key === active.turn.attemptId &&
        (!reply || ownsReply(payload));
      if (
        key &&
        message?.role === "assistant" &&
        message.runId &&
        message.nodeId &&
        link &&
        (explicit || current)
      )
        return {
          nativeMessageId,
          deliveryKey: key,
          context: { runId: message.runId, nodeId: message.nodeId, ...link },
        };
      const time = nativeTimestamp(frame, payload);
      const rootRelated =
        active?.rootTask !== undefined &&
        !active.terminal &&
        !active.ownershipRevoked &&
        time !== undefined &&
        time >= active.rootTask.startedAtMs &&
        payload.agent_id === active.rootTask.id &&
        !payload.reply_to_message_id;
      if (active?.receipt && !active.ownershipRevoked && (ownsReply(payload) || rootRelated))
        return {
          nativeMessageId,
          deliveryKey: active.turn.attemptId,
          context: {
            runId: active.turn.runId,
            nodeId: active.turn.rootNodeId,
            providerThreadId: active.turn.providerThread.id,
            providerTurnId: active.id,
          },
        };
      return;
    },
    canImportPresentation(
      frame: MuseAgentNativeEvent,
      captured: MuseAgentPresentationOwnership | undefined,
    ) {
      if (frame.event !== "delta.presentation") return true;
      const decoded = decodePayload(frame.payload);
      if (decoded._tag === "None") return false;
      const nativeId = decoded.value.host_message_id ?? decoded.value.message_id;
      return (
        !nativeId ||
        (!observerProtectedAssistantIds.has(nativeId) &&
          (!ownedDeliveryKeys.has(nativeId) || captured !== undefined))
      );
    },
    restore: (): ProviderAdapter.ProviderAdapterV2Event[] =>
      (input.ownership?.messages ?? []).flatMap(({ snapshot }) => [
        {
          type: "message.updated" as const,
          driver: MUSE_AGENT_DRIVER_KIND,
          message: snapshot.message,
        },
        {
          type: "turn_item.updated" as const,
          driver: MUSE_AGENT_DRIVER_KIND,
          turnItem: snapshot.turnItem,
        },
      ]),
    retainOwnedUserReceipts,
    /** Refresh identities only; a sibling's older persisted body must never replace live text. */
    retainOwnedAssistantAssociations(ownership: MuseAgentHistoryOwnership) {
      retainOwnedUserReceipts(ownership.receipts);
      for (const message of ownership.messages) {
        validateContext(message.context);
        if (!message.nativeMessageId || message.nativeMessageId.length > 1024)
          throw new Error("muse_history_message_identity");
        if (!active) observerProtectedAssistantIds.add(message.nativeMessageId);
        else if (active.id !== message.context.providerTurnId) {
          historicalContexts.set(message.nativeMessageId, message.context);
          ownedDeliveryKeys.set(message.nativeMessageId, message.deliveryKey);
          if (message.frozen) frozenMessageIds.add(message.nativeMessageId);
        }
      }
    },
    unknownAssistantIdentity(frame: MuseAgentNativeEvent) {
      if (
        ![
          "message.assistant",
          "delta.message_start",
          "delta.text_append",
          "delta.message_done",
          "delta.presentation",
        ].includes(frame.event)
      )
        return;
      const decoded = decodePayload(frame.payload);
      if (decoded._tag === "None") return;
      const payload = decoded.value;
      if (
        payload.session_id !== input.sessionId ||
        payload.stream_lane === "subagent" ||
        payload.transcript_surface === "subagent"
      )
        return;
      const nativeId =
        frame.event === "delta.text_append"
          ? (payload.parent_message_id ?? payload.message_id)
          : frame.event === "delta.presentation"
            ? (payload.host_message_id ?? payload.message_id)
            : payload.message_id;
      if (
        !nativeId ||
        nativeId.length > 1024 ||
        ownedDeliveryKeys.has(nativeId) ||
        observerProtectedAssistantIds.has(nativeId)
      )
        return;
      if (!active && payload.reply_to_message_id && ownedUserIds.has(payload.reply_to_message_id)) {
        observerProtectedAssistantIds.add(nativeId);
        return;
      }
      return nativeId;
    },
    /** Only server-imported metadata enters here; native JSON cannot supply T3 attachment IDs. */
    attach(
      nativeId: string,
      attachments: readonly ChatAttachment[],
    ): ProviderAdapter.ProviderAdapterV2Event[] {
      if (!nativeId || nativeId.length > 1024) throw new Error("muse_attachment_message_identity");
      const decoded = decodeAttachments(attachments);
      const existing = messages.get(nativeId);
      if (
        existing?.role === "user" ||
        (active?.ownershipRevoked && existing?.runId === active.turn.runId)
      )
        return [];
      importedPresentations.add(nativeId);
      const previous = importedAttachments.get(nativeId) ?? existing?.attachments ?? [];
      const merged = [...previous];
      for (const attachment of decoded)
        if (!merged.some((item) => item.id === attachment.id)) merged.push(attachment);
      if (
        merged.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
        (importedAttachments.size >= 4096 && !importedAttachments.has(nativeId))
      )
        throw new Error("muse_attachment_limit");
      if (merged.length === previous.length) return [];
      importedAttachments.set(nativeId, merged);
      if (!existing) return [];
      const updated = { ...existing, attachments: merged, updatedAt: DateTime.nowUnsafe() };
      messages.set(nativeId, updated);
      return messageEvents(nativeId, updated);
    },
    attachmentFailed(nativeId: string): ProviderAdapter.ProviderAdapterV2Event[] {
      if (!nativeId || nativeId.length > 1024 || attachmentNotices.has(nativeId)) return [];
      attachmentNotices.add(nativeId);
      const message = messages.get(nativeId);
      const link = turnLinks.get(nativeId);
      const now = DateTime.nowUnsafe();
      return [
        {
          type: "turn_item.updated",
          driver: MUSE_AGENT_DRIVER_KIND,
          turnItem: {
            id: IdAllocator.derive.turnItemFromProviderItem({
              driver: MUSE_AGENT_DRIVER_KIND,
              nativeItemId: `${nativeThreadId}/attachment-unavailable/${encodeURIComponent(nativeId)}`,
            }),
            threadId: input.threadId,
            runId: message?.runId ?? null,
            nodeId: message?.nodeId ?? null,
            providerThreadId: link?.providerThreadId ?? providerThreadId,
            providerTurnId: link?.providerTurnId ?? null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: "Attachment unavailable",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "system_notice",
            message:
              "A Muse attachment could not be imported. Open the native conversation in Muse to access it.",
          },
        },
      ];
    },
    begin(turn: ProviderAdapter.ProviderAdapterV2TurnInput) {
      if (
        active?.turn.attemptId === turn.attemptId &&
        (active.turn.runId !== turn.runId ||
          active.turn.rootNodeId !== turn.rootNodeId ||
          active.turn.providerThread.id !== turn.providerThread.id)
      )
        throw new Error("muse_attempt_identity_changed");
      if (active && !active.terminal && active.turn.attemptId !== turn.attemptId)
        throw new Error("muse_turn_busy");
      const id = ProviderTurnId.make(
        `provider-turn/muse-agent/${encodeURIComponent(turn.attemptId)}`,
      );
      if (active?.turn.attemptId !== turn.attemptId) {
        active = { turn, id, terminal: false, runningCandidates: [] };
        ownedAssistantIds.clear();
        buffered.length = 0;
      }
      return id;
    },
    admit(receipt: MuseAgentReceipt) {
      if (!active || receipt.sessionId !== input.sessionId)
        throw new Error("muse_receipt_mismatch");
      active.receipt = receipt;
      ownedUserIds.add(receipt.messageId);
      ownedUserIds.add(receipt.replyToMessageId);
      const events: ProviderAdapter.ProviderAdapterV2Event[] = [
        {
          type: "provider_turn.updated",
          driver: MUSE_AGENT_DRIVER_KIND,
          threadId: input.threadId,
          providerTurn: providerTurn(active.turn, active.id),
        },
      ];
      // Replayed canonical history may precede admission; associate the same rows instead
      // of waiting for a duplicate native frame or inserting another answer.
      for (const [nativeId, message] of messages) {
        const reply = replyLinks.get(nativeId);
        if (
          message.role !== "assistant" ||
          (reply !== receipt.messageId && reply !== receipt.replyToMessageId)
        )
          continue;
        if (message.runId !== null && message.runId !== active.turn.runId) continue;
        const associated = { ...message, runId: active.turn.runId, nodeId: active.turn.rootNodeId };
        messages.set(nativeId, associated);
        ownedAssistantIds.add(nativeId);
        ownedDeliveryKeys.set(nativeId, active.turn.attemptId);
        ownedReceiptIds.set(nativeId, new Set([receipt.messageId, receipt.replyToMessageId]));
        turnLinks.set(nativeId, {
          providerThreadId: active.turn.providerThread.id,
          providerTurnId: active.id,
        });
        if (!associated.streaming) active.canonicalAssistantSeen = true;
        events.push(...messageEvents(nativeId, associated));
      }
      const early = buffered.splice(0);
      for (const frame of early) events.push(...project(frame));
      return events;
    },
    isTerminal: () => active?.terminal === true,
    abandonAdmission() {
      if (active && !active.receipt) {
        active = undefined;
        buffered.length = 0;
        ownedAssistantIds.clear();
      }
    },
    deliveryKey: () => active?.turn.attemptId,
    deliveryForMessage: (nativeId: string) => ownedDeliveryKeys.get(nativeId),
    ownsManagedMessage: (nativeId: string) =>
      active?.receipt !== undefined &&
      ownedAssistantIds.has(nativeId) &&
      messages.get(nativeId)?.runId === active.turn.runId,
    receipt: () => active?.receipt,
    matchesTurn: (id: ProviderTurnId) => active?.id === id && !active.terminal,
    snapshot: () => [...messages.values()],
  };
}

function providerTurn(
  turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  id: ProviderTurnId,
): OrchestrationV2ProviderTurn {
  return {
    id,
    providerThreadId: turn.providerThread.id,
    nodeId: turn.rootNodeId,
    runAttemptId: turn.attemptId,
    nativeTurnRef: null,
    ordinal: turn.providerTurnOrdinal,
    status: "running",
    startedAt: DateTime.nowUnsafe(),
    completedAt: null,
  };
}
