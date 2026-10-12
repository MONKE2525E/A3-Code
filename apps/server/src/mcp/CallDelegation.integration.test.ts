import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Recovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Access from "./McpToolAccess.ts";
import * as Mcp from "./OrchestratorMcpService.ts";
import * as Metadata from "./ThreadMetadataMcpService.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as Handlers from "./toolkits/orchestrator/handlers.ts";
import * as Direct from "../grokBot/voiceRouting/GrokBotVoiceOrchestration.ts";
import * as Bridge from "../grokBot/voiceRouting/GrokBotVoiceT3Bridge.ts";
import * as BotThreads from "../grokBot/GrokBotThreadService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import * as Launches from "../orchestration-v2/ThreadLaunchService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Config from "../config.ts";
import {
  createVoiceCallSession,
  type VoiceSocket,
} from "../../../../packages/client-runtime/src/grokBotVoice/callSession.ts";

// JSON conversion sits at the synchronous client socket boundary.
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeTask = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeFailure = Schema.decodeUnknownEffect(OrchestratorMcpFailure);
const decodeFrames = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      type: Schema.String,
      item: Schema.optional(
        Schema.Struct({
          type: Schema.String,
          name: Schema.optional(Schema.String),
          output: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const selection = { instanceId, model: "child-model" };
const parentThreadId = ThreadId.make("grok-bot:call-delegation");
const identity = {
  environmentId: EnvironmentId.make("call-environment"),
  accountId: "account",
  botId: "bot",
  callId: "call-one",
  threadId: parentThreadId,
  access: "approval-required",
} as const;
const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-11T00:00:00.000Z",
    models: [{ slug: selection.model, name: "Child", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
];

// Real event sink, SQLite projections, command receipts and effect worker; only provider I/O is a fixture.
// A non-repository temporary workspace makes checkpoint capture skip Git writes entirely.
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "call-delegation-" });
  const turns: Array<{
    readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
    readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  }> = [];
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: input.modelSelection.model,
            capabilities: ClaudeProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              turns.push({ turn, events });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const adapters = ProviderAdapterRegistry.layerSingle(adapter);
  const replay = ProviderReplayHarness.layerWithRegistry({ name: "call-delegation" }, adapters, {
    runEffectWorker: false,
  });
  const orchestration = Layer.mergeAll(
    replay,
    Layer.mergeAll(Projections.layer, EventStore.layer, CommandReceiptStore.layer).pipe(
      Layer.provide(SqlitePersistence.layerMemory),
    ),
    ThreadManagement.layer.pipe(
      Layer.provide(replay),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
  );
  const services = Mcp.layer.pipe(
    Layer.provideMerge(orchestration),
    Layer.provide(
      Layer.mergeAll(
        adapters,
        ProviderRegistryMock.layer(providers),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        ServerSettings.layerTest(),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        NodeServices.layer,
      ),
    ),
  );
  const serviceScope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(services, serviceScope);
  yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));
  const checkedContext = yield* Layer.build(
    Access.HandlersLayer.layer(Handlers.layer).pipe(
      Layer.provideMerge(Layer.succeed(Metadata.ThreadMetadataMcpService, {} as never)),
    ),
  );
  const all = Context.merge(context, checkedContext);
  const ready = yield* OrchestratorToolkit.pipe(Effect.provide(all));
  const service = Context.get(context, Mcp.OrchestratorMcpService);
  const orchestrator = Context.get(context, Orchestrator.OrchestratorV2);
  const worker = Context.get(context, EffectWorker.OrchestrationEffectWorkerV2);
  const threads = Context.get(context, ThreadManagement.ThreadManagementService);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-parent"),
    threadId: parentThreadId,
    projectId: ProjectId.make("call-project"),
    title: "Call conversation",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
    createdBy: "user",
    creationSource: "web",
  });
  const invoke = (
    scope: Invocation.McpInvocationScope,
    name: "delegate_task" | "task_status" | "task_cancel" | "create_threads",
    input: unknown,
  ) =>
    Effect.gen(function* () {
      const stream = yield* ready.handle(name, input as never, "tool-call");
      const last = yield* Stream.runLast(stream);
      assert.isTrue(Option.isSome(last));
      if (Option.isNone(last)) return yield* Effect.die("missing checked tool result");
      return last.value;
    }).pipe(Effect.provide(all), Effect.provideService(Invocation.McpInvocationContext, scope));
  const delegate = (scope: Invocation.McpInvocationScope, key = "delegate") =>
    Effect.gen(function* () {
      const result = yield* invoke(scope, "delegate_task", {
        task: "Inspect call authority",
        mode: "async",
        clientRequestId: key,
        target: { providerInstanceId: instanceId, model: selection.model },
      });
      assert.isFalse(result.isFailure);
      return yield* decodeTask(result.encodedResult);
    });
  const expectDenied = (
    scope: Invocation.McpInvocationScope,
    name: Parameters<typeof invoke>[1],
    input: unknown,
    code: OrchestratorMcpFailure["code"],
  ) =>
    Effect.gen(function* () {
      const result = yield* invoke(scope, name, input);
      assert.isTrue(result.isFailure);
      const failure = yield* decodeFailure(result.encodedResult);
      assert.equal(failure.code, code);
    });
  const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
    orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  const start = (task: typeof OrchestratorMcpDelegateTaskResult.Type) =>
    Effect.gen(function* () {
      const running = yield* watch(
        (event) =>
          event.type === "provider-turn.updated" &&
          event.threadId === task.childThreadId &&
          event.payload.status === "running",
      );
      yield* worker.drain();
      yield* Fiber.join(running);
      return turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
    });
  const finish = (task: typeof OrchestratorMcpDelegateTaskResult.Type) =>
    Effect.gen(function* () {
      const child = turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
      const projection = yield* orchestrator.getThreadProjection(task.childThreadId);
      const providerTurn = projection.providerTurns[0]!;
      const now = yield* DateTime.now;
      const terminal = yield* watch(
        (event) =>
          event.type === "subagent.updated" &&
          event.payload.id === task.taskId &&
          event.payload.result === "Child result",
      );
      yield* Queue.offer(child.events, {
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: TurnItemId.make(`answer:${task.taskId}`),
          threadId: task.childThreadId,
          runId: child.turn.runId,
          nodeId: child.turn.rootNodeId,
          providerThreadId: providerTurn.providerThreadId,
          providerTurnId: providerTurn.id,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make(`answer:${task.taskId}`),
          text: "Child result",
          streaming: false,
        },
      });
      const waiting = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === child.turn.runId &&
          event.payload.status === "waiting",
      );
      yield* Queue.offer(child.events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...providerTurn, status: "completed", completedAt: now },
      });
      yield* Queue.offer(child.events, {
        type: "turn.terminal",
        driver,
        providerThreadId: providerTurn.providerThreadId,
        providerTurnId: providerTurn.id,
        runOrdinal: child.turn.runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(waiting);
      yield* worker.drain();
      yield* Fiber.join(terminal);
    });
  return {
    service,
    orchestrator,
    worker,
    threads,
    turns,
    invoke,
    delegate,
    expectDenied,
    start,
    finish,
    context,
    serviceScope,
  };
}).pipe(Effect.provide(NodeServices.layer));

it.effect("startup recovers an idle persisted call once without starting a provider", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const scope = yield* h.service.acquireCallInvocation(identity);
      const store = Context.get(h.context, Projections.ProjectionStoreV2);
      assert.include(yield* store.getRecoveryThreadIds("runtime"), parentThreadId);
      assert.equal(
        (yield* store.getRuntimeRecoveryProjection(parentThreadId)).nodes.find(
          (node) => node.id === scope.call?.parentNodeId,
        )?.status,
        "running",
      );
      const recovery = yield* Recovery.make.pipe(
        Effect.provide(h.context),
        Effect.provide(IdAllocator.layer),
        Effect.provide(ServerSettings.layerTest()),
      );
      const events = Context.get(h.context, EventStore.EventStoreV2);
      const beforeSequence = yield* events.latestSequence({ threadId: parentThreadId });
      yield* recovery.recover;
      yield* h.orchestrator.recoverDelegatedTasks;
      const parent = yield* h.orchestrator.getThreadProjection(parentThreadId);
      assert.equal(
        parent.nodes.find((node) => node.id === scope.call?.parentNodeId)?.status,
        "cancelled",
      );
      assert.isNotNull(
        parent.nodes.find((node) => node.id === scope.call?.parentNodeId)?.completedAt,
      );
      assert.lengthOf(parent.runs, 0);
      assert.lengthOf(parent.attempts, 0);
      assert.lengthOf(parent.providerTurns, 0);
      assert.lengthOf(parent.messages, 0);
      assert.lengthOf(h.turns, 0);
      assert.notInclude(yield* store.getRecoveryThreadIds("runtime"), parentThreadId);
      const committed = yield* events
        .read({ threadId: parentThreadId, afterSequence: beforeSequence })
        .pipe(Stream.runCollect);
      assert.lengthOf(committed, 1);
      assert.equal(committed[0]?.event.type, "node.updated");
      assert.isNotNull(committed[0]?.commandId);
      const receipt = yield* Context.get(
        h.context,
        CommandReceiptStore.CommandReceiptStoreV2,
      ).getByCommandId(committed[0]!.commandId!);
      assert.isTrue(Option.isSome(receipt));
      if (Option.isSome(receipt)) {
        assert.equal(receipt.value.commandType, "provider-runtime.reconcile");
        assert.equal(receipt.value.status, "accepted");
      }
      yield* recovery.recover;
      assert.equal(
        yield* events.latestSequence({ threadId: parentThreadId }),
        committed[0]!.sequence,
      );

      // The same service's later recovery passes must not revoke a new live call.
      yield* h.service.releaseCallInvocation(scope);
      const live = yield* h.service.acquireCallInvocation({
        ...identity,
        callId: "live-after-boot",
      });
      yield* recovery.recover;
      yield* h.orchestrator.recoverDelegatedTasks;
      yield* h.service.validateCallInvocation(live);
      assert.equal(
        (yield* h.orchestrator.getThreadProjection(parentThreadId)).nodes.find(
          (node) => node.id === live.call?.parentNodeId,
        )?.status,
        "running",
      );
      assert.lengthOf(h.turns, 0);
    }),
  ),
);

it.effect(
  "call-parent recovery retains completed history and independently running child work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const scope = yield* h.service.acquireCallInvocation(identity);
        const completed = yield* h.delegate(scope, "completed-before-crash");
        yield* h.start(completed);
        yield* h.finish(completed);
        const pending = yield* h.delegate(scope, "pending-before-crash");
        yield* h.start(pending);
        const parentBefore = yield* h.orchestrator.getThreadProjection(parentThreadId);
        const childBefore = yield* h.orchestrator.getThreadProjection(completed.childThreadId);
        const pendingBefore = yield* h.orchestrator.getThreadProjection(pending.childThreadId);
        const store = Context.get(h.context, Projections.ProjectionStoreV2);
        // Isolate recovery of the parent. Actual process-bound child recovery is
        // independent; ending the call must not cancel a surviving child's work.
        const recovery = yield* Recovery.make.pipe(
          Effect.provideService(Projections.ProjectionStoreV2, {
            ...store,
            getRecoveryThreadIds: (kind) =>
              store
                .getRecoveryThreadIds(kind)
                .pipe(
                  Effect.map((threadIds) =>
                    threadIds.filter((threadId) => threadId === parentThreadId),
                  ),
                ),
          }),
          Effect.provide(h.context),
          Effect.provide(IdAllocator.layer),
          Effect.provide(ServerSettings.layerTest()),
        );
        yield* recovery.recover;
        yield* h.orchestrator.recoverDelegatedTasks;
        const parentAfter = yield* h.orchestrator.getThreadProjection(parentThreadId);
        assert.equal(
          parentAfter.nodes.find((node) => node.id === scope.call?.parentNodeId)?.status,
          "cancelled",
        );
        assert.deepEqual(parentAfter.subagents, parentBefore.subagents);
        assert.deepEqual(parentAfter.turnItems, parentBefore.turnItems);
        assert.deepEqual(parentAfter.contextTransfers, parentBefore.contextTransfers);
        assert.deepEqual(
          parentAfter.nodes.filter((node) => node.id !== scope.call?.parentNodeId),
          parentBefore.nodes.filter((node) => node.id !== scope.call?.parentNodeId),
        );
        const childAfter = yield* h.orchestrator.getThreadProjection(completed.childThreadId);
        assert.deepEqual(childAfter.messages, childBefore.messages);
        assert.deepEqual(childAfter.turnItems, childBefore.turnItems);
        assert.deepEqual(childAfter.runs, childBefore.runs);
        const pendingAfter = yield* h.orchestrator.getThreadProjection(pending.childThreadId);
        assert.equal(pendingAfter.thread.lineage.parentThreadId, parentThreadId);
        assert.equal(pendingAfter.runs[0]?.id, pendingBefore.runs[0]?.id);
        assert.deepEqual(pendingAfter.runs, pendingBefore.runs);
        assert.equal(pendingAfter.runs[0]?.status, "running");
        assert.deepEqual(pendingAfter.nodes, pendingBefore.nodes);
        assert.lengthOf(parentAfter.runs, 0);
        assert.lengthOf(parentAfter.attempts, 0);
        assert.lengthOf(parentAfter.providerTurns, 0);
        // Only the explicitly started children ran; recovery started no provider.
        assert.lengthOf(h.turns, 2);
        yield* h.worker.drain();
        assert.lengthOf(h.turns, 2);
        yield* h.finish(pending);
        const landed = yield* h.orchestrator.getThreadProjection(parentThreadId);
        assert.equal(
          landed.subagents.find((task) => task.id === pending.taskId)?.status,
          "completed",
        );
        assert.equal(
          landed.subagents.find((task) => task.id === pending.taskId)?.result,
          "Child result",
        );
        assert.equal(
          landed.nodes.find((node) => node.id === scope.call?.parentNodeId)?.status,
          "cancelled",
        );
      }),
    ),
);

it.effect(
  "an idle call delegates through checked MCP with a real runless V2 parent and terminal wait",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const scope = yield* h.service.acquireCallInvocation(identity);
        assert.strictEqual(yield* h.service.acquireCallInvocation(identity), scope);
        assert.isUndefined(scope.thread);
        const task = yield* h.delegate(scope);
        assert.equal((yield* h.delegate(scope)).taskId, task.taskId);
        const parent = yield* h.orchestrator.getThreadProjection(parentThreadId);
        assert.lengthOf(parent.runs, 0);
        assert.lengthOf(parent.attempts, 0);
        assert.lengthOf(parent.providerTurns, 0);
        assert.lengthOf(parent.messages, 0);
        const parentNode = parent.nodes.find((node) => node.id === scope.call?.parentNodeId)!;
        assert.equal(parentNode.kind, "call_parent");
        assert.equal(parentNode.runId, null);
        assert.equal(parent.subagents[0]?.parentNodeId, parentNode.id);
        assert.equal(parent.subagents[0]?.runId, null);
        const child = yield* h.start(task);
        assert.equal(child.turn.threadId, task.childThreadId);
        assert.deepEqual(child.turn.modelSelection, selection);
        const childProjection = yield* h.orchestrator.getThreadProjection(task.childThreadId);
        assert.equal(childProjection.thread.lineage.parentThreadId, parentThreadId);
        assert.equal(childProjection.thread.runtimeMode, "approval-required");
        assert.equal(childProjection.thread.forkedFrom?.type, "node");
        assert.lengthOf(h.turns, 1);
        const waiter = yield* h.service
          .waitForTask(scope, task.taskId, 20_000)
          .pipe(Effect.forkScoped);
        yield* h.finish(task);
        const result = yield* Fiber.join(waiter);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "Child result");
        assert.isFalse(result.waitTimedOut);
        const status = yield* h.invoke(scope, "task_status", { taskId: task.taskId });
        assert.isFalse(status.isFailure);
        yield* h.service.releaseCallInvocation(scope);
        yield* h.service.releaseCallInvocation(scope);
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(parentThreadId)).nodes.find(
            (node) => node.id === parentNode.id,
          )?.status,
          "completed",
        );
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(task.childThreadId)).turnItems.find(
            (item) => item.type === "assistant_message",
          )?.text,
          "Child result",
        );
      }),
    ),
);

it.effect("checked call tools enforce ownership, client ceiling, ended and new-call denial", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const scope = yield* h.service.acquireCallInvocation(identity);
      yield* h.expectDenied(
        scope,
        "delegate_task",
        { task: "Escalate", runtimeMode: "full-access" },
        "runtime_mode_escalation_denied",
      );
      yield* h.expectDenied(
        scope,
        "create_threads",
        { threads: [{ prompt: "Ordinary thread" }] },
        "thread_credential_required",
      );
      const task = yield* h.delegate(scope);
      yield* h.start(task);
      const readAlias = yield* h.service.restrictCallInvocation(scope, "read-only");
      yield* h.service.validateCallInvocation(readAlias);
      assert.strictEqual(yield* h.service.restrictCallInvocation(scope, "read-only"), readAlias);
      yield* h.expectDenied(
        readAlias,
        "delegate_task",
        { task: "Read-only delegation" },
        "capability_denied",
      );
      yield* h.expectDenied(readAlias, "task_status", { taskId: task.taskId }, "capability_denied");
      assert.equal(
        (yield* h.service.waitForTask(readAlias, task.taskId, 20_000).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* h.service
          .restrictCallInvocation(readAlias, "approval-required")
          .pipe(Effect.result))._tag,
        "Failure",
      );
      for (const forged of [
        { ...scope, environmentId: EnvironmentId.make("other-environment") },
        { ...scope, call: { ...scope.call!, accountId: "other-account" } },
        { ...scope, call: { ...scope.call!, botId: "other-bot" } },
        { ...scope, call: { ...scope.call!, callId: "other-call" } },
        { ...scope, client: { ...scope.client!, access: "full-access" as const } },
      ])
        yield* h.expectDenied(forged, "task_status", { taskId: task.taskId }, "parent_not_active");
      const waiter = yield* h.service
        .waitForTask(scope, task.taskId, 20_000)
        .pipe(Effect.result, Effect.forkScoped);
      yield* h.service.releaseCallInvocation(scope);
      const deniedWait = yield* Fiber.join(waiter);
      assert.equal(deniedWait._tag, "Failure");
      for (const name of ["task_status", "task_cancel"] as const)
        yield* h.expectDenied(scope, name, { taskId: task.taskId }, "parent_not_active");
      yield* h.expectDenied(scope, "delegate_task", { task: "Ended call" }, "parent_not_active");
      assert.equal(
        (yield* h.service.validateCallInvocation(readAlias).pipe(Effect.result))._tag,
        "Failure",
      );
      const newScope = yield* h.service.acquireCallInvocation({ ...identity, callId: "call-two" });
      for (const name of ["task_status", "task_cancel"] as const)
        yield* h.expectDenied(newScope, name, { taskId: task.taskId }, "task_not_found");
      const newTask = yield* h.delegate(newScope);
      yield* h.start(newTask);
      assert.notEqual(newTask.taskId, task.taskId);
      const cancelled = yield* h.invoke(newScope, "task_cancel", { taskId: newTask.taskId });
      assert.isFalse(cancelled.isFailure);
      yield* h.worker.drain();
      const stopped = yield* h.service.taskStatus(newScope, newTask.taskId);
      assert.equal(stopped.status, "interrupted");
      yield* h.finish(task);
      assert.equal(
        (yield* h.orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (entry) => entry.id === task.taskId,
        )?.result,
        "Child result",
      );
      assert.lengthOf((yield* h.orchestrator.getThreadProjection(parentThreadId)).runs, 0);
    }),
  ),
);

it.effect(
  "a call never borrows an active provider run and leaves provider active-run checks intact",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const scope = yield* h.service.acquireCallInvocation(identity);
        const { call: _call, ...providerFields } = scope;
        const provider: Invocation.McpInvocationScope = {
          ...providerFields,
          client: undefined,
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session",
            providerInstanceId: instanceId,
          },
        };
        yield* h.expectDenied(
          provider,
          "delegate_task",
          { task: "No active provider run" },
          "parent_not_active",
        );
        yield* h.orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-provider"),
          threadId: parentThreadId,
          messageId: MessageId.make("start-provider"),
          text: "Independent provider work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const active = (yield* h.orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        const callTask = yield* h.delegate(scope);
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === callTask.taskId,
          )?.runId,
          null,
        );
        yield* h.expectDenied(
          {
            ...provider,
            thread: {
              ...provider.thread!,
              providerInstanceId: ProviderInstanceId.make("unrelated-provider"),
            },
          },
          "delegate_task",
          { task: "Wrong provider" },
          "parent_not_active",
        );
        const providerTask = yield* h.delegate(provider, "provider-task");
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === providerTask.taskId,
          )?.runId,
          active.id,
        );
        yield* h.expectDenied(
          scope,
          "task_status",
          { taskId: providerTask.taskId },
          "task_not_found",
        );
        yield* h.service.releaseCallInvocation(scope);
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(parentThreadId)).runs[0]?.id,
          active.id,
        );
      }),
    ),
);

it.effect(
  "read-only and shutdown callers lose delegation authority while child history survives",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const readOnly = yield* h.service.acquireCallInvocation({
          ...identity,
          access: "read-only",
        });
        yield* h.expectDenied(
          readOnly,
          "delegate_task",
          { task: "Read-only task" },
          "capability_denied",
        );
        yield* h.service.releaseCallInvocation(readOnly);
        const scope = yield* h.service.acquireCallInvocation({
          ...identity,
          callId: "shutdown-call",
        });
        const task = yield* h.delegate(scope);
        yield* h.start(task);
        yield* Scope.close(h.serviceScope, Exit.void);
        const validation = yield* h.service.validateCallInvocation(scope).pipe(Effect.result);
        assert.equal(validation._tag, "Failure");
        assert.equal(
          (yield* h.service
            .acquireCallInvocation({ ...identity, callId: "after-shutdown" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }),
    ),
);

it.effect(
  "V2 delegation lands through actual Direct/Bridge and createVoiceCallSession work_landed frames",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const adapterDependencies = Layer.mergeAll(
          Layer.succeed(Environment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(identity.environmentId),
          } as never),
          Layer.succeed(BotThreads.GrokBotThreadService, {
            open: () =>
              Effect.succeed({ threadId: parentThreadId, providerInstanceId: instanceId }),
          } as never),
          Layer.succeed(Launches.ThreadLaunchService, {} as never),
          Layer.succeed(Folders.ManagedProjectFolders, {} as never),
          Layer.succeed(Git.GitVcsDriver, {} as never),
          Layer.succeed(Config.ServerConfig, {} as never),
          Layer.succeed(ProjectService.ProjectService, {} as never),
          ServerSettings.layerTest(),
          NodeServices.layer,
          Access.HandlersLayer.layer(ProjectHandlers.layer),
          Access.HandlersLayer.layer(Handlers.layer),
          Layer.succeed(Metadata.ThreadMetadataMcpService, {} as never),
        );
        const directLayer = Direct.layer.pipe(
          Layer.provideMerge(adapterDependencies),
          Layer.provideMerge(Layer.succeedContext(h.context)),
        );
        const context = yield* Layer.build(Bridge.layer.pipe(Layer.provideMerge(directLayer)));
        const bridge = Context.get(context, Bridge.GrokBotVoiceT3Bridge);
        const caller = {
          binding: identity.accountId,
          botId: identity.botId,
          callId: identity.callId,
          access: "operate" as const,
        };
        yield* bridge.activate(caller);
        const frames: Array<unknown> = [];
        let message: (value: string) => void = () => {};
        let open = true;
        const socket: VoiceSocket = {
          send: (frame) => {
            frames.push(decode(frame));
          },
          close: () => {
            open = false;
          },
          get isOpen() {
            return open;
          },
          onOpen: () => {},
          onClose: () => {},
          onMessage: (listener) => {
            message = listener;
          },
        };
        const received = Promise.withResolvers<void>();
        let receipt: Bridge.VoiceToolOutcome | undefined;
        const toolRequests = yield* Queue.unbounded<{
          readonly input: {
            readonly callId: string;
            readonly name: string;
            readonly argumentsJson: string;
          };
          readonly resolve: (output: string) => void;
        }>();
        yield* Queue.take(toolRequests).pipe(
          Effect.flatMap(({ input, resolve }) =>
            bridge
              .call({
                ...caller,
                toolCallId: input.callId,
                name: input.name,
                input: decode(input.argumentsJson),
              })
              .pipe(
                Effect.tap((outcome) =>
                  Effect.sync(() => {
                    receipt = outcome;
                    resolve(encode(outcome.output));
                  }),
                ),
              ),
          ),
          Effect.forever,
          Effect.forkScoped,
        );
        const session = createVoiceCallSession({
          credential: {
            clientSecret: "fixture",
            model: "fixture",
            websocketUrl: "wss://api.x.ai/v1/realtime",
          },
          instructions: Bridge.T3_VOICE_INSTRUCTIONS,
          tools: Bridge.T3_VOICE_TOOLS,
          voice: { voiceId: "eve", voiceSpeed: 1, voiceLanguage: null },
          ports: {
            openSocket: () => socket,
            refreshCredential: () => Promise.reject(new Error("unused")),
            runTool: (input) =>
              new Promise<string>((resolve) => {
                Queue.offerUnsafe(toolRequests, { input, resolve });
              }),
          },
          onEvent: () => {},
          onPhase: () => {},
          onEnded: () => {},
          onToolResult: () => received.resolve(),
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => session.hangUp()));
        message(encode({ type: "session.created" }));
        message(encode({ type: "session.updated" }));
        message(encode({ type: "response.done" }));
        frames.length = 0;
        message(
          encode({
            type: "response.function_call_arguments.done",
            call_id: "voice-tool",
            name: "delegate_task",
            arguments: encode({
              task: "Inspect call authority",
              mode: "async",
              target: { providerInstanceId: instanceId, model: selection.model },
            }),
          }),
        );
        yield* Effect.promise(() => received.promise);
        assert.equal(receipt?.kind, "served");
        assert.deepEqual(receipt?.completion, { requestToolCallId: "voice-tool", pending: true });
        const task = yield* decodeTask(receipt?.output);
        yield* h.start(task);
        const waiter = yield* bridge
          .call({
            ...caller,
            toolCallId: "voice-wait",
            name: Bridge.T3_TASK_PROGRESS,
            input: { requestToolCallId: "voice-tool" },
          })
          .pipe(Effect.forkScoped);
        yield* h.finish(task);
        const completion = yield* Fiber.join(waiter);
        assert.equal(completion.kind, "served");
        assert.deepEqual(completion.output, {
          status: "landed",
          runStatus: "completed",
          updates: ["Child result"],
        });
        assert.deepEqual(completion.completion, {
          requestToolCallId: "voice-tool",
          pending: false,
        });
        // The receipt response completes before the actual task result can request speech.
        message(encode({ type: "response.done" }));
        frames.length = 0;
        session.deliverWork("voice-tool", encode(completion.output));
        const observed = yield* decodeFrames(frames);
        assert.deepEqual(
          observed.map((frame) => frame.type),
          ["conversation.item.create", "conversation.item.create", "response.create"],
        );
        assert.equal(observed[0]?.item?.name, "work_landed");
        assert.equal(observed[1]?.item?.type, "function_call_output");
        assert.deepEqual(decode(observed[1]!.item!.output!), completion.output);
        yield* bridge.forget(identity.callId);
        const late = yield* bridge.call({
          ...caller,
          toolCallId: "late",
          name: "task_status",
          input: { taskId: task.taskId },
        });
        assert.equal(late.kind, "invalid_input");
        const parent = yield* h.orchestrator.getThreadProjection(parentThreadId);
        assert.lengthOf(parent.runs, 0);
        assert.lengthOf(parent.providerTurns, 0);
        assert.lengthOf(h.turns, 1);
      }),
    ),
);
