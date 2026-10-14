import {
  ProviderDriverKind,
  type NodeId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderSessionId,
  type ProviderThreadId,
  RuntimeRequestId,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type {
  GrokBotNativeRuntimeService,
  RuntimeError,
  RuntimeFrame,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import { GrokBotBindingError, type GrokBotBoundSession } from "./GrokBotManagedBinding.ts";
import { decodeGrokBotWidget, type GrokBotWidget } from "../../grokBot/GrokBotWidget.ts";

import type { GrokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";

const DRIVER = ProviderDriverKind.make("grok-bot");

/**
 * Native command approvals, local-tool permissions, connector grants and widget questions
 * become runtime requests. Responses remain pending until their native callback confirms them.
 */
const GROK_BOT_APPROVAL_PLATFORM = "desktop";

export interface GrokBotNativeApproval {
  readonly entryId: string;
  readonly requestId: string;
  readonly prompt: string | undefined;
  readonly approvedCommand: string | undefined;
  /** The native client treats any status other than "pending" as settled. */
  readonly answered: boolean;
}

const text = (value: unknown, max = 4096) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;

const NativeId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const NativeText = Schema.String.check(Schema.isMaxLength(65536));
const ApprovalEntry = Schema.Struct({
  kind: Schema.Literal("send-message"),
  id: NativeId,
  message: Schema.Struct({
    type: Schema.Literal("auto-review-approval"),
    approval: Schema.Struct({
      requestId: NativeId,
      status: NativeId,
      summary: Schema.optionalKey(NativeText),
      command: Schema.optionalKey(NativeText),
    }),
  }),
});
const LocalPermissionEntry = Schema.Struct({
  kind: Schema.Literal("send-message"),
  id: NativeId,
  message: Schema.Struct({
    type: Schema.Literal("local-tool-permission"),
    ask: Schema.Struct({
      requestId: NativeId,
      status: NativeId,
      action: NativeId,
      target: NativeText,
      description: Schema.optionalKey(NativeText),
    }),
  }),
});
const ConnectorGrantEntry = Schema.Struct({
  kind: Schema.Literal("send-message"),
  id: NativeId,
  message: Schema.Struct({
    type: Schema.Literal("connector-grant"),
    ask: Schema.Struct({ requestId: NativeId, status: NativeId, serverName: NativeId }),
  }),
});
const decodeApproval = Schema.decodeUnknownOption(ApprovalEntry);
const decodeLocalPermission = Schema.decodeUnknownOption(LocalPermissionEntry);
const decodeConnectorGrant = Schema.decodeUnknownOption(ConnectorGrantEntry);

export function decodeGrokBotApproval(value: unknown): GrokBotNativeApproval | undefined {
  const entry = Option.getOrUndefined(decodeApproval(value));
  if (entry === undefined) return undefined;
  const approval = entry.message.approval;
  return {
    entryId: entry.id,
    requestId: approval.requestId,
    prompt: text(approval.summary),
    approvedCommand: text(approval.command, 65536),
    answered: text(approval.status) !== "pending",
  };
}

/** Always-allow needs the native client's rule store, which T3 cannot write; approve or deny only. */
const GROK_BOT_APPROVAL_OPTIONS: readonly ProviderApprovalOption[] = [
  { decision: "accept", label: "Approve" },
  { decision: "decline", label: "Deny" },
];

type ApprovalRuntime = Pick<
  GrokBotNativeRuntimeService["Service"],
  | "resolveAutoReviewApproval"
  | "respondToWidget"
  | "dismissWidget"
  | "resolveLocalToolPermission"
  | "resolveConnectorGrant"
>;
type NativeCall = (
  runtime: ApprovalRuntime,
  native: GrokBotBoundSession,
) => Effect.Effect<unknown, RuntimeError>;

export function grokBotApprovalCall(
  approval: GrokBotNativeApproval,
  decision: ProviderApprovalDecision,
): NativeCall | undefined {
  if (decision !== "accept" && decision !== "decline" && decision !== "cancel") return undefined;
  return (runtime, native) =>
    runtime.resolveAutoReviewApproval({
      binding: native.binding,
      botId: native.botId,
      sessionId: native.sessionId,
      requestId: approval.requestId,
      resolution: decision === "accept" ? "APPROVED" : "DENIED",
      approvalPlatform: GROK_BOT_APPROVAL_PLATFORM,
      ...(approval.approvedCommand === undefined
        ? {}
        : { approvedCommand: approval.approvedCommand }),
    });
}

type Native =
  | { readonly kind: "approval"; readonly approval: GrokBotNativeApproval }
  | { readonly kind: "local_permission"; readonly entry: typeof LocalPermissionEntry.Type }
  | { readonly kind: "connector_grant"; readonly entry: typeof ConnectorGrantEntry.Type }
  | { readonly kind: "widget"; readonly widget: GrokBotWidget };

/** One native card as this projection sees it. `settled` is set only when native already settled it. */
interface Observed {
  readonly entryId: string;
  /** Stable native identity: the permission request id, or the widget entry id. */
  readonly key: string;
  readonly native: Native;
  readonly settled: "resolved" | "cancelled" | undefined;
}

interface Tracked {
  readonly nativeRequestId: string | undefined;
  turn: GrokBotTurnIdentity | undefined;
  readonly native: Native;
  readonly entryId: string;
  readonly key: string;
  readonly requestId: RuntimeRequestId;
  readonly nodeId: NodeId;
  readonly createdAt: DateTime.Utc;
  readonly seq: bigint;
  status: "pending" | "resolved" | "cancelled";
  inflight: boolean;
  version: bigint;
}

/** Settlement details that the event artifacts carry; absent means a dismissal with no answer. */
interface Outcome {
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: ProviderUserInputAnswers;
}

function observe(value: unknown): Observed | undefined {
  if (
    !Predicate.isObject(value) ||
    !Predicate.isObject(value.message) ||
    typeof value.message.type !== "string" ||
    !["auto-review-approval", "local-tool-permission", "connector-grant", "widget"].includes(
      value.message.type,
    )
  )
    return undefined;
  const approval = decodeGrokBotApproval(value);
  if (approval !== undefined)
    return {
      entryId: approval.entryId,
      key: `auto_review_approval/${approval.requestId}`,
      native: { kind: "approval", approval },
      settled: approval.answered ? "resolved" : undefined,
    };
  const widget = decodeGrokBotWidget(value);
  if (widget === undefined) {
    const local = Option.getOrUndefined(decodeLocalPermission(value));
    if (local !== undefined)
      return {
        entryId: local.id,
        key: `local_tool_permission/${local.message.ask.requestId}`,
        native: { kind: "local_permission", entry: local },
        settled: local.message.ask.status === "pending" ? undefined : "resolved",
      };
    const connector = Option.getOrUndefined(decodeConnectorGrant(value));
    if (connector !== undefined)
      return {
        entryId: connector.id,
        key: `connector_grant/${connector.message.ask.requestId}`,
        native: { kind: "connector_grant", entry: connector },
        settled: connector.message.ask.status === "pending" ? undefined : "resolved",
      };
    return undefined;
  }
  return {
    entryId: widget.entryId,
    key: `widget/${widget.entryId}`,
    native: { kind: "widget", widget },
    settled:
      widget.state === "responded"
        ? "resolved"
        : widget.state === "dismissed"
          ? "cancelled"
          : undefined,
  };
}

const widgetQuestion = (widget: GrokBotWidget): OrchestrationV2UserInputQuestion => ({
  id: widget.entryId,
  header: "Question",
  question: widget.prompt,
  options: widget.options.map((option) => ({
    label: option.label,
    description: option.description ?? option.label,
    ...(option.value === undefined ? {} : { value: option.value }),
  })),
  multiSelect: widget.multiSelect,
  allowCustomAnswer: widget.allowCustom,
});

/** Shipped XBe/A0: option order, normalized parts, then one newline-delimited string. */
function widgetChoiceValue(widget: GrokBotWidget, answer: unknown): string | undefined {
  const choices = widget.options.map((option) => option.value ?? option.label);
  if (!widget.multiSelect) {
    return typeof answer === "string" &&
      answer.trim().length > 0 &&
      (choices.includes(answer) || widget.allowCustom) &&
      answer.length <= 65536
      ? answer
      : undefined;
  }
  const parts = typeof answer === "string" ? [answer] : Array.isArray(answer) ? answer : [];
  if (parts.some((part) => typeof part !== "string")) return undefined;
  const selected = new Set(parts);
  const custom = parts.filter(
    (part): part is string => typeof part === "string" && !choices.includes(part),
  );
  if (!widget.allowCustom && custom.some((part) => part.trim().length > 0)) return undefined;
  const value = [
    ...choices.filter((choice) => selected.has(choice)),
    ...(widget.allowCustom ? custom : []),
  ]
    .map((part) => part.replace(/\s*\n\s*/g, " ").trim())
    .filter((part) => part.length > 0)
    .join("\n");
  return value.length > 0 && value.length <= 65536 ? value : undefined;
}

const approvalPresentation = (native: Exclude<Native, { kind: "widget" }>) => {
  switch (native.kind) {
    case "approval":
      return {
        kind: "command" as const,
        prompt: native.approval.prompt,
        options: GROK_BOT_APPROVAL_OPTIONS,
      };
    case "local_permission": {
      const ask = native.entry.message.ask;
      return {
        kind: "permission" as const,
        prompt: [ask.description, `${ask.action}: ${ask.target}`].filter(Boolean).join("\n"),
        options: [
          { decision: "accept", label: "Allow once" },
          { decision: "decline", label: "Deny" },
        ] satisfies ProviderApprovalOption[],
      };
    }
    case "connector_grant":
      return {
        kind: "permission" as const,
        prompt: `Allow access to ${native.entry.message.ask.serverName}?`,
        options: [
          { decision: "accept", label: "Allow" },
          { decision: "decline", label: "Skip" },
        ] satisfies ProviderApprovalOption[],
      };
  }
};

/**
 * Projects native approval and widget cards of one owned account/bot/session into T3 runtime
 * requests. The exact managed echo correlates cards to their run; external native cards remain
 * runless. The projection only sees rows of the owned session cursor, so response ownership
 * follows from the request being tracked here.
 */
export const makeGrokBotApprovalProjection = (input: {
  readonly native: GrokBotBoundSession;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly runtime: ApprovalRuntime;
  readonly turnForRequest?: (requestId: string) => GrokBotTurnIdentity | undefined;
}) => {
  const tracked = new Map<string, Tracked>();
  const byRequest = new Map<string, Tracked>();
  const deletedVersions = new Map<string, bigint>();
  const threadId = input.native.threadId;
  let latestWidgetSeq = -1n;

  const artifacts = (item: Tracked, now: DateTime.Utc, outcome: Outcome = {}) => {
    const pending = item.status === "pending";
    const itemStatus = pending
      ? ("waiting" as const)
      : item.status === "resolved"
        ? ("completed" as const)
        : ("cancelled" as const);
    const nativeItemRef = {
      driver: DRIVER,
      nativeId: item.key,
      strength: "strong" as const,
    };
    const presentation =
      item.native.kind === "widget" ? undefined : approvalPresentation(item.native);
    const isApproval = presentation !== undefined;
    const node: OrchestrationV2ExecutionNode = {
      id: item.nodeId,
      threadId,
      runId: item.turn?.runId ?? null,
      parentNodeId: item.turn?.rootNodeId ?? null,
      rootNodeId: item.turn?.rootNodeId ?? item.nodeId,
      kind: isApproval ? "approval_request" : "user_input_request",
      status: itemStatus,
      countsForRun: item.turn !== undefined,
      providerThreadId: input.providerThreadId,
      providerTurnId: item.turn?.providerTurnId ?? null,
      nativeItemRef,
      runtimeRequestId: item.requestId,
      checkpointScopeId: null,
      startedAt: item.createdAt,
      completedAt: pending ? null : now,
    };
    const request: OrchestrationV2RuntimeRequest = isApproval
      ? {
          id: item.requestId,
          nodeId: item.nodeId,
          providerTurnId: item.turn?.providerTurnId ?? null,
          nativeRequestRef: nativeItemRef,
          kind: presentation.kind,
          status: pending ? "pending" : item.status === "resolved" ? "resolved" : "cancelled",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: item.createdAt,
          resolvedAt: pending ? null : now,
          ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
        }
      : {
          id: item.requestId,
          nodeId: item.nodeId,
          providerTurnId: item.turn?.providerTurnId ?? null,
          nativeRequestRef: nativeItemRef,
          kind: "user_input",
          status: pending ? "pending" : item.status === "resolved" ? "resolved" : "cancelled",
          responseCapability: { type: "message", providerSessionId: input.providerSessionId },
          createdAt: item.createdAt,
          resolvedAt: pending ? null : now,
          ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
          ...(outcome.answers === undefined ? {} : { answers: outcome.answers }),
        };
    const base = {
      id: input.idAllocator.derive.approvalTurnItem({ requestId: item.requestId }),
      threadId,
      runId: item.turn?.runId ?? null,
      nodeId: item.nodeId,
      providerThreadId: input.providerThreadId,
      providerTurnId: item.turn?.providerTurnId ?? null,
      nativeItemRef,
      parentItemId: null,
      ordinal: 0,
      status: itemStatus,
      title: null,
      startedAt: item.createdAt,
      completedAt: pending ? null : now,
      updatedAt: now,
    };
    const turnItem: OrchestrationV2TurnItem =
      item.native.kind !== "widget"
        ? {
            ...base,
            type: "approval_request",
            requestId: item.requestId,
            requestKind: presentation!.kind,
            ...(presentation!.prompt === undefined ? {} : { prompt: presentation!.prompt }),
            options: [...presentation!.options],
          }
        : {
            ...base,
            type: "user_input_request",
            requestId: item.requestId,
            questions: [widgetQuestion(item.native.widget)],
            ...(outcome.answers === undefined
              ? {}
              : {
                  questionAnswer: {
                    requestId: item.requestId,
                    answers: outcome.answers,
                    attachmentsByQuestionId: {},
                    questionTextById: { [item.entryId]: item.native.widget.prompt },
                  },
                }),
          };
    return [
      { type: "node.updated", driver: DRIVER, node },
      { type: "runtime_request.updated", driver: DRIVER, threadId, runtimeRequest: request },
      { type: "turn_item.updated", driver: DRIVER, turnItem },
    ] satisfies ProviderAdapter.ProviderAdapterV2Event[];
  };

  const project = Effect.fnUntraced(function* (frame: RuntimeFrame) {
    const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
    if (frame._tag !== "Rows") return events;
    const now = yield* DateTime.now;
    const cards = frame.entries.flatMap((row) => {
      const observed = observe(row.value);
      return observed === undefined ? [] : [{ row, observed }];
    });
    for (const { row, observed } of cards) {
      if (row.entryId !== undefined && row.entryId !== observed.entryId)
        return yield* new GrokBotBindingError({
          reason: "Native approval row identity does not match its body.",
        });
    }
    for (const row of frame.deletes) {
      if (row.entryId === undefined) continue;
      const version = BigInt(row.updatedSeq);
      if (version > (deletedVersions.get(row.entryId) ?? -1n))
        deletedVersions.set(row.entryId, version);
    }
    // Full snapshots can contain old widgets whose native pending flag was never cleared.
    // Native displays only the newest card, even when that card has already been answered.
    for (const { row, observed } of cards) {
      if (observed.native.kind === "widget") {
        const seq = BigInt(row.seq);
        if (seq > latestWidgetSeq) latestWidgetSeq = seq;
      }
    }
    for (const older of tracked.values()) {
      if (
        older.native.kind === "widget" &&
        older.seq < latestWidgetSeq &&
        older.status === "pending"
      ) {
        older.status = "cancelled";
        events.push(...artifacts(older, now));
      }
    }
    for (const { row, observed } of cards.sort((a, b) =>
      BigInt(a.row.updatedSeq) > BigInt(b.row.updatedSeq)
        ? -1
        : BigInt(a.row.updatedSeq) < BigInt(b.row.updatedSeq)
          ? 1
          : 0,
    )) {
      const version = BigInt(row.updatedSeq);
      const seq = BigInt(row.seq);
      if ((deletedVersions.get(observed.entryId) ?? -1n) >= version) continue;
      if (observed.native.kind === "widget" && seq < latestWidgetSeq) continue;
      const existing = tracked.get(observed.key);
      if (existing === undefined) {
        // Settled approvals were never actionable here. The latest settled widget still needs
        // to reconcile questions persisted by older observers when no native question is open.
        // Observation sessions reopen independently of the native card. Allocation adds a UUID,
        // so derive the request from its owned thread and native identity across those reopens.
        const requestId = RuntimeRequestId.make(
          `runtime-request:grok-bot:${encodeURIComponent(threadId)}:${encodeURIComponent(input.native.binding)}:${encodeURIComponent(input.native.botId)}:${encodeURIComponent(input.native.sessionId)}:${encodeURIComponent(observed.key)}`,
        );
        const nativeRequestId =
          Predicate.isObject(row.value) && !Array.isArray(row.value)
            ? text(row.value.requestId, 1024)
            : undefined;
        const item: Tracked = {
          nativeRequestId,
          turn: nativeRequestId === undefined ? undefined : input.turnForRequest?.(nativeRequestId),
          native: observed.native,
          entryId: observed.entryId,
          key: observed.key,
          requestId,
          nodeId: input.idAllocator.derive.approvalNode({ requestId }),
          createdAt: now,
          seq,
          status: observed.settled ?? "pending",
          inflight: false,
          version,
        };
        tracked.set(observed.key, item);
        byRequest.set(String(requestId), item);
        if (observed.settled === undefined || observed.native.kind === "widget")
          events.push(...artifacts(item, now));
        continue;
      }
      // Replays, duplicates and stale versions never change state; a settled card never reopens.
      if (version <= existing.version || existing.status !== "pending") continue;
      if (existing.entryId !== observed.entryId) continue;
      existing.version = version;
      if (observed.settled !== undefined) {
        existing.status = observed.settled;
        events.push(...artifacts(existing, now));
      }
    }
    // A reply can precede its owned echo. Re-associate the pending card once that
    // exact request is proved, without relying on native idle or assistant text.
    for (const item of tracked.values()) {
      if (
        item.turn !== undefined ||
        item.nativeRequestId === undefined ||
        item.status !== "pending"
      )
        continue;
      const turn = input.turnForRequest?.(item.nativeRequestId);
      if (turn === undefined) continue;
      item.turn = turn;
      events.push(...artifacts(item, now));
    }
    for (const row of frame.deletes) {
      for (const item of tracked.values()) {
        if (
          item.entryId !== row.entryId ||
          item.status !== "pending" ||
          BigInt(row.updatedSeq) <= item.version
        )
          continue;
        item.version = BigInt(row.updatedSeq);
        item.status = "cancelled";
        events.push(...artifacts(item, now));
      }
    }
    return events;
  });

  /**
   * Runs one native call for a tracked card and returns its settled events only after native
   * confirms dispatch. Refusal or uncertainty throws and leaves the request pending for the user.
   */
  const settle = Effect.fnUntraced(function* (
    item: Tracked,
    call: NativeCall,
    status: "resolved" | "cancelled",
    outcome?: Outcome,
  ) {
    item.inflight = true;
    yield* call(input.runtime, input.native).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          item.inflight = false;
        }),
      ),
    );
    if (item.status !== "pending") return [];
    item.status = status;
    return artifacts(item, yield* DateTime.now, outcome);
  });

  const ownedItem = (requestId: RuntimeRequestId) => {
    const item = byRequest.get(String(requestId));
    if (item === undefined)
      return Effect.fail(
        new GrokBotBindingError({
          reason: "This approval does not belong to the bound native session.",
        }),
      );
    return Effect.succeed(item);
  };

  /** Settled items are a no-op so a replayed effect does not fail a request that already ended. */
  const pendingItem = Effect.fnUntraced(function* (requestId: RuntimeRequestId) {
    const item = yield* ownedItem(requestId);
    if (item.inflight)
      return yield* new GrokBotBindingError({
        reason: "This native approval is already being answered.",
      });
    return item.status === "pending" ? item : undefined;
  });

  const respond = Effect.fnUntraced(function* (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) {
    const item = yield* pendingItem(requestId);
    if (item === undefined) return [];
    if (item.native.kind === "widget") {
      if (decision !== "cancel")
        return yield* new GrokBotBindingError({
          reason: "This question needs an answer, not an approval choice.",
        });
      return yield* settle(
        item,
        (runtime, native) =>
          runtime.dismissWidget({
            binding: native.binding,
            botId: native.botId,
            sessionId: native.sessionId,
            entryId: item.entryId,
          }),
        "cancelled",
        { decision: "cancel" },
      );
    }
    const permission = item.native;
    const call =
      permission.kind === "approval"
        ? grokBotApprovalCall(permission.approval, decision)
        : ["accept", "decline", "cancel"].includes(decision)
          ? (runtime: ApprovalRuntime, native: GrokBotBoundSession) => {
              const entry = permission.entry;
              const owner = {
                binding: native.binding,
                botId: native.botId,
                sessionId: native.sessionId,
                requestId: entry.message.ask.requestId,
                entryId: entry.id,
              };
              return permission.kind === "local_permission"
                ? runtime.resolveLocalToolPermission({
                    ...owner,
                    resolution: decision === "accept" ? "ALLOW_ONCE" : "DENY",
                  })
                : runtime.resolveConnectorGrant({
                    ...owner,
                    resolution: decision === "accept" ? "ALLOWED" : "SKIPPED",
                  });
            }
          : undefined;
    if (call === undefined)
      return yield* new GrokBotBindingError({
        reason: "Grok Bot cannot apply that approval choice.",
      });
    return yield* settle(item, call, "resolved", { decision });
  });

  /** Answers only this widget; invalid input never dismisses it or becomes a chat turn. */
  const answer = Effect.fnUntraced(function* (
    requestId: RuntimeRequestId,
    answers: ProviderUserInputAnswers,
  ) {
    const item = yield* pendingItem(requestId);
    if (item === undefined) return [];
    if (item.native.kind !== "widget")
      return yield* new GrokBotBindingError({
        reason: "This approval needs an approve or deny choice.",
      });
    const widget = item.native.widget;
    if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, item.entryId))
      return yield* new GrokBotBindingError({
        reason: "The answer does not belong to this native question.",
      });
    const value = widgetChoiceValue(widget, answers[item.entryId]);
    if (value === undefined) {
      return yield* new GrokBotBindingError({
        reason: "Choose an offered option or an allowed custom answer.",
      });
    }
    return yield* settle(
      item,
      (runtime, native) =>
        runtime.respondToWidget({
          binding: native.binding,
          botId: native.botId,
          sessionId: native.sessionId,
          entryId: item.entryId,
          value,
        }),
      "resolved",
      { answers },
    );
  });

  const replayPending = Effect.fnUntraced(function* () {
    const now = yield* DateTime.now;
    return [...tracked.values()].flatMap((item) =>
      item.status === "pending" ? artifacts(item, now) : [],
    );
  });
  /** A pending native question or approval means the bot is waiting on the user, not stalled. */
  const hasPending = () => [...tracked.values()].some((item) => item.status === "pending");
  return { project, respond, answer, replayPending, hasPending };
};
