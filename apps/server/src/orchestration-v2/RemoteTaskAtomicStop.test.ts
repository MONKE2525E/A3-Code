import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5" };
const modes = { runtimeMode: "approval-required", interactionMode: "plan" } as const;
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Atomic stop tests never start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "remote-atomic-stop" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const send = Effect.fn("test.send")(function* (threadId: ThreadId, text: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${threadId}:${text}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${text}`),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "web",
  });
});

const setup = Effect.fn("test.setup")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make("thread:remote-root");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:root"),
    threadId,
    projectId: ProjectId.make("project:remote-atomic-stop"),
    title: "Owned remote task",
    modelSelection,
    ...modes,
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* send(threadId, "owned root");
  const root = yield* orchestrator.getThreadProjection(threadId);
  const initial = root.runs[0]!;
  yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("delegate:child"),
    parentThreadId: threadId,
    parentRunId: initial.id,
    parentNodeId: initial.rootNodeId!,
    task: "owned child",
    modelSelection,
    ...modes,
    completionWake: "always",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const parent = yield* orchestrator.getThreadProjection(threadId);
  const childThreadId = parent.subagents[0]!.childThreadId!;
  const child = yield* orchestrator.getThreadProjection(childThreadId);
  const command = {
    type: "remote-task.stop",
    commandId: CommandId.make("atomic-stop"),
    threadId,
    initialRunId: initial.id,
    ...modes,
    expectedThreads: [parent, child].map((projection) => ({
      threadId: projection.thread.id,
      runIds: projection.runs.map((run) => run.id),
      subagentIds: projection.subagents.map((task) => task.id),
    })),
  } satisfies OrchestrationV2Command;
  return { orchestrator, threadId, childThreadId, command };
});

it.effect.each(["pending", "running"] as const)(
  "atomically cancels %s startup, restart and reconnect effects only for the validated cohort",
  (status) =>
    Effect.gen(function* () {
      const { orchestrator, threadId, childThreadId, command } = yield* setup();
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      // Keep this fixture's claims limited to the provider operations Stop must cancel.
      yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE effect_type != 'provider-turn.start'`;
      if (status === "running") {
        for (const _id of [threadId, childThreadId]) {
          const claimed = yield* outbox.claimNext({
            workerId: "startup-worker",
            leaseDurationMs: 60000,
          });
          assert.isTrue(Option.isSome(claimed));
          if (Option.isSome(claimed))
            assert.equal(claimed.value.request.type, "provider-turn.start");
        }
      }
      for (const id of [threadId, childThreadId]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        const run = projection.runs[0]!;
        yield* outbox.enqueue([
          {
            id: `restart:${id}`,
            commandId: CommandId.make(`restart:${id}`),
            threadId: id,
            request: {
              type: "provider-turn.restart",
              runId: run.id,
              providerSessionId: ProviderSessionId.make(`session:${id}`),
              providerThreadId: run.providerThreadId!,
              providerTurnId: ProviderTurnId.make(`turn:${id}`),
              interruptedAttemptId: run.activeAttemptId!,
            },
          },
          {
            id: `reconnect:${id}`,
            commandId: CommandId.make(`reconnect:${id}`),
            threadId: id,
            request: { type: "provider-runtime.reconnect", runId: run.id },
          },
        ]);
      }
      const targets = yield* sql<{
        effect_id: string;
      }>`SELECT effect_id FROM orchestration_v2_effect_outbox`;
      assert.lengthOf(targets, 6);
      yield* outbox.enqueue([
        {
          id: "unrelated-start",
          commandId: CommandId.make("unrelated-start"),
          threadId: ThreadId.make("thread:unrelated"),
          request: { type: "provider-turn.start", runId: RunId.make("run:unrelated") },
        },
        {
          id: "unrelated-type",
          commandId: CommandId.make("unrelated-type"),
          threadId,
          request: { type: "scheduled-tasks.cleanup" },
        },
      ]);
      const cancellations = targets.map(({ effect_id }) => outbox.awaitCancellation(effect_id));
      yield* orchestrator.dispatch(command);
      const cancelled = yield* sql<{ effect_id: string; status: string }>`
      SELECT effect_id, status FROM orchestration_v2_effect_outbox
      WHERE effect_id IN ${sql.in(targets.map(({ effect_id }) => effect_id))}
    `;
      assert.isTrue(cancelled.every((effect) => effect.status === "cancelled"));
      yield* Effect.all(cancellations);
      const untouched = yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_v2_effect_outbox WHERE effect_id IN ('unrelated-start', 'unrelated-type')`;
      assert.deepEqual(
        untouched.map((effect) => effect.status),
        ["pending", "pending"],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "root-run",
  "child-run",
  "runtime",
  "interaction",
  "new-child",
  "missing-child",
  "initial-run",
] as const)("rejects changed %s after preflight without any stop events or effects", (change) =>
  Effect.gen(function* () {
    const { orchestrator, threadId, childThreadId, command } = yield* setup();
    if (change === "root-run" || change === "child-run") {
      yield* send(change === "root-run" ? threadId : childThreadId, "unrelated new work");
    } else if (change === "runtime") {
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise"),
        threadId: childThreadId,
        runtimeMode: "full-access",
      });
    } else if (change === "interaction") {
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("raise"),
        threadId: childThreadId,
        interactionMode: "default",
      });
    } else if (change === "new-child") {
      const root = yield* orchestrator.getThreadProjection(threadId);
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate:late"),
        parentThreadId: threadId,
        parentRunId: root.runs[0]!.id,
        parentNodeId: root.runs[0]!.rootNodeId!,
        task: "late child",
        modelSelection,
        ...modes,
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
    }
    const before = yield* orchestrator.getThreadProjection(threadId);
    const childBefore = yield* orchestrator.getThreadProjection(childThreadId);
    const refusal = yield* orchestrator
      .dispatch({
        ...command,
        ...(change === "missing-child"
          ? { expectedThreads: command.expectedThreads.slice(0, 1) }
          : {}),
        ...(change === "initial-run" ? { initialRunId: RunId.make("not-owned") } : {}),
      })
      .pipe(Effect.flip);
    assert.equal(refusal._tag, "OrchestratorCommandRejectedError");
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
    assert.deepEqual(yield* orchestrator.getThreadProjection(childThreadId), childBefore);
    const sql = yield* SqlClient.SqlClient;
    assert.lengthOf(
      yield* sql`SELECT * FROM orchestration_v2_effect_outbox WHERE command_id = ${command.commandId}`,
      0,
    );
    assert.lengthOf(
      yield* sql`SELECT sequence FROM orchestration_v2_events WHERE command_id = ${command.commandId}`,
      0,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "stops an exact owned continuation and children, cancels queued runs, and schedules no subtree walk",
  () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, childThreadId, command } = yield* setup();
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const root = yield* orchestrator.getThreadProjection(threadId);
      const initial = root.runs[0]!;
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:original-ended"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...initial, status: "cancelled", completedAt: now },
      });
      yield* send(threadId, "owned continuation");
      const continued = yield* orchestrator.getThreadProjection(threadId);
      const continuation = continued.runs.at(-1)!;
      yield* projections.apply({
        id: EventId.make("event:continuation"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...continuation, restartContinuationOfRunId: initial.id },
      });
      yield* send(threadId, "owned queued work");
      yield* send(childThreadId, "owned child queue");
      const expectedThreads = [];
      for (const id of [threadId, childThreadId]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        expectedThreads.push({
          threadId: id,
          runIds: projection.runs.map((run) => run.id),
          subagentIds: projection.subagents.map((task) => task.id),
        });
      }
      const result = yield* orchestrator.dispatch({ ...command, expectedThreads });
      assert.isAbove(result.storedEvents.length, 0);
      for (const id of [threadId, childThreadId]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isTrue(
          projection.runs.every((run) => ["interrupted", "cancelled"].includes(run.status)),
        );
      }
      const sql = yield* SqlClient.SqlClient;
      const effects = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${command.commandId}`;
      assert.isFalse(
        effects.some((row) => JSON.parse(row.payload_json).type === "delegated-tasks.stop"),
      );
    }).pipe(Effect.provide(layerTest)),
);
