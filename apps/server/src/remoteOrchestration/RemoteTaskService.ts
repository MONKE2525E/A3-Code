import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  OrchestrationV2ThreadLaunchInput,
  OrchestratorMcpDelegatedTaskStatus,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestratorMcpDelegateTaskResult,
  ProviderRequestKind,
  RuntimeMode,
  ProviderInteractionMode,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  delegatedTaskProgress,
  subagentResultForRun,
} from "@t3tools/provider-core/server/subagentProjection";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerRegistry from "./PeerEnvironmentRegistry.ts";
import * as RemoteClient from "./RemoteEnvironmentClient.ts";

export class RemoteTaskError extends Schema.TaggedError<RemoteTaskError>()("RemoteTaskError", {
  reason: Schema.Literals([
    "task_not_found",
    "storage",
    "invalid_request",
    "mode_exceeded",
    "destination_reused",
    "cancel_blocked",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "task_not_found":
        return "Remote task was not found for this parent thread.";
      case "storage":
        return "Unable to read or persist remote task state.";
      case "mode_exceeded":
        return "Cancellation exceeds the current caller or original task authority; cancellation was not sent.";
      case "destination_reused":
        return "Remote thread contains unrelated work; cancellation was not sent.";
      case "cancel_blocked":
        return "Destination cannot safely cancel this task; guarded cancellation was not accepted.";
      case "invalid_request":
        return "Remote task requires a paired destination and an initial message.";
    }
  }
}

const CancellationLimits = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type RemoteTaskCancellationLimits = typeof CancellationLimits.Type;
const ranks = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };
const within = (actual: RemoteTaskCancellationLimits, ceiling: RemoteTaskCancellationLimits) =>
  ranks[actual.runtimeMode] <= ranks[ceiling.runtimeMode] &&
  (ceiling.interactionMode !== "plan" || actual.interactionMode === "plan");

function cohort(projection: OrchestrationV2ThreadProjection, initial: RunId) {
  const owned = new Set([initial]);
  for (const run of projection.runs.toSorted((a, b) => a.ordinal - b.ordinal)) {
    const message = projection.messages.find((message) => message.id === run.userMessageId);
    if (
      (message?.delegatedCompletion && owned.has(message.delegatedCompletion.parentRunId)) ||
      (run.restartContinuationOfRunId && owned.has(run.restartContinuationOfRunId))
    )
      owned.add(run.id);
  }
  return owned;
}

const Reachability = Schema.Literals(["online", "offline", "unauthorized", "removed"]);
const StopPlan = Schema.Struct({
  commandId: Schema.optional(CommandId),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  initialRunId: RunId,
  expectedThreads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      runIds: Schema.Array(RunId),
      subagentIds: Schema.Array(NodeId),
    }),
  ),
});
const Record = Schema.Struct({
  taskId: NodeId,
  parentThreadId: ThreadId,
  parentRunId: RunId,
  requestId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
  launch: OrchestrationV2ThreadLaunchInput,
  remoteThreadId: ThreadId,
  remoteRunId: Schema.NullOr(RunId),
  resultRunId: Schema.NullOr(RunId),
  workState: OrchestratorMcpDelegateTaskResult.fields.workState,
  hasPendingChildRuns: Schema.Boolean,
  pendingApproval: OrchestratorMcpDelegateTaskResult.fields.pendingApproval,
  phase: Schema.Literals(["launching", "launched", "terminal"]),
  status: OrchestratorMcpDelegatedTaskStatus,
  reachability: Reachability,
  summary: Schema.NullOr(Schema.String),
  hasPendingQuestion: Schema.Boolean,
  cancelRequested: Schema.Boolean,
  cancelLimits: Schema.NullOr(CancellationLimits).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  stopAttempt: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  stopPlan: Schema.NullOr(StopPlan).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  stopSent: Schema.Boolean,
  delivery: Schema.Literals(["pending", "wait", "wake", "delivered", "disposed"]),
  unavailableSince: Schema.NullOr(Schema.Number),
  offlineWakeSent: Schema.Boolean,
  unauthorizedWakeSent: Schema.Boolean,
});
type TaskRecord = typeof Record.Type;
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(Record));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Record));
export type RemoteTaskResult = OrchestratorMcpDelegateTaskResult & {
  readonly environmentId: EnvironmentId;
  readonly reachability: typeof Reachability.Type;
};
type DelegateInput = {
  readonly parentThreadId: ThreadId;
  readonly parentRunId: RunId;
  readonly requestId: string;
  readonly environmentId: EnvironmentId;
  readonly launch: OrchestrationV2ThreadLaunchInput;
};

export class RemoteTaskService extends Context.Service<
  RemoteTaskService,
  {
    readonly delegate: (input: DelegateInput) => Effect.Effect<RemoteTaskResult, RemoteTaskError>;
    readonly existing: (
      parentThreadId: ThreadId,
      requestId: string,
    ) => Effect.Effect<RemoteTaskResult | null, RemoteTaskError>;
    readonly status: (
      parentThreadId: ThreadId,
      taskId: NodeId,
    ) => Effect.Effect<RemoteTaskResult, RemoteTaskError>;
    readonly cancel: (
      parentThreadId: ThreadId,
      taskId: NodeId,
      limits: RemoteTaskCancellationLimits,
    ) => Effect.Effect<RemoteTaskResult, RemoteTaskError>;
    readonly wait: (
      parentThreadId: ThreadId,
      taskId: NodeId,
      timeoutMs: number,
    ) => Effect.Effect<RemoteTaskResult, RemoteTaskError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/remoteOrchestration/RemoteTaskService") {}

function view(row: TaskRecord): RemoteTaskResult {
  const terminal = row.phase === "terminal";
  return {
    taskId: row.taskId,
    childThreadId: row.remoteThreadId,
    childRunId: row.remoteRunId,
    childNodeId: row.taskId,
    status: row.status,
    workState: terminal ? "result_available" : row.workState,
    hasPendingChildRuns: !terminal && row.hasPendingChildRuns,
    latestTerminalRunId: terminal ? row.resultRunId : null,
    latestTerminalStatus:
      terminal &&
      (row.status === "completed" ||
        row.status === "failed" ||
        row.status === "cancelled" ||
        row.status === "interrupted")
        ? row.status
        : null,
    latestTerminalSummary: terminal ? row.summary : null,
    latestTerminalResultContextTransferId: null,
    providerInstanceId: row.launch.modelSelection.instanceId,
    model: row.launch.modelSelection.model,
    ...(row.launch.modelSelection.options ? { options: row.launch.modelSelection.options } : {}),
    summary: row.summary,
    resultContextTransferId: null,
    hasPendingQuestion: !terminal && row.hasPendingQuestion,
    pendingApproval: terminal ? null : row.pendingApproval,
    waitTimedOut: false,
    title: row.launch.title,
    environmentId: row.environmentId,
    reachability: row.reachability,
  };
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const registry = yield* PeerRegistry.PeerEnvironmentRegistry;
  const remote = yield* RemoteClient.RemoteEnvironmentClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const identity = yield* ServerEnvironment.ServerEnvironment;
  const localId = yield* identity.getEnvironmentId;
  const lock = yield* Semaphore.make(1);
  const directory = path.join(config.stateDir, "remote-tasks");
  const storageError = () => new RemoteTaskError({ reason: "storage" });
  yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(storageError));
  const rows = new Map<NodeId, TaskRecord>();
  const completed = new Map<NodeId, Deferred.Deferred<void>>();
  const changes = new Map<NodeId, Deferred.Deferred<void>>();
  const nudges = new Map<NodeId, Queue.Queue<void>>();
  let lifetime: Scope.Scope | undefined;
  const running = new Set<NodeId>();
  const filename = (id: NodeId) => path.join(directory, `${id.slice("remote-task:".length)}.json`);
  for (const name of yield* fs.readDirectory(directory).pipe(Effect.mapError(storageError))) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const raw = yield* fs
      .readFileString(path.join(directory, name))
      .pipe(Effect.mapError(storageError));
    const row = yield* decodeRecord(raw).pipe(Effect.mapError(storageError));
    if (filename(row.taskId) !== path.join(directory, name)) return yield* storageError();
    rows.set(row.taskId, row);
  }
  const write = Effect.fn("RemoteTaskService.write")(function* (row: TaskRecord) {
    const contents = yield* encodeRecord(row).pipe(Effect.mapError(storageError));
    yield* writeFileStringAtomically({ filePath: filename(row.taskId), contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(storageError),
    );
    rows.set(row.taskId, row);
    const changed = changes.get(row.taskId);
    if (changed) {
      changes.set(row.taskId, yield* Deferred.make<void>());
      yield* Deferred.succeed(changed, undefined);
    }
    if (row.phase === "terminal") {
      const done = completed.get(row.taskId);
      if (done) yield* Deferred.succeed(done, undefined);
    }
    return row;
  });
  const update = Effect.fn("RemoteTaskService.update")(
    (id: NodeId, change: (row: TaskRecord) => TaskRecord) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          const row = rows.get(id);
          return row
            ? write(change(row))
            : Effect.fail(new RemoteTaskError({ reason: "task_not_found" }));
        }),
      ),
  );
  const owned = Effect.fn("RemoteTaskService.owned")(function* (parent: ThreadId, id: NodeId) {
    const row = rows.get(id);
    if (!row || row.parentThreadId !== parent)
      return yield* new RemoteTaskError({ reason: "task_not_found" });
    return row;
  });

  const notify = Effect.fn("RemoteTaskService.notify")(function* (
    row: TaskRecord,
    kind: "terminal" | "offline" | "unauthorized" | "cancel_blocked",
  ) {
    const parent = yield* threads.getThreadShell(row.parentThreadId);
    if (!parent || parent.archivedAt !== null || parent.deletedAt !== null) {
      if (kind === "terminal")
        yield* update(row.taskId, (current) => ({ ...current, delivery: "disposed" }));
      return;
    }
    const summary =
      kind === "cancel_blocked"
        ? row.summary ||
          "Cancellation withheld: destination authority or unrelated work prevents a safe stop."
        : kind === "terminal"
          ? row.summary || `Remote task ${row.status}.`
          : kind === "offline"
            ? "Remote environment is offline; the task may still be running."
            : "Remote environment requires authorization; the task may still be running.";
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${row.taskId}:wake:${kind}`),
      messageId: MessageId.make(`${row.taskId}:wake:${kind}`),
      threadId: row.parentThreadId,
      createdBy: "agent",
      creationSource: "server",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      text: `${kind === "terminal" ? row.status : kind} on ${row.label}: ${summary}\nRemote thread: ${row.remoteThreadId} (environment ${row.environmentId}).`,
      notification: {
        source: {
          kind: "delegated_task",
          taskIds: [row.taskId],
        },
        outcome:
          kind === "terminal"
            ? row.status === "completed"
              ? "completed"
              : row.status === "cancelled" || row.status === "interrupted"
                ? "cancelled"
                : "failed"
            : "updated",
        summary,
      },
    });
  });
  const deliver = Effect.fn("RemoteTaskService.deliver")(function* (id: NodeId) {
    const row = yield* update(id, (current) =>
      current.phase === "terminal" && current.delivery === "pending"
        ? { ...current, delivery: "wake" }
        : current,
    );
    if (row.phase === "terminal" && row.delivery === "wake") {
      yield* notify(row, "terminal");
      yield* update(id, (current) =>
        current.delivery === "wake" ? { ...current, delivery: "delivered" } : current,
      );
    }
  });
  const fullProjection = Effect.fn("RemoteTaskService.fullProjection")(function* (
    client: RemoteClient.RemoteEnvironmentRpcClient,
    threadId: ThreadId,
  ) {
    // The legacy complete snapshot RPC restores both old assistant output and continuation inputs.
    const snapshot = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
      threadId,
      acceptBoundedSnapshot: false,
      acceptCompactTurnItems: false,
    }).pipe(
      Stream.filter((event) => event.kind === "snapshot"),
      Stream.runHead,
    );
    if (
      Option.isNone(snapshot) ||
      snapshot.value.kind !== "snapshot" ||
      snapshot.value.hasMoreHistory === true ||
      snapshot.value.projection.thread.id !== threadId
    ) {
      return yield* new RemoteClient.RemoteEnvironmentError({ reason: "invalid_response" });
    }
    return snapshot.value.projection;
  });
  const readProjection = Effect.fn("RemoteTaskService.readProjection")(function* (
    client: RemoteClient.RemoteEnvironmentRpcClient,
    threadId: ThreadId,
  ) {
    const projection = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
    return projection.runs.some((run) =>
      ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status),
    )
      ? yield* fullProjection(client, threadId)
      : projection;
  });
  const failDeleted = (id: NodeId) =>
    update(id, (row) => ({
      ...row,
      phase: "terminal",
      status: "failed",
      workState: "result_available",
      hasPendingChildRuns: false,
      hasPendingQuestion: false,
      pendingApproval: null,
      summary: "Remote thread was deleted.",
    }));
  const refresh = Effect.fn("RemoteTaskService.refresh")(function* (
    id: NodeId,
    client: RemoteClient.RemoteEnvironmentRpcClient,
  ) {
    const row = rows.get(id);
    if (!row) return null;
    return yield* readProjection(client, row.remoteThreadId).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (error._tag !== "OrchestrationV2GetThreadProjectionError") return yield* error;
          // Only the unmarked initial inventory is authoritative. Enrichment snapshots contain no threads.
          // Projection success always wins over shell caches, and archived threads have a separate inventory.
          const initial = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
            Stream.filter(
              (event) =>
                event.kind === "snapshot" && event.resolvedRepositoryIdentityRoots === undefined,
            ),
            Stream.runHead,
          );
          if (
            Option.isNone(initial) ||
            initial.value.kind !== "snapshot" ||
            [...initial.value.snapshot.threads, ...initial.value.snapshot.archivedThreads].some(
              (thread) => thread.id === row.remoteThreadId,
            )
          )
            return yield* error;
          const archived = yield* client[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});
          if (archived.threads.some((thread) => thread.id === row.remoteThreadId))
            return yield* error;
          yield* failDeleted(id);
          return null;
        }),
      ),
    );
  });
  const validateCancellation = Effect.fn("RemoteTaskService.validateCancellation")(function* (
    row: TaskRecord,
    limits: RemoteTaskCancellationLimits,
    client: RemoteClient.RemoteEnvironmentRpcClient,
    projection: OrchestrationV2ThreadProjection,
  ) {
    if (!within(row.launch, limits)) return yield* new RemoteTaskError({ reason: "mode_exceeded" });
    const expectedThreads: (typeof StopPlan.Type)["expectedThreads"][number][] = [];
    const visited = new Set<ThreadId>();
    const pending = [{ projection, initial: row.remoteRunId }];
    while (pending.length > 0) {
      const entry = pending.pop();
      if (!entry || visited.has(entry.projection.thread.id)) continue;
      const { projection, initial } = entry;
      visited.add(projection.thread.id);
      if (!within(projection.thread, row.launch) || !within(projection.thread, limits))
        return yield* new RemoteTaskError({ reason: "mode_exceeded" });
      const first = initial ?? projection.runs.find((run) => run.ordinal === 1)?.id;
      const owned = first ? cohort(projection, first) : new Set<RunId>();
      // Reject unrelated work before freezing the exact destination transaction cohort.
      if (
        projection.runs.some((run) => !owned.has(run.id)) ||
        projection.subagents.some((task) => task.runId === null || !owned.has(task.runId))
      )
        return yield* new RemoteTaskError({ reason: "destination_reused" });
      expectedThreads.push({
        threadId: projection.thread.id,
        runIds: projection.runs.map((run) => run.id),
        subagentIds: projection.subagents.map((task) => task.id),
      });
      for (const task of projection.subagents) {
        if (
          task.origin === "app_owned" &&
          task.childThreadId !== null &&
          !visited.has(task.childThreadId)
        ) {
          pending.push({
            projection: yield* fullProjection(client, task.childThreadId),
            initial: null,
          });
        }
      }
    }
    return expectedThreads;
  });

  const observe = Effect.fn("RemoteTaskService.observe")(function* (
    id: NodeId,
    projection: OrchestrationV2ThreadProjection,
  ) {
    const row = rows.get(id);
    if (!row || row.phase === "terminal") return;
    if (projection.thread.id !== row.remoteThreadId)
      return yield* new RemoteClient.RemoteEnvironmentError({ reason: "identity_mismatch" });
    // The initial launch owns ordinal one; later user turns can never replace its result.
    const run = row.remoteRunId
      ? projection.runs.find((run) => run.id === row.remoteRunId)
      : projection.runs.find((run) => run.ordinal === 1);
    if (!run) return;
    if (run.threadId !== row.remoteThreadId) return;
    const ownedRuns = cohort(projection, run.id);
    const runs = projection.runs.filter((candidate) => ownedRuns.has(candidate.id));
    const subagents = projection.subagents.filter(
      (task) => task.runId !== null && ownedRuns.has(task.runId),
    );
    const providerThreadIds = new Set(runs.map((run) => run.providerThreadId));
    const progress = delegatedTaskProgress({
      runs,
      subagents,
      messages: projection.messages.filter(
        (message) => message.runId !== null && ownedRuns.has(message.runId),
      ),
      providerThreads: projection.providerThreads.filter((thread) =>
        providerThreadIds.has(thread.id),
      ),
    });
    const terminal = progress.state === "result_available";
    const resultRun = progress.resultRun ?? run;
    const status = !terminal
      ? run.status === "queued"
        ? "queued"
        : "running"
      : resultRun.status === "rolled_back"
        ? "cancelled"
        : resultRun.status === "preparing" || resultRun.status === "starting"
          ? "running"
          : resultRun.status;
    const summary = terminal
      ? subagentResultForRun(projection, resultRun).text.slice(-16_000)
      : row.summary;
    const requests = projection.runtimeRequests.filter(
      (request) =>
        request.status === "pending" &&
        request.responseCapability.type === "live" &&
        projection.nodes.some(
          (node) => node.id === request.nodeId && node.runId !== null && ownedRuns.has(node.runId),
        ),
    );
    const approval = requests.find((request) => isApprovalRequestKind(request.kind));
    const approvalRunId = approval
      ? projection.nodes.find((node) => node.id === approval.nodeId)?.runId
      : null;
    const pendingApproval =
      !terminal && approval && isApprovalRequestKind(approval.kind) && approvalRunId
        ? { requestId: approval.id, kind: approval.kind, runId: approvalRunId }
        : null;
    yield* update(id, (current) => ({
      ...current,
      remoteRunId: run.id,
      resultRunId: terminal ? resultRun.id : null,
      phase: terminal ? "terminal" : "launched",
      status,
      summary,
      workState: progress.state,
      hasPendingChildRuns: progress.state === "waiting_for_children",
      pendingApproval,
      hasPendingQuestion: !terminal && requests.some((request) => request.kind === "user_input"),
    }));
  });
  const unavailable = Effect.fn("RemoteTaskService.unavailable")(function* (
    id: NodeId,
    reason: "offline" | "unauthorized",
  ) {
    const now = yield* Clock.currentTimeMillis;
    const row = yield* update(id, (current) => ({
      ...current,
      reachability: reason,
      unavailableSince: current.unavailableSince ?? now,
    }));
    if (reason === "unauthorized" && !row.unauthorizedWakeSent) {
      yield* notify(row, "unauthorized");
      yield* update(id, (current) => ({ ...current, unauthorizedWakeSent: true }));
    } else if (
      reason === "offline" &&
      !row.offlineWakeSent &&
      now - (row.unavailableSince ?? now) >= 600_000
    ) {
      yield* notify(row, "offline");
      yield* update(id, (current) => ({ ...current, offlineWakeSent: true }));
    }
  });
  const session = Effect.fn("RemoteTaskService.session")(
    function* (id: NodeId) {
      const row = rows.get(id);
      if (!row) return;
      if (row.phase === "terminal") return yield* deliver(id);
      const peer = yield* registry.get(row.environmentId);
      const { client, config } = yield* remote.connect(peer);
      yield* update(id, (current) => ({
        ...current,
        reachability: "online",
        unavailableSince: null,
      }));
      if (row.phase === "launching") {
        const result = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread](row.launch);
        if (result.threadId !== row.remoteThreadId)
          return yield* new RemoteClient.RemoteEnvironmentError({ reason: "identity_mismatch" });
      }
      const projection = yield* refresh(id, client);
      if (projection === null) return yield* deliver(id);
      yield* observe(id, projection);
      const current = rows.get(id);
      if (!current) return;
      if (current.phase === "terminal") return yield* deliver(id);
      if (current.cancelLimits && !current.stopSent) {
        const limits = current.cancelLimits;
        yield* Effect.gen(function* () {
          if (config.environment.capabilities.remoteTaskStop !== true)
            return yield* new RemoteTaskError({ reason: "cancel_blocked" });
          let plan = current.stopPlan;
          if (plan === null) {
            const complete = yield* fullProjection(client, current.remoteThreadId);
            const expectedThreads = yield* validateCancellation(current, limits, client, complete);
            const initialRunId =
              current.remoteRunId ?? complete.runs.find((run) => run.ordinal === 1)?.id;
            if (!initialRunId) return yield* new RemoteTaskError({ reason: "cancel_blocked" });
            plan = {
              commandId: CommandId.make(`${id}:stop:${current.stopAttempt + 1}`),
              initialRunId,
              expectedThreads,
              runtimeMode:
                ranks[limits.runtimeMode] < ranks[current.launch.runtimeMode]
                  ? limits.runtimeMode
                  : current.launch.runtimeMode,
              interactionMode:
                limits.interactionMode === "plan" || current.launch.interactionMode === "plan"
                  ? "plan"
                  : "default",
            };
            // Freeze before dispatch: a lost reply must replay the identical transaction and receipt.
            yield* update(id, (row) => ({
              ...row,
              stopPlan: plan,
              stopAttempt: row.stopAttempt + 1,
              cancelRequested: true,
            }));
          }
          yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "remote-task.stop",
            threadId: current.remoteThreadId,
            ...plan,
            commandId: plan.commandId ?? CommandId.make(`${id}:stop`),
          }).pipe(
            Effect.catchTags({
              OrchestrationV2DispatchCommandError: (error) =>
                error.outcome === "rejected"
                  ? update(id, (row) => ({ ...row, stopPlan: null, cancelRequested: false })).pipe(
                      Effect.andThen(
                        Effect.fail(new RemoteTaskError({ reason: "cancel_blocked" })),
                      ),
                    )
                  : Effect.fail(error),
            }),
          );
        }).pipe(
          Effect.tapError((error) => {
            if (error._tag !== "RemoteTaskError") return Effect.void;
            return update(id, (row) => ({
              ...row,
              summary: error.message,
              cancelLimits: null,
              cancelRequested: row.stopPlan !== null,
            })).pipe(Effect.flatMap((row) => notify(row, "cancel_blocked")));
          }),
        );
        yield* update(id, (row) => ({ ...row, stopSent: true }));
      }
      const nudge = nudges.get(id);
      if (!nudge) return;
      const watch = client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
        Stream.runForEach((event) => {
          if (event.kind === "thread.removed" && event.threadId === row.remoteThreadId) {
            return failDeleted(id).pipe(Effect.asVoid);
          }
          if (
            event.kind === "snapshot" ||
            (event.kind === "thread.updated" && event.thread.id === row.remoteThreadId)
          ) {
            return refresh(id, client).pipe(
              Effect.flatMap((projection) =>
                projection === null ? Effect.void : observe(id, projection),
              ),
            );
          }
          return Effect.void;
        }),
      );
      const done = completed.get(id);
      const restart = yield* Effect.raceFirst(
        watch,
        Effect.raceFirst(
          Queue.take(nudge).pipe(Effect.as(true)),
          done ? Deferred.await(done) : Effect.never,
        ),
      ).pipe(
        // Periodically renew the registry lookup, including peer removal, without reading projections on a timer.
        Effect.timeoutOption("30 seconds"),
      );
      yield* deliver(id);
      return Option.isSome(restart) && restart.value === true;
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "45 seconds",
      orElse: () => Effect.fail(new RemoteClient.RemoteEnvironmentError({ reason: "unavailable" })),
    }),
  );

  const recover = Effect.fn("RemoteTaskService.recover")(function* (id: NodeId) {
    const nudge = nudges.get(id);
    if (!nudge) return;
    while (true) {
      const restart = yield* session(id).pipe(
        Effect.catch((error) => {
          if (error._tag === "RemotePeerError" && error.reason === "not_paired") {
            return update(id, (row) => ({
              ...row,
              phase: "terminal",
              status: "failed",
              reachability: "removed",
              summary: `Peer removed; the remote thread may still be running on ${row.label}.`,
            })).pipe(
              Effect.flatMap(() => deliver(id)),
              Effect.ignore,
            );
          }
          if (
            error._tag === "RemoteTaskError" &&
            (error.reason === "mode_exceeded" ||
              error.reason === "destination_reused" ||
              error.reason === "cancel_blocked")
          )
            return Effect.void;
          if (rows.get(id)?.phase === "terminal") return Effect.void;
          return unavailable(
            id,
            error._tag === "EnvironmentAuthorizationError" ||
              (error._tag === "RemoteEnvironmentError" && error.reason === "unauthorized")
              ? "unauthorized"
              : "offline",
          ).pipe(Effect.ignore);
        }),
      );
      const row = rows.get(id);
      if (
        !row ||
        (row.phase === "terminal" && row.delivery !== "pending" && row.delivery !== "wake")
      )
        return;
      if (restart !== true) yield* Queue.take(nudge).pipe(Effect.timeoutOption("5 seconds"));
    }
  });
  const ensureWorker = Effect.fn("RemoteTaskService.ensureWorker")(function* (id: NodeId) {
    if (!lifetime || running.has(id)) return;
    running.add(id);
    if (!completed.has(id)) completed.set(id, yield* Deferred.make<void>());
    if (!nudges.has(id)) nudges.set(id, yield* Queue.make<void>());
    yield* recover(id).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          running.delete(id);
        }),
      ),
      Effect.forkIn(lifetime),
    );
  });
  const taskIdFor = Effect.fn("RemoteTaskService.taskId")(function* (
    parentThreadId: ThreadId,
    requestId: string,
  ) {
    const key = [localId, parentThreadId, requestId]
      .map((part) => `${part.length}:${part}`)
      .join("");
    const bytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(key))
      .pipe(Effect.mapError(storageError));
    return NodeId.make(
      `remote-task:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    );
  });
  return RemoteTaskService.of({
    existing: Effect.fn("RemoteTaskService.existing")(function* (parent, requestId) {
      const row = rows.get(yield* taskIdFor(parent, requestId));
      return row ? view(row) : null;
    }),
    delegate: Effect.fn("RemoteTaskService.delegate")(function* (input) {
      const initialMessage = input.launch.initialMessage;
      if (!input.requestId.trim() || !initialMessage)
        return yield* new RemoteTaskError({ reason: "invalid_request" });
      const id = yield* taskIdFor(input.parentThreadId, input.requestId);
      const digest = id.slice("remote-task:".length);
      const row = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = rows.get(id);
          if (existing) return existing;
          const peer = yield* registry
            .get(input.environmentId)
            .pipe(Effect.mapError(() => new RemoteTaskError({ reason: "invalid_request" })));
          const remoteThreadId = ThreadId.make(`remote-task:${digest}`);
          return yield* write({
            taskId: id,
            parentThreadId: input.parentThreadId,
            parentRunId: input.parentRunId,
            environmentId: input.environmentId,
            requestId: input.requestId,
            label: peer.label,
            remoteThreadId,
            remoteRunId: null,
            resultRunId: null,
            workState: "working",
            hasPendingChildRuns: false,
            pendingApproval: null,
            launch: {
              ...input.launch,
              commandId: CommandId.make(`${id}:launch`),
              threadId: remoteThreadId,
              reuseExistingThread: false,
              initialMessage: { ...initialMessage, messageId: MessageId.make(`${id}:initial`) },
            },
            phase: "launching",
            status: "queued",
            reachability: "offline",
            summary: null,
            hasPendingQuestion: false,
            cancelRequested: false,
            cancelLimits: null,
            stopAttempt: 0,
            stopPlan: null,
            stopSent: false,
            delivery: "pending",
            unavailableSince: null,
            offlineWakeSent: false,
            unauthorizedWakeSent: false,
          });
        }),
      );
      yield* ensureWorker(id);
      return view(row);
    }),
    status: Effect.fn("RemoteTaskService.status")(function* (parent, id) {
      let row = yield* owned(parent, id);
      if (row.phase === "terminal" && row.delivery === "pending")
        row = yield* update(id, (row) =>
          row.phase === "terminal" && row.delivery === "pending"
            ? { ...row, delivery: "wait" }
            : row,
        );
      return view(row);
    }),
    cancel: Effect.fn("RemoteTaskService.cancel")(function* (parent, id, limits) {
      const original = yield* owned(parent, id);
      if (original.phase === "terminal") return view(original);
      if (!within(original.launch, limits))
        return yield* new RemoteTaskError({ reason: "mode_exceeded" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const peer = yield* registry.get(original.environmentId);
          const { client, config } = yield* remote.connect(peer);
          if (config.environment.capabilities.remoteTaskStop !== true)
            return yield* new RemoteTaskError({ reason: "cancel_blocked" });
          yield* validateCancellation(
            original,
            limits,
            client,
            yield* fullProjection(client, original.remoteThreadId),
          );
        }),
      ).pipe(
        Effect.timeoutOption("10 seconds"),
        Effect.catch((error) =>
          error._tag === "RemoteTaskError"
            ? update(id, (row) => ({ ...row, summary: error.message })).pipe(
                Effect.flatMap((row) => notify(row, "cancel_blocked")),
                Effect.ignore,
                Effect.andThen(Effect.fail(error)),
              )
            : Effect.void,
        ),
      );
      // Offline intent is durable, but only fresh destination preflight may authorize the stop.
      const row = yield* update(id, (row) =>
        row.phase === "terminal" ? row : { ...row, cancelLimits: limits },
      );
      yield* ensureWorker(id);
      const nudge = nudges.get(id);
      if (nudge) yield* Queue.offer(nudge, undefined);
      return view(row);
    }),
    wait: Effect.fn("RemoteTaskService.wait")(function* (parent, id, timeoutMs) {
      yield* owned(parent, id);
      const awaiting = Effect.gen(function* () {
        while (true) {
          const row = yield* owned(parent, id);
          if (row.phase === "terminal" || row.hasPendingQuestion || row.pendingApproval !== null)
            return;
          let changed = changes.get(id);
          if (!changed) {
            changed = yield* Deferred.make<void>();
            changes.set(id, changed);
          }
          yield* Deferred.await(changed);
        }
      });
      const result = yield* awaiting.pipe(
        Effect.timeoutOption(Math.max(0, Math.min(timeoutMs, 300_000))),
      );
      let row = yield* owned(parent, id);
      if (row.phase === "terminal")
        row = yield* update(id, (row) =>
          row.delivery === "pending" ? { ...row, delivery: "wait" } : row,
        );
      return {
        ...view(row),
        waitTimedOut:
          Option.isNone(result) &&
          row.phase !== "terminal" &&
          !row.hasPendingQuestion &&
          row.pendingApproval === null,
      };
    }),
    start: Effect.gen(function* () {
      if (lifetime) return;
      lifetime = yield* Effect.scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          lifetime = undefined;
        }),
      );
      for (const row of rows.values()) {
        if (row.phase !== "terminal" || row.delivery === "pending" || row.delivery === "wake")
          yield* ensureWorker(row.taskId);
      }
    }),
  });
});

export const layer = Layer.effect(RemoteTaskService, make);
