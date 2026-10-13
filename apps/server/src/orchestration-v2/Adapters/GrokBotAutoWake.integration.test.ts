import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  RunId,
  RuntimeRequestId,
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

it.effect.each(["user_follow_up", "user_input", "command"] as const)(
  "sends an automatic wake and restarts the native bot for %s without stopping its child",
  (kind) =>
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
        if (kind === "user_follow_up") {
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
        } else {
          const now = yield* DateTime.now;
          const childId = ThreadId.make("thread:waiting-child");
          const taskId = NodeId.make("task:waiting-child");
          const requestId = RuntimeRequestId.make(`child-attention:${kind}`);
          yield* sink.write({
            events: [
              {
                id: EventId.make("create:waiting-child"),
                type: "thread.created",
                threadId: childId,
                occurredAt: now,
                payload: {
                  createdBy: "agent",
                  creationSource: "server",
                  id: childId,
                  projectId,
                  title: "Child needing attention",
                  providerInstanceId: selection.instanceId,
                  modelSelection: selection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: threadId,
                    relationshipToParent: "subagent",
                    rootThreadId: threadId,
                  },
                  forkedFrom: { type: "node", nodeId: taskId },
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              },
              {
                id: EventId.make("task:waiting-child"),
                type: "subagent.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: taskId,
                  threadId,
                  runId: first.id,
                  parentNodeId: first.rootNodeId!,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver: ProviderDriverKind.make("grok-bot"),
                  providerInstanceId: selection.instanceId,
                  providerThreadId: null,
                  childThreadId: childId,
                  nativeTaskRef: null,
                  prompt: "Need an answer.",
                  title: null,
                  model: null,
                  completionWake: "settled_only",
                  status: "running",
                  result: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                },
              },
            ],
          });
          const after = yield* sink.latestSequence();
          yield* sink.write({
            events: [
              {
                id: EventId.make("pending:waiting-child"),
                type: "runtime-request.updated",
                threadId: childId,
                occurredAt: now,
                payload: {
                  id: requestId,
                  nodeId: taskId,
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind,
                  status: "pending",
                  responseCapability: { type: "not_resumable", reason: "test" },
                  createdAt: now,
                  resolvedAt: null,
                },
              },
            ],
          });
          yield* sink.stream({ threadId, afterSequence: after, eventType: "message.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "message.updated" &&
                stored.event.payload.text.includes(requestId),
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          yield* orchestrator.recoverDelegatedTasks;
          yield* worker.drain();
          const child = yield* orchestrator.getThreadProjection(childId);
          assert.equal(child.runtimeRequests[0]?.status, "pending");
          const updated = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(updated.subagents.find((task) => task.id === taskId)?.status, "running");
          assert.lengthOf(sent, 2);
          assert.include(sent[1]!.text, requestId);
          assert.include(sent[1]!.text, taskId);
          assert.lengthOf(
            updated.messages.filter((message) => message.notification?.detail?.includes(requestId)),
            1,
          );
        }
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
          kind === "user_follow_up" ? 1 : 2,
        );
      }).pipe(
        Effect.provide(
          layerWithRegistry({ name: `grok-bot-auto-wake-${kind}` }, registry, {
            runEffectWorker: false,
            runContinuationWorker: true,
          }),
        ),
      );
    }),
);
