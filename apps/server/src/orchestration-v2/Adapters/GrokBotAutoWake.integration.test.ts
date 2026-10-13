import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  GrokBotNativeRuntimeService,
  type Turn,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { createGrokBotAdapterV2 } from "./GrokBotAdapterV2.ts";
import { GrokBotManagedBinding } from "./GrokBotManagedBinding.ts";
import {
  makeBindings,
  makeNative,
  makeTurn,
  options,
  selection,
  threadId,
} from "./GrokBotProvider.testkit.ts";

it.effect(
  "sends an automatic wake to the native bot and settles a superseded turn on user follow-up",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeTurn;
      const sent: Turn[] = [];
      let interrupts = 0;
      const native = makeNative({
        startTurn: (turn) =>
          Effect.sync(() => {
            sent.push(turn);
            return { delivery: "accepted" as const };
          }),
        interrupt: () =>
          Effect.sync(() => {
            interrupts++;
            return { hadActiveRun: true };
          }),
      });
      const bindings = makeBindings(fixture, {
        prepareTurn: (request) =>
          Effect.succeed({
            ...fixture,
            native: request.native,
            input: request.turn,
            messageId: request.turn.message.messageId,
            nativePrompt: request.turn.message.text,
            providerTurnId: request.providerTurnId,
          }),
      });
      const registry = Layer.effect(
        Registry.ProviderAdapterRegistryV2,
        createGrokBotAdapterV2(options).pipe(
          Effect.map((adapter) =>
            Registry.ProviderAdapterRegistryV2.of({
              get: () => Effect.succeed(adapter),
              list: () => Effect.succeed([options.instanceId]),
            }),
          ),
          Effect.provideService(GrokBotNativeRuntimeService, native),
          Effect.provideService(GrokBotManagedBinding, bindings),
        ),
      ).pipe(Layer.provide(IdAllocator.layer));
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const projectId = ProjectId.make("project:auto-wake");
        const sourceId = ThreadId.make("thread:bot-sent-work");
        for (const id of [threadId, sourceId])
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${id}`),
            threadId: id,
            projectId,
            title: "Auto wake",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "mcp",
          });
        const now = yield* DateTime.now;
        const sourceRunId = RunId.make("run:bot-sent-work");
        const sourceMessageId = MessageId.make("message:bot-sent-work");
        const after = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            {
              id: EventId.make("source:message"),
              type: "message.updated",
              threadId: sourceId,
              occurredAt: now,
              payload: {
                id: sourceMessageId,
                threadId: sourceId,
                runId: sourceRunId,
                nodeId: null,
                role: "user",
                text: "Do the work",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "mcp",
                senderThreadId: threadId,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("source:completed"),
              type: "run.updated",
              threadId: sourceId,
              occurredAt: now,
              payload: {
                id: sourceRunId,
                threadId: sourceId,
                ordinal: 1,
                providerInstanceId: selection.instanceId,
                modelSelection: selection,
                providerThreadId: null,
                userMessageId: sourceMessageId,
                rootNodeId: NodeId.make("source:root"),
                activeAttemptId: null,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
        yield* sink.stream({ threadId, afterSequence: after, eventType: "message.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "message.updated" &&
              stored.event.payload.notification !== undefined,
          ),
          Stream.runHead,
        );
        yield* worker.drain();
        yield* sink
          .stream({ threadId, afterSequence: after, eventType: "provider-turn.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "pending",
            ),
            Stream.runHead,
          );
        assert.lengthOf(sent, 1);
        assert.include(sent[0]!.text, sourceRunId);
        const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        assert.equal(first.status, "running");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("user:follow-up"),
          threadId,
          messageId: MessageId.make("user:follow-up"),
          text: "Continue with my new instruction",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(interrupts, 1);
        assert.lengthOf(sent, 2);
        assert.equal(
          projection.attempts.find((attempt) => attempt.id === first.activeAttemptId)?.status,
          "superseded",
        );
        assert.notEqual(
          projection.runs.find((run) => run.id === first.id)?.activeAttemptId,
          first.activeAttemptId,
        );
        assert.equal(projection.runs.find((run) => run.id === first.id)?.status, "running");
        assert.lengthOf(
          projection.messages.filter((message) => message.notification !== undefined),
          1,
        );
      }).pipe(
        Effect.provide(
          layerWithRegistry({ name: "grok-bot-auto-wake" }, registry, {
            runEffectWorker: false,
            runContinuationWorker: true,
          }),
        ),
      );
    }),
);
