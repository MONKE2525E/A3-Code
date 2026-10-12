import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it, vi } from "vite-plus/test";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

it("reports a disk-full recovery commit without requeueing provider effects", async () => {
  const threadId = ThreadId.make("thread_recovery_disk_full");
  const sqliteFailure = Object.assign(new Error("database or disk is full"), {
    errcode: 13,
    errstr: "database or disk is full",
  });
  const persistenceFailure = toPersistenceSqlError(
    "OrchestrationEventStore.appendAgentEvents:insert",
  )(new Error("Failed to execute statement", { cause: sqliteFailure }));
  const writeFailure = new EventSink.EventSinkWriteError({
    eventCount: 1,
    cause: persistenceFailure,
  });
  const projection = {
    thread: { id: threadId, providerInstanceId: ProviderInstanceId.make("codex") },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: TurnItemId.make("turn_item_recovery_disk_full"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        type: "command_execution",
        status: "running",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const commitCommand = vi.fn(() => Effect.fail(writeFailure));
  const reconcileOutbox = vi.fn(() => ({ requeued: 1, cancelled: 0 }));
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand }),
        IdAllocator.layer,
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.sync(reconcileOutbox),
        }),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover.pipe(
        Effect.flip,
      );
    expect(error).toBeInstanceOf(ProviderRuntimeRecovery.ProviderRuntimeRecoveryError);
    expect(error.operation).toBe("reconcile");
    expect(error.threadId).toBe(threadId);
    expect(error.message).toBe("Provider runtime recovery failed during reconcile.");
    expect(error.cause).toBe(writeFailure);
    expect(writeFailure.cause).toBe(persistenceFailure);
    expect(persistenceFailure.message).toContain("SQLITE(13) database or disk is full");
    expect(persistenceFailure.cause).toHaveProperty("cause", sqliteFailure);
    expect(commitCommand).toHaveBeenCalledOnce();
    expect(reconcileOutbox).not.toHaveBeenCalled();
    expect(projection.turnItems[0]?.status).toBe("running");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("uses the thread provider for stale background work without provider threads", async () => {
  const threadId = ThreadId.make("thread_recovery_background_no_provider_threads");
  const runId = RunId.make("run_recovery_background_no_provider_threads");
  const itemId = TurnItemId.make("turn_item_recovery_background_no_provider_threads");
  const providerInstanceId = ProviderInstanceId.make("codex");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId, providerInstanceId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [{ id: runId, status: "completed", providerInstanceId }],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: itemId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        type: "command_execution",
        status: "running",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  await Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const event = committedInput?.events.find(
      (candidate) => candidate.type === "turn-item.updated",
    );
    expect(event?.providerInstanceId).toBe(providerInstanceId);
    expect(event?.type === "turn-item.updated" ? event.payload.status : null).toBe("cancelled");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
