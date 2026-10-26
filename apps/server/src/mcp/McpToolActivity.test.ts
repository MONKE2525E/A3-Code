import * as MergeGit from "../vcs/GitVcsDriver.ts";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, EventId, RunAttemptId, RunId, NodeId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as ManagedState from "../grokBot/GrokBotManagedStateStore.ts";
import * as Authority from "../grokBot/GrokBotMcpAuthority.ts";
import * as Native from "../grokBot/GrokBotNativeRuntimeService.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Ingestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { grokBotTurnIdentity } from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";
import { makeNative, makeTurn } from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Activity from "./McpToolActivity.ts";

const database = Persistence.layerMemory;
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ManagedState.layer).pipe(
  Layer.provideMerge(database),
);
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const dependencies = Layer.mergeAll(sink, stores, IdAllocator.layer, ThreadCommandExecutor.layer);
const ingestor = Ingestor.layer.pipe(
  Layer.provide(Layer.mock(MergeGit.GitVcsDriver)({})),
  Layer.provideMerge(dependencies),
);
const authority = Authority.layer.pipe(
  Layer.provideMerge(stores),
  Layer.provide(Layer.succeed(Native.GrokBotNativeRuntimeService, makeNative())),
);
const layer = Activity.layer.pipe(Layer.provideMerge(Layer.mergeAll(ingestor, authority)));

const harness = Effect.gen(function* () {
  const turn = yield* makeTurn;
  const identity = grokBotTurnIdentity(turn);
  const managed = yield* ManagedState.GrokBotManagedStateStore;
  yield* managed.acquire(identity.native);
  yield* managed.prepareTurn(identity);
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventStore.EventStoreV2;
  const activity = yield* Activity.McpToolActivity;
  const lock = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const at = turn.input.appThread.createdAt;
  const run = {
    id: identity.runId,
    threadId: identity.native.threadId,
    ordinal: identity.runOrdinal,
    providerInstanceId: identity.native.providerInstanceId,
    modelSelection: turn.input.modelSelection,
    providerThreadId: identity.providerThreadId,
    userMessageId: turn.input.message.messageId,
    rootNodeId: identity.rootNodeId,
    activeAttemptId: identity.attemptId,
    status: "running" as const,
    requestedAt: at,
    startedAt: at,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* eventSink.write({
    events: [
      {
        id: EventId.make("activity:thread"),
        type: "thread.created",
        threadId: run.threadId,
        occurredAt: at,
        payload: turn.input.appThread,
      },
      {
        id: EventId.make("activity:provider-thread"),
        type: "provider-thread.updated",
        threadId: run.threadId,
        occurredAt: at,
        payload: turn.input.providerThread,
      },
      {
        id: EventId.make("activity:run"),
        type: "run.updated",
        threadId: run.threadId,
        occurredAt: at,
        payload: run,
      },
    ],
  });
  const scope: Invocation.McpInvocationScope = {
    environmentId: EnvironmentId.make("fixture"),
    issuedAt: 0,
    capabilities: new Set(["orchestration"]),
    requestNamespace: "same-attempt",
    thread: {
      threadId: run.threadId,
      providerInstanceId: run.providerInstanceId,
      // A credential UUID is deliberately different from the real provider session.
      providerSessionId: "credential-only-uuid",
      remoteRun: { runId: run.id, attemptId: identity.attemptId },
    },
    client: undefined,
  };
  const items = () => projections.getThreadRecords(run.threadId, ["turnItems"]);
  const observed = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, caller = scope) =>
    activity
      .observe(name, effect)
      .pipe(Effect.provideService(Invocation.McpInvocationContext, caller));
  return {
    turn,
    identity,
    run,
    at,
    scope,
    items,
    observed,
    activity,
    events,
    projections,
    eventSink,
    lock,
  };
});

it.effect(
  "persists an actual call's running and completed activity with no arguments or result",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const result = yield* h.observed(
        "delegate_task",
        h.lock.withLock(
          h.run.threadId,
          Effect.gen(function* () {
            const { turnItems } = yield* h.items();
            assert.equal(turnItems.length, 1);
            assert.equal(turnItems[0]?.status, "running");
            return "private-result";
          }),
        ),
      );
      assert.equal(result, "private-result");
      const { turnItems } = yield* h.items();
      assert.equal(turnItems.length, 1);
      const item = turnItems[0]!;
      assert.equal(item.status, "completed");
      assert.equal(item.runId, h.run.id);
      assert.equal(item.nodeId, h.identity.rootNodeId);
      assert.equal(item.providerTurnId, h.identity.providerTurnId);
      assert.equal(item.type, "dynamic_tool");
      if (item.type === "dynamic_tool") {
        assert.deepStrictEqual(item.input, {});
        assert.equal(item.output, undefined);
        assert.equal(item.toolName, "delegate_task");
      }
      const recorded = yield* h.events
        .read({ eventType: "turn-item.updated" })
        .pipe(Stream.runCollect);
      assert.deepStrictEqual(
        recorded.flatMap(({ event }) =>
          event.type === "turn-item.updated" ? [event.payload.status] : [],
        ),
        ["running", "completed"],
      );
      assert.equal(JSON.stringify(recorded).includes("private-result"), false);
      assert.equal(JSON.stringify(recorded).includes("credential-only-uuid"), false);
      // Reconstruct the SQL projection reader; activity survives without a live adapter stream.
      const persisted = yield* Effect.gen(function* () {
        const reopened = yield* ProjectionStore.ProjectionStoreV2;
        return yield* reopened.getThreadRecords(h.run.threadId, ["turnItems"]);
      }).pipe(Effect.provide(ProjectionStore.layer));
      assert.equal(persisted.turnItems[0]?.status, "completed");
    }).pipe(Effect.provide(layer)),
);

it.effect("records failure without leaking its message and preserves the handler failure", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const error = { secret: "private-error-body" };
    assert.equal(yield* h.observed("task_status", Effect.fail(error)).pipe(Effect.flip), error);
    assert.equal((yield* h.items()).turnItems[0]?.status, "failed");
    const recorded = yield* h.events
      .read({ eventType: "turn-item.updated" })
      .pipe(Stream.runCollect);
    assert.equal(JSON.stringify(recorded).includes("private-error-body"), false);
  }).pipe(Effect.provide(layer)),
);

it.effect("closes an interrupted observed call and gives each actual request a distinct item", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const started = yield* Deferred.make<void>();
    const fiber = yield* h
      .observed(
        "task_status",
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    yield* h.observed("task_status", Effect.void);
    const { turnItems } = yield* h.items();
    assert.equal(turnItems.length, 2);
    assert.notEqual(turnItems[0]?.id, turnItems[1]?.id);
    assert.deepStrictEqual(turnItems.map((item) => item.status).sort(), [
      "completed",
      "interrupted",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "does not associate local, outside, invalid, or self-completion calls with a managed run",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const caller = h.scope.thread!;
      for (const scope of [
        {
          ...h.scope,
          thread: {
            threadId: caller.threadId,
            providerSessionId: caller.providerSessionId,
            providerInstanceId: caller.providerInstanceId,
          },
        },
        {
          ...h.scope,
          thread: undefined,
          client: { sessionId: "outside", label: "outside", access: "full-access" as const },
        },
        {
          ...h.scope,
          thread: {
            ...caller,
            remoteRun: { runId: h.run.id, attemptId: RunAttemptId.make("different-attempt") },
          },
        },
      ])
        assert.equal(yield* h.observed("task_status", Effect.succeed("result"), scope), "result");
      yield* h.observed("grok_bot_complete_turn", Effect.void);
      yield* h.activity.observe("task_status", Effect.void);
      assert.equal((yield* h.items()).turnItems.length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("closes only the captured item when the tool settles its run or another run starts", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.observed(
      "task_cancel",
      h.lock.withLock(
        h.run.threadId,
        h.eventSink.write({
          events: [
            {
              id: EventId.make("activity:settle"),
              type: "run.updated",
              threadId: h.run.threadId,
              occurredAt: h.at,
              payload: { ...h.run, status: "completed", completedAt: h.at },
            },
            {
              id: EventId.make("activity:next-run"),
              type: "run.updated",
              threadId: h.run.threadId,
              occurredAt: h.at,
              payload: {
                ...h.run,
                id: RunId.make("later-run"),
                rootNodeId: NodeId.make("later-root"),
                activeAttemptId: RunAttemptId.make("later-attempt"),
                ordinal: 2,
              },
            },
          ],
        }),
      ),
    );
    const item = (yield* h.items()).turnItems[0]!;
    assert.equal(item.status, "completed");
    assert.equal(item.runId, h.run.id);
    assert.equal(item.nodeId, h.identity.rootNodeId);
    yield* h.observed("task_status", Effect.void);
    assert.equal((yield* h.items()).turnItems.length, 1);
  }).pipe(Effect.provide(layer)),
);
