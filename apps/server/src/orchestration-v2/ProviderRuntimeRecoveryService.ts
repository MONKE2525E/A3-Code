import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type ProviderThreadId,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GrokBotManagedStateStore from "../grokBot/GrokBotManagedStateStore.ts";
import * as GrokBotThreadService from "../grokBot/GrokBotThreadService.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  mergeRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";

export class ProviderRuntimeRecoveryError extends Schema.TaggedError<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals(["read-projections", "reconcile", "drain-outbox"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}

export interface ProviderRuntimeRecoverySummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly prepareForShutdown: Effect.Effect<void, ProviderRuntimeRecoveryError>;
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
  }
>()("t3/orchestration-v2/ProviderRuntimeRecoveryService") {}

function nonterminalRuns(projection: ProjectionStore.ProjectionRuntimeRecoveryState) {
  return projection.runs.filter((run) => {
    const status: string = run.status;
    if (run.status === "waiting" && run.resourceWait === true) return false;
    return (
      status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting"
    );
  });
}

function isBackgroundCapableTurnItemType(type: string): boolean {
  return type === "command_execution" || type === "dynamic_tool" || type === "subagent";
}

function isNonterminalTurnItemStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isNonterminalNodeStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

/**
 * A delegate_task child. Its own thread is reconciled and continued on its own
 * and reports back through the app, so it is not provider background work.
 */
function isAppOwnedDelegation(task: {
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
}): boolean {
  return task.origin === "app_owned" && task.childThreadId !== null;
}

function isAppOwnedDelegationItem(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
): boolean {
  return item.type === "subagent" && isAppOwnedDelegation(item);
}

function providerThreadHasPendingBackgroundTasks(
  providerThread: OrchestrationV2ThreadProjection["providerThreads"][number],
): boolean {
  return (providerThread.pendingBackgroundTasks?.length ?? 0) > 0;
}

/**
 * Resolve providerInstanceId for a stale background-capable turn item whose
 * run is missing/null (or not found). Prefer an existing run, then a subagent
 * item's own instance id, then the item's provider thread, then a last-resort
 * first provider thread, then the thread's selected provider.
 */
function resolveStaleBackgroundItemProviderInstanceId(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): OrchestrationV2ThreadProjection["thread"]["providerInstanceId"] {
  if (item.runId !== null) {
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    if (run !== undefined) {
      return run.providerInstanceId;
    }
  }
  if (item.type === "subagent") {
    return item.providerInstanceId;
  }
  if (item.providerThreadId !== null && item.providerThreadId !== undefined) {
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === item.providerThreadId,
    );
    if (providerThread !== undefined) {
      return providerThread.providerInstanceId;
    }
  }
  return projection.providerThreads[0]?.providerInstanceId ?? projection.thread.providerInstanceId;
}

/** An open item closed by recovery. A secret card also closes its form, so it takes no answer. */
const cancelledItem = (
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  now: DateTime.Utc,
): OrchestrationV2ThreadProjection["turnItems"][number] =>
  item.type === "secret_request" && item.secretStatus === "pending"
    ? { ...item, status: "cancelled", secretStatus: "cancelled", completedAt: now, updatedAt: now }
    : { ...item, status: "cancelled", completedAt: now, updatedAt: now };

/**
 * A provider thread's latest started run: the last turn that provider saw.
 * Restart recovery records the thread's cancelled background work on it, and
 * the next run on the same provider thread delivers it with its input.
 */
function latestStartedRun(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  providerThreadId: ProviderThreadId,
) {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | undefined>(
    (latest, run) =>
      run.providerThreadId === providerThreadId &&
      run.status !== "queued" &&
      run.status !== "rolled_back" &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

/** Reconciliation may still cancel a local provider in a thread that also owns a cloud bot. */
function processBoundProjection(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  remoteRuns: readonly OrchestrationV2ThreadProjection["runs"][number][],
): ProjectionStore.ProjectionRuntimeRecoveryState {
  if (remoteRuns.length === 0) return projection;
  const runIds = new Set(remoteRuns.map((run) => run.id));
  const providerThreadIds = new Set(remoteRuns.map((run) => run.providerThreadId));
  const attemptIds = new Set(remoteRuns.map((run) => run.activeAttemptId));
  const remoteThreads = projection.providerThreads.filter((thread) =>
    providerThreadIds.has(thread.id),
  );
  const sessionIds = new Set(remoteThreads.map((thread) => thread.providerSessionId));
  const nodeIds = new Set(
    projection.nodes
      .filter(
        (node) =>
          (node.runId !== null && runIds.has(node.runId)) ||
          remoteRuns.some(
            (run) => run.rootNodeId === node.rootNodeId || run.rootNodeId === node.id,
          ) ||
          remoteThreads.some((thread) => thread.ownerNodeId === node.id),
      )
      .map((node) => node.id),
  );
  return {
    ...projection,
    runs: projection.runs.filter((run) => !runIds.has(run.id)),
    attempts: projection.attempts.filter((attempt) => !attemptIds.has(attempt.id)),
    providerThreads: projection.providerThreads.filter(
      (thread) => !providerThreadIds.has(thread.id),
    ),
    providerSessions: projection.providerSessions.filter((session) => !sessionIds.has(session.id)),
    providerTurns: projection.providerTurns.filter(
      (turn) => !providerThreadIds.has(turn.providerThreadId) && !attemptIds.has(turn.runAttemptId),
    ),
    nodes: projection.nodes.filter((node) => !nodeIds.has(node.id)),
    subagents: projection.subagents.filter(
      (subagent) =>
        !nodeIds.has(subagent.id) && (subagent.runId === null || !runIds.has(subagent.runId)),
    ),
    messages: projection.messages.filter(
      (message) => message.runId === null || !runIds.has(message.runId),
    ),
    turnItems: projection.turnItems.filter(
      (item) =>
        (item.runId === null || !runIds.has(item.runId)) &&
        (item.nodeId === null || !nodeIds.has(item.nodeId)) &&
        !providerThreadIds.has(item.providerThreadId ?? null),
    ),
    runtimeRequests: projection.runtimeRequests.filter(
      (request) =>
        !nodeIds.has(request.nodeId) &&
        (request.responseCapability.type !== "live" ||
          !sessionIds.has(request.responseCapability.providerSessionId) ||
          // Runless cards (Grok Bot native approvals) bind live capability to
          // an adapter instance that restart always replaces, so they expire
          // even when the cloud run on that session reconnects.
          request.providerTurnId == null),
    ),
  };
}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const managedBots = yield* Effect.serviceOption(
    GrokBotManagedStateStore.GrokBotManagedStateStore,
  );
  // Startup runs before command readiness. Later reconciliation must not end
  // call authority acquired by this process after that initial recovery.
  let callParentsRecovered = false;
  const recoverableRemoteRuns = Effect.fn("ProviderRuntimeRecoveryService.remoteRuns")(function* (
    projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  ) {
    const surviving: Array<OrchestrationV2ThreadProjection["runs"][number]> = [];
    if (Option.isNone(managedBots)) return surviving;
    for (const run of nonterminalRuns(projection)) {
      if (run.activeAttemptId == null || run.providerThreadId == null) continue;
      const providerThread = projection.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      );
      if (providerThread?.driver !== "grok-bot") continue;
      const stored = yield* managedBots.value
        .lookupTurn({ runId: run.id, attemptId: run.activeAttemptId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "read-projections",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
      if (stored === undefined || stored.state === "settled") continue;
      const identity = stored.identity;
      const nativeId = [identity.native.binding, identity.native.botId, identity.native.sessionId]
        .map(encodeURIComponent)
        .join("/");
      if (
        identity.runId !== run.id ||
        identity.attemptId !== run.activeAttemptId ||
        identity.native.threadId !== projection.thread.id ||
        identity.native.providerInstanceId !== run.providerInstanceId ||
        identity.providerThreadId !== providerThread.id ||
        identity.rootNodeId !== run.rootNodeId ||
        providerThread.appThreadId !== projection.thread.id ||
        providerThread.providerInstanceId !== run.providerInstanceId ||
        providerThread.nativeThreadRef?.driver !== "grok-bot" ||
        providerThread.nativeThreadRef.strength !== "strong" ||
        providerThread.nativeThreadRef?.nativeId !== nativeId
      )
        continue;
      // Account changes may prevent reconnecting, but they do not stop the previous account's cloud work.
      surviving.push(run);
    }
    return surviving;
  });
  const reconcileProjection = Effect.fn("ProviderRuntimeRecoveryService.reconcileProjection")(
    function* (
      originalProjection: ProjectionStore.ProjectionRuntimeRecoveryState,
      trigger: "startup" | "shutdown",
      continueAfterRestart: boolean,
      recoverCallParents: boolean,
    ) {
      const now = yield* DateTime.now;
      const remoteRuns = yield* recoverableRemoteRuns(originalProjection);
      const projection = processBoundProjection(originalProjection, remoteRuns);
      const runs = [] as Array<OrchestrationV2ThreadProjection["runs"][number]>;
      for (const run of nonterminalRuns(projection)) {
        if (run.status === "waiting") {
          const checkpointEffects = yield* outbox
            .listByCommandId(CommandId.make(`command:effect:checkpoint.capture:${run.id}`))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({
                    operation: "reconcile",
                    threadId: projection.thread.id,
                    cause,
                  }),
              ),
            );
          const hasReplayableCheckpoint = checkpointEffects.some(
            (effect) =>
              effect.request.type === "checkpoint.capture" &&
              effect.request.runId === run.id &&
              (effect.status === "pending" || effect.status === "running"),
          );
          if (hasReplayableCheckpoint) continue;
        }
        runs.push(run);
      }
      const messageRequestNodeIds = new Set(
        projection.runtimeRequests
          .filter(
            (request) =>
              request.status === "pending" && request.responseCapability.type === "message",
          )
          .map((request) => request.nodeId),
      );
      const requests = projection.runtimeRequests.filter(
        (request) => request.status === "pending" && request.responseCapability.type !== "message",
      );
      // Delegated task rows, items and nodes stay open: the child settles them.
      const delegatedTaskNodeIds = new Set<string>([
        ...(projection.subagents ?? []).filter(isAppOwnedDelegation).map((subagent) => subagent.id),
        ...(projection.turnItems ?? []).flatMap((item) =>
          item.type === "subagent" && isAppOwnedDelegation(item) ? [item.subagentId] : [],
        ),
      ]);
      const detail = `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:${projection.thread.id}:${DateTime.formatIso(now)}`,
      );
      const allocateEventId = () =>
        ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "reconcile",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      if (recoverCallParents) {
        for (const node of projection.nodes) {
          if (
            node.kind !== "call_parent" ||
            node.runId !== null ||
            !["pending", "starting", "running", "waiting"].includes(node.status)
          )
            continue;
          // The previous process's call is gone. Its delegated children own
          // their lifecycle and history, so only terminalize the call root.
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            nodeId: node.id,
            occurredAt: now,
            payload: { ...node, status: "cancelled", completedAt: now },
          });
        }
      }
      // Background work that outlived its settled turn. The provider transcript
      // cannot record its death, so the next provider turn is told instead.
      // Shutdown records it too: a graceful restart cancels it there first.
      // Keyed by the provider thread that lost the work: only its turns are told.
      const cancelledBackgroundWork = new Map<
        ProviderThreadId,
        Array<OrchestrationV2RestartCancelledBackgroundWork>
      >();
      const cancelledBackgroundNativeIds = new Set<string>();
      const recordCancelledBackgroundWork = (
        providerThreadId: ProviderThreadId | null | undefined,
        work: OrchestrationV2RestartCancelledBackgroundWork,
      ) => {
        if (providerThreadId == null) return;
        const existing = cancelledBackgroundWork.get(providerThreadId);
        if (existing === undefined) cancelledBackgroundWork.set(providerThreadId, [work]);
        else existing.push(work);
      };
      const recordCancelledBackgroundItem = (
        item: OrchestrationV2ThreadProjection["turnItems"][number],
      ) => {
        if (!isBackgroundCapableTurnItemType(item.type)) return;
        const work = cancelledTurnItemWork(item);
        if (work === undefined) return;
        recordCancelledBackgroundWork(
          item.providerThreadId ??
            projection.runs.find((run) => run.id === item.runId)?.providerThreadId,
          work,
        );
        if (item.nativeItemRef?.nativeId != null) {
          cancelledBackgroundNativeIds.add(item.nativeItemRef.nativeId);
        }
      };
      // Queued runs have not started provider work. Preserve their execution
      // identities and order, but require explicit consent before draining them.
      const queuedRuns = [
        ...projection.runs
          .filter((run) => run.status === "waiting" && run.resourceWait === true)
          .toSorted((a, b) => a.ordinal - b.ordinal),
        ...projection.runs
          .filter((run) => run.status === "queued")
          .toSorted((a, b) => (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal)),
      ];
      for (const [index, run] of queuedRuns.entries()) {
        if (run.status === "queued" && run.queueHeld === true && run.queuePosition === index + 1)
          continue;
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...run,
            status: "queued",
            resourceWait: false,
            queueHeld: true,
            queuePosition: index + 1,
          },
        });
      }
      for (const request of requests) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: trigger === "startup" ? "expired" : "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason: `The server ${trigger === "startup" ? "restarted" : "shut down"} before this runtime request was resolved.`,
            },
            resolvedAt: now,
          },
        });
      }
      const expiredRequestIds = new Set(requests.map((request) => request.id));
      const expiredNodeIds = new Set(requests.map((request) => request.nodeId));
      const requestProviderInstanceId = projection.thread.providerInstanceId;
      for (const node of projection.nodes ?? []) {
        if (
          !expiredNodeIds.has(node.id) ||
          node.runId !== null ||
          !isNonterminalNodeStatus(node.status)
        )
          continue;
        events.push({
          id: yield* allocateEventId(),
          type: "node.updated",
          threadId: projection.thread.id,
          nodeId: node.id,
          ...(requestProviderInstanceId === undefined
            ? {}
            : { providerInstanceId: requestProviderInstanceId }),
          occurredAt: now,
          payload: { ...node, status: "cancelled", completedAt: now },
        });
      }
      for (const item of projection.turnItems ?? []) {
        if (
          item.runId !== null ||
          (item.type !== "approval_request" && item.type !== "user_input_request") ||
          !expiredRequestIds.has(item.requestId) ||
          !isNonterminalTurnItemStatus(item.status)
        )
          continue;
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
          ...(requestProviderInstanceId === undefined
            ? {}
            : { providerInstanceId: requestProviderInstanceId }),
          occurredAt: now,
          payload: cancelledItem(item, now),
        });
      }
      for (const run of runs) {
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
        });
        for (const attempt of projection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "cancelled", completedAt: now },
          });
        }
        for (const node of projection.nodes.filter(
          (candidate) =>
            candidate.runId === run.id &&
            !messageRequestNodeIds.has(candidate.id) &&
            !delegatedTaskNodeIds.has(candidate.id) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: "cancelled", completedAt: now },
          });
        }
        for (const providerTurn of projection.providerTurns.filter(
          (candidate) =>
            candidate.runAttemptId !== null &&
            projection.attempts.some(
              (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
            ) &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: providerTurn.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...providerTurn, status: "cancelled", completedAt: now },
          });
        }
        for (const message of projection.messages.filter(
          (candidate) => candidate.runId === run.id && candidate.streaming,
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "message.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...message, streaming: false, updatedAt: now },
          });
        }
        for (const item of projection.turnItems.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.nodeId === null || !messageRequestNodeIds.has(candidate.nodeId)) &&
            !isAppOwnedDelegationItem(candidate) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          // A waiting run's provider turn already settled; its open items are
          // background work. A running run's items die with its turn.
          if (run.status === "waiting") recordCancelledBackgroundItem(item);
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: cancelledItem(item, now),
          });
        }
      }
      // Process loss also orphans background-capable turn items on already-
      // settled runs (e.g. post-settle Waiting work). Skip items already
      // cancelled above for recovered nonterminal runs to avoid duplicate
      // cancellation events.
      const recoveredNonterminalRunIds = new Set(runs.map((run) => run.id));
      const cancelledStaleNodeIds = new Set<string>();
      for (const item of projection.turnItems ?? []) {
        if (item.runId !== null && recoveredNonterminalRunIds.has(item.runId)) {
          continue;
        }
        if (!isBackgroundCapableTurnItemType(item.type)) {
          continue;
        }
        if (!isNonterminalTurnItemStatus(item.status) || isAppOwnedDelegationItem(item)) {
          continue;
        }
        const providerInstanceId = resolveStaleBackgroundItemProviderInstanceId(item, projection);
        recordCancelledBackgroundItem(item);
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
          providerInstanceId,
          occurredAt: now,
          payload: cancelledItem(item, now),
        });
        if (item.nodeId !== null && item.nodeId !== undefined) {
          const staleItemNode = projection.nodes.find(
            (candidate) =>
              candidate.id === item.nodeId && isNonterminalNodeStatus(candidate.status),
          );
          if (staleItemNode !== undefined && !cancelledStaleNodeIds.has(staleItemNode.id)) {
            cancelledStaleNodeIds.add(staleItemNode.id);
            events.push({
              id: yield* allocateEventId(),
              type: "node.updated",
              threadId: projection.thread.id,
              ...(item.runId === null ? {} : { runId: item.runId }),
              nodeId: staleItemNode.id,
              providerInstanceId,
              occurredAt: now,
              payload: { ...staleItemNode, status: "cancelled", completedAt: now },
            });
          }
        }
      }
      // No provider process outlives the server, so a native subagent still open
      // here never reports its end, whatever state its run and item are in.
      for (const subagent of projection.subagents ?? []) {
        events.push(
          ...(yield* endOrphanedNativeSubagent({
            projection,
            subagentId: subagent.id,
            status: "cancelled",
            now,
            emitted: events,
            allocateEventId,
          })),
        );
      }
      // A provider-native subagent thread has no runs; left running, the child
      // would show as working forever.
      events.push(
        ...(yield* endRunlessRootTurns({
          threadId: projection.thread.id,
          providerInstanceId: projection.thread.providerInstanceId,
          projection,
          status: "cancelled",
          now,
          emitted: events,
          allocateEventId,
        })),
      );
      // All provider processes are gone on startup/shutdown: clear any
      // persisted Waiting roster (including idle threads from settled roots)
      // and idle active threads without resurrecting active status.
      for (const providerThread of projection.providerThreads ?? []) {
        const needsIdle = providerThread.status === "active";
        const needsRosterClear = providerThreadHasPendingBackgroundTasks(providerThread);
        if (!needsIdle && !needsRosterClear) {
          continue;
        }
        if (providerThread.ownerNodeId === null) {
          for (const task of providerThread.pendingBackgroundTasks ?? []) {
            if (cancelledBackgroundNativeIds.has(task.taskId)) continue;
            cancelledBackgroundNativeIds.add(task.taskId);
            recordCancelledBackgroundWork(providerThread.id, cancelledRosterTaskWork(task));
          }
        }
        events.push({
          id: yield* allocateEventId(),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...providerThread,
            status: needsIdle ? "idle" : providerThread.status,
            pendingBackgroundTasks: [],
            updatedAt: now,
          },
        });
      }
      for (const session of projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
        });
      }
      for (const [providerThreadId, work] of cancelledBackgroundWork) {
        const noteRun = latestStartedRun(projection, providerThreadId);
        if (noteRun === undefined) continue;
        // Its own event: a run snapshot read before this commit could regress
        // a lifecycle change (e.g. a checkpoint completing the run) made since.
        events.push({
          id: yield* allocateEventId(),
          type: "run.background-work-cancelled",
          threadId: projection.thread.id,
          runId: noteRun.id,
          providerInstanceId: noteRun.providerInstanceId,
          occurredAt: now,
          payload: {
            runId: noteRun.id,
            restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(
              noteRun.restartCancelledBackgroundWork ?? [],
              work,
            ),
          },
        });
      }
      const continuationRun =
        continueAfterRestart && trigger === "startup"
          ? restartContinuationRun(projection)
          : undefined;
      const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = continuationRun
        ? [
            {
              id: `effect:restart-continuation:${continuationRun.id}`,
              commandId,
              threadId: projection.thread.id,
              request: { type: "provider-runtime.continue", sourceRunId: continuationRun.id },
            },
          ]
        : [];
      if (trigger === "startup") {
        for (const run of remoteRuns)
          effects.push({
            id: `effect:remote-reconnect:${run.id}:${run.activeAttemptId}:${DateTime.formatIso(now)}`,
            commandId,
            threadId: originalProjection.thread.id,
            request: { type: "provider-runtime.reconnect", runId: run.id },
          });
      }
      const stoppedSessions = projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      ).length;
      let retiredEffects: number;
      if (events.length === 0) {
        // A reconnect does not change cloud run state. Command receipts require
        // an event sequence, so persist effects through the effects-only sink.
        if (effects.length > 0) {
          yield* eventSink.writeWithEffects({ commandId, events, effects }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        }
        const retiredEffectIds = yield* outbox
          .cancelUnsettled({
            threadId: projection.thread.id,
            effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
            reason: detail,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause: { detail, cause },
                }),
            ),
          );
        yield* outbox.signalCancellations(retiredEffectIds);
        retiredEffects = retiredEffectIds.length;
      } else {
        const result = yield* eventSink
          .commitCommand({
            commandId,
            threadId: projection.thread.id,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events,
            effects,
            cancelUnsettledEffects: {
              effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
              reason: detail,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        retiredEffects = result.cancelledEffectCount;
      }
      return {
        terminalizedRuns: runs.length,
        stoppedSessions,
        closedRequests: requests.length,
        retiredEffects,
      };
    },
  );

  const reconcile = (trigger: "startup" | "shutdown") =>
    Effect.gen(function* () {
      const recoverCallParents = trigger === "startup" && !callParentsRecovered;
      const continueAfterRestart = yield* settings.getSettings.pipe(
        Effect.orElseSucceed(() => null),
      );
      const threadIds = yield* projections
        .getRecoveryThreadIds("runtime")
        .pipe(
          Effect.mapError(
            (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
          ),
        );
      let terminalizedRuns = 0;
      let stoppedSessions = 0;
      let closedRequests = 0;
      let retiredEffects = 0;
      for (const threadId of threadIds) {
        const projection = yield* projections.getRuntimeRecoveryProjection(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "read-projections",
                threadId,
                cause,
              }),
          ),
        );
        const enabled =
          continueAfterRestart !== null &&
          resolveProjectSettings(continueAfterRestart, projection.thread.projectId).settings
            .continueThreadsAfterServerUpdate;
        const result = yield* reconcileProjection(projection, trigger, enabled, recoverCallParents);
        terminalizedRuns += result.terminalizedRuns;
        stoppedSessions += result.stoppedSessions;
        closedRequests += result.closedRequests;
        retiredEffects += result.retiredEffects;
      }
      const outboxReconciliation = yield* outbox.reconcileAfterProcessLoss.pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
        ),
      );
      if (recoverCallParents) callParentsRecovered = true;
      return {
        terminalizedRuns,
        stoppedSessions,
        closedRequests,
        retiredEffects: retiredEffects + outboxReconciliation.cancelled,
        requeuedEffects: outboxReconciliation.requeued,
      } satisfies ProviderRuntimeReconciliationSummary;
    });

  // Snapshot intent only while providers are live. A provider may finish while
  // this commits; reconciliation reads fresh state after shutdown, and delivery
  // rejects any source run that actually completed.
  const prepareForShutdown = Effect.gen(function* () {
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threadIds = yield* projections.getRecoveryThreadIds("runtime");
    for (const threadId of threadIds) {
      yield* Effect.gen(function* () {
        const originalProjection = yield* projections.getRuntimeRecoveryProjection(threadId);
        const projection = processBoundProjection(
          originalProjection,
          yield* recoverableRemoteRuns(originalProjection),
        );
        if (
          !resolveProjectSettings(enabled, projection.thread.projectId).settings
            .continueThreadsAfterServerUpdate
        )
          return;
        const run = restartContinuationRun(projection);
        if (!run) return;
        const commandId = CommandId.make(`command:restart-prepare:${run.id}`);
        yield* eventSink.writeWithEffects({
          commandId,
          events: [],
          effects: [
            {
              id: `effect:restart-continuation:${run.id}`,
              commandId,
              threadId,
              request: { type: "provider-runtime.continue", sourceRunId: run.id },
            },
          ],
        });
      }).pipe(
        // One failing thread must not cost the threads after it their continuation.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Failed to prepare a restart continuation", { threadId, cause }),
        ),
      );
    }
  }).pipe(
    Effect.mapError((cause) => new ProviderRuntimeRecoveryError({ operation: "reconcile", cause })),
  );

  const recover = Effect.gen(function* () {
    const summary = (yield* reconcile("startup")) satisfies ProviderRuntimeRecoverySummary;
    const observers = yield* Effect.serviceOption(GrokBotThreadService.GrokBotThreadService);
    if (Option.isSome(observers)) {
      yield* observers.value.observeAll.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to attach native Grok Bot observation after recovery", {
            cause,
          }),
        ),
      );
    }
    return summary;
  });

  return ProviderRuntimeRecoveryService.of({ reconcile, prepareForShutdown, recover });
});

export const layer = Layer.effect(ProviderRuntimeRecoveryService, make);
