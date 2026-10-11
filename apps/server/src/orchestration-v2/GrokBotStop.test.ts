import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ProjectId } from "@t3tools/contracts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { GROK_BOT_DRIVER_KIND, GrokBotCapabilitiesV2 } from "./Adapters/GrokBotAdapterV2.ts";
import { instanceId, selection, threadId } from "./Adapters/GrokBotProvider.testkit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";

const adapter: ProviderAdapterV2["Service"] = {
  instanceId,
  driver: GROK_BOT_DRIVER_KIND,
  getCapabilities: () => Effect.succeed(GrokBotCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("The cloud observer is absent in this test."),
};
const database = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  Harness.layerWithRegistry({ name: "grok-bot-stop" }, Registry.layerFromAdapters([adapter]), {
    databaseLayer: database,
    runEffectWorker: false,
  }),
  ProjectionStore.layer.pipe(Layer.provide(database)),
);

it.effect("does not pretend a cloud bot stopped when its local observer is absent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cloud-stop:thread"),
      threadId,
      projectId: ProjectId.make("cloud-stop-project"),
      title: "Cloud bot",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("cloud-stop:message"),
      threadId,
      messageId: MessageId.make("cloud-stop:input"),
      text: "Approved bot task",
      attachments: [],
      modelSelection: selection,
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    });
    const before = yield* orchestrator.getThreadProjection(threadId);
    const run = before.runs[0]!;
    for (const status of ["starting", "running"] as const) {
      yield* projections.apply({
        id: EventId.make(`cloud-stop:${status}`),
        type: "run.updated",
        threadId,
        occurredAt: run.requestedAt,
        payload: { ...run, status },
      });
      for (const command of [
        {
          type: "run.interrupt",
          commandId: CommandId.make(`cloud-stop:${status}:interrupt`),
          threadId,
          runId: run.id,
        },
        {
          type: "thread.stop",
          commandId: CommandId.make(`cloud-stop:${status}:thread-stop`),
          threadId,
        },
      ] as const) {
        if (command.type === "run.interrupt") {
          const error = yield* Effect.flip(orchestrator.dispatch(command));
          assert.equal(error._tag, "OrchestratorDispatchError");
        } else {
          yield* orchestrator.dispatch(command);
        }
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs[0]?.status, status);
        assert.equal(
          after.turnItems.some((item) => item.type === "run_interrupt_result"),
          false,
        );
      }
    }
  }).pipe(Effect.provide(layer)),
);
