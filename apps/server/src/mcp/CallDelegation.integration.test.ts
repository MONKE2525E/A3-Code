import * as MergeLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as MergeGit from "../vcs/GitVcsDriver.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunId,
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
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import { createGrokBotAdapterV2 } from "../orchestration-v2/Adapters/GrokBotAdapterV2.ts";
import * as GrokFixture from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import {
  GrokBotNativeRuntimeService,
  NativeRuntimeError,
  type RuntimeFrame,
} from "../grokBot/GrokBotNativeRuntimeService.ts";
import { GrokBotManagedBinding } from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
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
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as SourceControl from "../sourceControl/SourceControlRepositoryService.ts";
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
class NativeCallAdapter extends Context.Service<
  NativeCallAdapter,
  ProviderAdapter.ProviderAdapterV2["Service"]
>()("t3/mcp/CallDelegation.integration.test/NativeCallAdapter") {}

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "call-delegation-" });
  const turns: Array<{
    readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
    readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  }> = [];
  const approvalResponses: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
  const subscriptions = yield* Queue.unbounded<{
    readonly threadId: ThreadId | undefined;
    readonly eventType: OrchestrationV2DomainEvent["type"] | undefined;
  }>();
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
          respondToRuntimeRequest: (input) =>
            Effect.sync(() => {
              approvalResponses.push(input);
            }),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const nativeAdapter = Option.getOrUndefined(yield* Effect.serviceOption(NativeCallAdapter));
  const adapters =
    nativeAdapter === undefined
      ? ProviderAdapterRegistry.layerSingle(adapter)
      : Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: (id) => Effect.succeed(id === nativeAdapter.instanceId ? nativeAdapter : adapter),
          list: () => Effect.succeed([instanceId, nativeAdapter.instanceId]),
        });
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
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(MergeLaunch.ThreadLaunchService)({}),
        Layer.mock(MergeGit.GitVcsDriver)({}),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        orchestration,
        Layer.effect(
          ThreadManagement.ThreadManagementService,
          Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            return ThreadManagement.ThreadManagementService.of({
              ...threads,
              streamStoredEventsFrom: (input) =>
                Stream.concat(
                  Stream.fromEffect(
                    Queue.offer(subscriptions, {
                      threadId: input?.threadId,
                      eventType: input?.eventType,
                    }),
                  ).pipe(Stream.drain),
                  threads.streamStoredEventsFrom(input),
                ),
            });
          }),
        ).pipe(Layer.provide(orchestration)),
      ),
    ),
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
  const start = (task: { readonly childThreadId: ThreadId }) =>
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
  const ask = (
    task: { readonly childThreadId: ThreadId },
    kind: "user_input" | "command" | "permission",
    suffix: string,
  ) =>
    Effect.gen(function* () {
      const child = turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
      const projection = yield* orchestrator.getThreadProjection(task.childThreadId);
      const providerTurn = projection.providerTurns[0]!;
      const requestId = RuntimeRequestId.make(`nested-request:${suffix}`);
      const itemId = TurnItemId.make(`nested-item:${suffix}`);
      const now = yield* DateTime.now;
      const itemPersisted = yield* watch(
        (event) => event.type === "turn-item.updated" && event.payload.id === itemId,
      );
      yield* Queue.offer(child.events, {
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: itemId,
          threadId: task.childThreadId,
          runId: child.turn.runId,
          nodeId: child.turn.rootNodeId,
          providerThreadId: providerTurn.providerThreadId,
          providerTurnId: providerTurn.id,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "waiting",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          requestId,
          ...(kind === "user_input"
            ? {
                type: "user_input_request" as const,
                questions: [
                  { id: "question", header: "Choice", question: "Which branch?", options: [] },
                ],
              }
            : {
                type: "approval_request" as const,
                requestKind: kind,
                prompt: "May I publish the nested change?",
              }),
        },
      });
      yield* Fiber.join(itemPersisted);
      const requestPersisted = yield* watch(
        (event) => event.type === "runtime-request.updated" && event.payload.id === requestId,
      );
      yield* Queue.offer(child.events, {
        type: "runtime_request.updated",
        driver,
        runtimeRequest: {
          id: requestId,
          nodeId: child.turn.rootNodeId,
          providerTurnId: providerTurn.id,
          nativeRequestRef: { driver, nativeId: `native:${suffix}`, strength: "strong" },
          kind,
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: child.turn.providerThread.providerSessionId!,
          },
          createdAt: now,
          resolvedAt: null,
        },
      });
      yield* Fiber.join(requestPersisted);
      return requestId;
    });
  const createOrdinary = (threadId = ThreadId.make("ordinary-watched-thread")) =>
    orchestrator
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("call-project"),
        title: "Existing ordinary thread",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.as({ childThreadId: threadId }));
  return {
    service,
    orchestrator,
    worker,
    threads,
    turns,
    invoke,
    watch,
    approvalResponses,
    delegate,
    expectDenied,
    start,
    finish,
    ask,
    createOrdinary,
    context,
    serviceScope,
    subscriptions,
  };
}).pipe(Effect.provide(NodeServices.layer));

// The real Grok Bot adapter observes these cards without startTurn or a T3 run.
// Only the native network boundary and durable binding are fixtures.
const setupNativeCall = (kind: "user_input" | "command" | "permission" | "connector") =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("native-observed-thread");
    const providerSessionId = ProviderSessionId.make("native-observation-session");
    const frames = yield* Queue.unbounded<RuntimeFrame>();
    const calls: Array<{ readonly method: string; readonly input: object }> = [];
    let failure: "refused" | "uncertain" | undefined;
    const callback = (method: string) => (input: object) =>
      Effect.gen(function* () {
        calls.push({ method, input });
        if (failure !== undefined) return yield* new NativeRuntimeError({ kind: failure });
        return {};
      });
    const native = GrokFixture.makeNative({
      watch: () => Stream.fromQueue(frames),
      respondToWidget: callback("widget"),
      resolveAutoReviewApproval: callback("command"),
      resolveLocalToolPermission: callback("permission"),
      resolveConnectorGrant: callback("connector"),
    });
    const bound = { ...GrokFixture.nativeSession, threadId };
    const bindings = GrokFixture.makeBindings(yield* GrokFixture.makeTurn, {
      resolve: () => Effect.succeed(bound),
    });
    const adapter = yield* createGrokBotAdapterV2(GrokFixture.options).pipe(
      Effect.provideService(GrokBotNativeRuntimeService, native),
      Effect.provideService(GrokBotManagedBinding, bindings),
      Effect.provide(IdAllocator.layer),
    );
    const h = yield* setup.pipe(Effect.provideService(NativeCallAdapter, adapter));
    const cwd = (yield* h.orchestrator.getThreadProjection(parentThreadId)).thread.worktreePath!;
    yield* h.orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-native-observed"),
      threadId,
      projectId: ProjectId.make("call-project"),
      title: "Native observed bot",
      modelSelection: GrokFixture.selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    yield* Context.get(h.context, ProviderSessions.ProviderSessionManagerV2).open({
      threadId,
      providerSessionId,
      modelSelection: GrokFixture.selection,
      runtimePolicy: { ...GrokFixture.policy, cwd },
    });
    const projected = yield* h.watch(
      (event) => event.type === "turn-item.updated" && event.threadId === threadId,
    );
    const entryId = "native-card";
    const nativeRequestId = "native-request";
    yield* Queue.offer(frames, {
      _tag: "Rows",
      generation: 0,
      replay: false,
      deletes: [],
      entries: [
        {
          seq: "1",
          updatedSeq: "1",
          value: {
            id: entryId,
            kind: "send-message",
            message:
              kind === "user_input"
                ? {
                    type: "widget",
                    widget: {
                      prompt: "Which branch?",
                      options: [{ label: "Main", value: "main" }],
                    },
                  }
                : kind === "command"
                  ? {
                      type: "auto-review-approval",
                      approval: {
                        requestId: nativeRequestId,
                        status: "pending",
                        summary: "Run ls",
                        command: "ls",
                      },
                    }
                  : {
                      type: kind === "permission" ? "local-tool-permission" : "connector-grant",
                      ask: {
                        requestId: nativeRequestId,
                        status: "pending",
                        action: "read",
                        target: "workspace",
                        serverName: "fixture",
                      },
                    },
          },
        },
      ],
    });
    yield* Fiber.join(projected);
    const before = yield* h.orchestrator.getThreadProjection(threadId);
    const request = before.runtimeRequests[0]!;
    const node = before.nodes.find((node) => node.id === request.nodeId)!;
    const card = before.turnItems.find((item) => item.nodeId === node.id)!;
    assert.equal(node.runId, null);
    assert.equal(before.runs.length, 0);
    assert.equal(request.status, "pending");
    return {
      ...h,
      before,
      threadId,
      providerSessionId,
      request,
      node,
      card,
      calls,
      bound,
      fail: (kind: typeof failure) => {
        failure = kind;
      },
      response: {
        threadId,
        requestId: request.id,
        ...(kind === "user_input"
          ? { answers: { [entryId]: "main" } }
          : { decision: "accept" as const }),
        userConfirmed: true,
        clientRequestId: "native-call-response",
      },
    };
  });

it.effect.each(["user_input", "command", "permission", "connector"] as const)(
  "a call resolves an observed null-run %s card through the real native adapter exactly once",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setupNativeCall(kind);
        const scope = yield* h.service.acquireCallInvocation({
          ...identity,
          access: "full-access",
        });
        assert.equal(h.request.responseCapability.type, kind === "user_input" ? "message" : "live");
        assert.deepEqual(yield* h.service.respondToCallRequest(scope, h.response), {
          resolved: true,
        });
        yield* h.service.respondToCallRequest(scope, h.response);
        // Dispatch leaves native cards pending until their actual callback confirms success.
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(h.threadId)).runtimeRequests[0]?.status,
          "pending",
        );
        const settled = yield* h.watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === h.card.id &&
            event.payload.status === "completed",
        );
        yield* h.worker.drain();
        yield* Fiber.join(settled);
        yield* h.service.respondToCallRequest(scope, h.response);
        yield* h.worker.drain();
        assert.lengthOf(h.calls, 1);
        assert.equal(h.calls[0]?.method, kind === "user_input" ? "widget" : kind);
        assert.deepEqual(h.calls[0]?.input, {
          binding: h.bound.binding,
          botId: h.bound.botId,
          sessionId: h.bound.sessionId,
          ...(kind === "user_input"
            ? { entryId: "native-card", value: "main" }
            : kind === "command"
              ? {
                  requestId: "native-request",
                  resolution: "APPROVED",
                  approvalPlatform: "desktop",
                  approvedCommand: "ls",
                }
              : {
                  requestId: "native-request",
                  entryId: "native-card",
                  resolution: kind === "permission" ? "ALLOW_ONCE" : "ALLOWED",
                }),
        });
        const after = yield* h.orchestrator.getThreadProjection(h.threadId);
        assert.equal(after.runtimeRequests[0]?.status, "resolved");
        assert.equal(after.nodes.find((node) => node.id === h.node.id)?.status, "completed");
        assert.deepEqual(after.runs, h.before.runs);
        assert.deepEqual(after.messages, h.before.messages);
        assert.lengthOf(h.turns, 0);
        const events = Context.get(h.context, EventStore.EventStoreV2);
        const sequence = yield* events.latestSequence();
        assert.equal(
          (yield* h.service
            .respondToCallRequest(scope, { ...h.response, clientRequestId: "fresh-replay" })
            .pipe(Effect.flip)).code,
          "invalid_request",
        );
        assert.equal(yield* events.latestSequence(), sequence);
        yield* h.worker.drain();
        assert.lengthOf(h.calls, 1);
      }),
    ),
);

it.effect.each([
  ["user_input", "refused"],
  ["user_input", "uncertain"],
  ["permission", "refused"],
  ["permission", "uncertain"],
] as const)("a null-run %s stays pending when its native callback is %s", ([kind, failure]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* setupNativeCall(kind);
      const scope = yield* h.service.acquireCallInvocation({ ...identity, access: "full-access" });
      h.fail(failure);
      yield* h.service.respondToCallRequest(scope, h.response);
      yield* h.worker.drain();
      assert.lengthOf(h.calls, 1);
      const after = yield* h.orchestrator.getThreadProjection(h.threadId);
      assert.equal(after.runtimeRequests[0]?.status, "pending");
      assert.equal(after.nodes.find((node) => node.id === h.node.id)?.status, "waiting");
      assert.equal(after.turnItems.find((item) => item.id === h.card.id)?.status, "waiting");
      assert.deepEqual(after.runs, h.before.runs);
      assert.deepEqual(after.messages, h.before.messages);
      yield* h.service.respondToCallRequest(scope, h.response);
      yield* h.worker.drain();
      assert.lengthOf(h.calls, 1);
    }),
  ),
);

it.effect.each([
  "missing-node",
  "orphan-run",
  "orphan-runtime-request",
  "foreign-session",
  "unbound-capability",
  "weak-ref",
  "foreign-node-ref",
  "wrong-node-request",
  "ended-node",
  "missing-card",
  "foreign-card-node",
  "stopped-session",
  "foreign-provider",
  "wrong-kind",
  "read-only",
  "no-consent",
  "stale-call",
  "ended-call",
  "archived",
  "deleted",
  "runtime",
  "interaction",
] as const)("a null-run native call response rejects %s without writes or callbacks", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* setupNativeCall("user_input");
      const scope = yield* h.service.acquireCallInvocation({ ...identity, access: "full-access" });
      let caller = scope;
      let code: OrchestratorMcpFailure["code"] = "invalid_request";
      const base = {
        id: EventId.make(`corrupt-native:${scenario}`),
        threadId: h.threadId,
        occurredAt: yield* DateTime.now,
      };
      let corrupt: OrchestrationV2DomainEvent | undefined;
      switch (scenario) {
        case "missing-node":
        case "foreign-session":
        case "unbound-capability":
        case "orphan-runtime-request":
        case "weak-ref":
        case "wrong-kind":
          corrupt = {
            ...base,
            type: "runtime-request.updated",
            payload: {
              ...h.request,
              ...(scenario === "missing-node"
                ? { nodeId: NodeId.make("missing-native-node") }
                : {}),
              ...(scenario === "foreign-session"
                ? {
                    responseCapability: {
                      type: "message" as const,
                      providerSessionId: ProviderSessionId.make("foreign-session"),
                    },
                  }
                : {}),
              ...(scenario === "unbound-capability"
                ? { responseCapability: { type: "message" as const } }
                : {}),
              ...(scenario === "orphan-runtime-request"
                ? {
                    nativeRequestRef: null,
                    responseCapability: {
                      type: "live" as const,
                      providerSessionId: h.providerSessionId,
                    },
                  }
                : {}),
              ...(scenario === "weak-ref"
                ? {
                    nativeRequestRef: { ...h.request.nativeRequestRef!, strength: "weak" as const },
                  }
                : {}),
              ...(scenario === "wrong-kind" ? { kind: "command" } : {}),
            },
          };
          break;
        case "orphan-run":
        case "foreign-node-ref":
        case "wrong-node-request":
        case "ended-node":
          corrupt = {
            ...base,
            type: "node.updated",
            payload: {
              ...h.node,
              ...(scenario === "orphan-run" ? { runId: RunId.make("missing-native-run") } : {}),
              ...(scenario === "foreign-node-ref"
                ? { nativeItemRef: { ...h.node.nativeItemRef!, nativeId: "widget/foreign-card" } }
                : {}),
              ...(scenario === "wrong-node-request"
                ? { runtimeRequestId: RuntimeRequestId.make("foreign-request") }
                : {}),
              ...(scenario === "ended-node" ? { status: "completed" as const } : {}),
            },
          };
          break;
        case "missing-card":
        case "foreign-card-node":
          if (h.card.type !== "user_input_request")
            return yield* Effect.die("missing native question card");
          corrupt = {
            ...base,
            type: "turn-item.updated",
            payload: {
              ...h.card,
              ...(scenario === "missing-card"
                ? { requestId: RuntimeRequestId.make("foreign-request") }
                : { nodeId: NodeId.make("foreign-node") }),
            },
          };
          break;
        case "stopped-session":
        case "foreign-provider":
          corrupt = {
            ...base,
            type: "provider-session.updated",
            payload: {
              ...h.before.providerSessions.find((session) => session.id === h.providerSessionId)!,
              ...(scenario === "stopped-session"
                ? { status: "stopped" as const }
                : { providerInstanceId: instanceId }),
            },
          };
          break;
        case "read-only":
          caller = yield* h.service.restrictCallInvocation(scope, "read-only");
          code = "capability_denied";
          break;
        case "no-consent":
          code = "capability_denied";
          break;
        case "stale-call":
          caller = { ...scope };
          code = "parent_not_active";
          break;
        case "ended-call":
          yield* h.service.releaseCallInvocation(scope);
          code = "parent_not_active";
          break;
        case "archived":
        case "deleted":
          yield* h.orchestrator.dispatch({
            type: scenario === "archived" ? "thread.archive" : "thread.delete",
            commandId: CommandId.make(`native:${scenario}`),
            threadId: h.threadId,
          });
          code = "thread_not_found";
          break;
        case "runtime":
          yield* h.orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("narrow-native-call"),
            threadId: parentThreadId,
            runtimeMode: "approval-required",
          });
          code = "runtime_mode_escalation_denied";
          break;
        case "interaction":
          yield* h.orchestrator.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("narrow-native-call"),
            threadId: parentThreadId,
            interactionMode: "plan",
          });
          code = "interaction_mode_escalation_denied";
          break;
      }
      if (corrupt !== undefined)
        yield* Context.get(h.context, EventSink.EventSinkV2).write({ events: [corrupt] });
      const events = Context.get(h.context, EventStore.EventStoreV2);
      const sequence = yield* events.latestSequence();
      assert.equal(
        (yield* h.service
          .respondToCallRequest(caller, { ...h.response, userConfirmed: scenario !== "no-consent" })
          .pipe(Effect.flip)).code,
        code,
      );
      assert.equal(yield* events.latestSequence(), sequence);
      yield* h.worker.drain();
      assert.lengthOf(h.calls, 0);
    }),
  ),
);

const directLayerFor = (context: Effect.Success<typeof setup>["context"]) =>
  Direct.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(Environment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(identity.environmentId),
        } as never),
        Layer.succeed(BotThreads.GrokBotThreadService, {
          open: () => Effect.succeed({ threadId: parentThreadId, providerInstanceId: instanceId }),
        } as never),
        Layer.succeed(Launches.ThreadLaunchService, {} as never),
        Layer.succeed(Folders.ManagedProjectFolders, {} as never),
        Layer.succeed(Git.GitVcsDriver, {} as never),
        Layer.succeed(Config.ServerConfig, {} as never),
        Layer.succeed(ProjectService.ProjectService, {} as never),
        ServerSettings.layerTest(),
        NodeServices.layer,
        Access.HandlersLayer.layer(ProjectHandlers.layer),
        Access.HandlersLayer.layer(ThreadHandlers.layer).pipe(
          Layer.provide(ProviderRegistryMock.layer(providers)),
          Layer.provide(NodeServices.layer),
        ),
        Layer.succeed(ThreadSearch.ThreadSearch, {} as never),
        Layer.succeed(ScheduledTaskService.ScheduledTaskService, {} as never),
        Layer.succeed(SourceControl.SourceControlRepositoryService, {} as never),
        Access.HandlersLayer.layer(Handlers.layer),
        Layer.succeed(Metadata.ThreadMetadataMcpService, {} as never),
      ),
    ),
    Layer.provideMerge(Layer.succeedContext(context)),
  );

it.effect.each([
  ["user_input", "decline"],
  ["permission", "accept"],
  ["permission", "decline"],
] as const)(
  "an idle ordinary thread watch delivers %s (%s) and responds through the normal provider callback once",
  ([kind, decision]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const context = yield* Layer.build(
          Bridge.layer.pipe(Layer.provideMerge(directLayerFor(h.context))),
        );
        const bridge = Context.get(context, Bridge.GrokBotVoiceT3Bridge);
        const caller = {
          binding: identity.accountId,
          botId: identity.botId,
          callId: identity.callId,
          access: "operate" as const,
        };
        yield* bridge.activate(caller);
        const { childThreadId: threadId } = yield* h.createOrdinary();
        const watched = yield* bridge.call({
          ...caller,
          toolCallId: "watch-ordinary",
          name: "t3_watch_thread",
          input: { threadId },
        });
        assert.equal(watched.kind, "served");
        assert.isTrue((watched.output as { watching: boolean }).watching);
        assert.lengthOf(h.turns, 0);
        const scope = yield* h.service.acquireCallInvocation({
          ...identity,
          access: "full-access",
        });
        yield* h.service.sendToThread(scope, {
          threadId,
          message: "Start the previously idle thread",
          clientRequestId: "ordinary-run",
        });
        yield* h.start({ childThreadId: threadId });
        const requestId = yield* h.ask({ childThreadId: threadId }, kind, "ordinary");
        const notice = yield* bridge.call({
          ...caller,
          toolCallId: "ordinary-progress",
          name: Bridge.T3_TASK_PROGRESS,
          input: { requestToolCallId: "watch-ordinary", seenApprovalIds: [] },
        });
        assert.equal(notice.kind, "served");
        const output = notice.output as {
          threadId: string;
          questions?: Array<{ requestId: string }>;
          approvals?: Array<{ requestId: string }>;
        };
        assert.equal(output.threadId, threadId);
        assert.equal(
          (kind === "user_input" ? output.questions : output.approvals)?.[0]?.requestId,
          requestId,
        );
        const before = yield* h.orchestrator.getThreadProjection(threadId);
        const sequence = yield* Context.get(h.context, EventStore.EventStoreV2).latestSequence();
        const response = {
          ...caller,
          toolCallId: "ordinary-response",
          name:
            kind === "user_input" ? "t3_pending_request_respond" : "t3_pending_approval_respond",
          input: {
            threadId,
            requestId,
            userConfirmed: false,
            ...(kind === "user_input"
              ? { answers: { question: "release/actual-caller-answer" } }
              : { decision }),
          },
        };
        const denied = yield* bridge.call(response);
        assert.equal(denied.kind, "invalid_input");
        assert.equal((denied.output as { code: string }).code, "capability_denied");
        assert.equal(
          yield* Context.get(h.context, EventStore.EventStoreV2).latestSequence(),
          sequence,
        );
        assert.lengthOf(h.approvalResponses, 0);
        const confirmed = {
          ...response,
          toolCallId: "ordinary-confirmed",
          input: { ...response.input, userConfirmed: true },
        };
        assert.equal((yield* bridge.call(confirmed)).kind, "served");
        assert.equal((yield* bridge.call(confirmed)).kind, "served");
        // A transport retry with the same key also reaches the command receipt after resolution.
        yield* h.service.respondToCallRequest(scope, {
          ...confirmed.input,
          clientRequestId: confirmed.toolCallId,
        });
        yield* h.worker.drain();
        assert.lengthOf(h.approvalResponses, 1);
        assert.equal(h.approvalResponses[0]?.requestId, requestId);
        if (kind === "user_input")
          assert.deepEqual(h.approvalResponses[0]?.answers, {
            question: "release/actual-caller-answer",
          });
        else assert.equal(h.approvalResponses[0]?.decision, decision);
        const after = yield* h.orchestrator.getThreadProjection(threadId);
        assert.deepEqual(after.messages, before.messages);
        assert.deepEqual(
          after.runs.map((run) => run.id),
          before.runs.map((run) => run.id),
        );
        assert.lengthOf(h.turns, 1);
        assert.lengthOf((yield* h.orchestrator.getThreadProjection(parentThreadId)).messages, 0);
        yield* bridge.forget(caller.callId);
      }),
    ),
);

it.effect.each([
  "read-only",
  "no-consent",
  "stale-call",
  "ended-call",
  "archived",
  "deleted",
  "runtime",
  "interaction",
  "wrong-kind",
  "stale-request",
  "ended-run",
  "implicit-target",
] as const)(
  "ordinary call responses reject %s without writing or invoking the provider",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const scope = yield* h.service.acquireCallInvocation({
          ...identity,
          access: "full-access",
        });
        const task = yield* h.createOrdinary();
        yield* h.service.sendToThread(scope, {
          threadId: task.childThreadId,
          message: "Start ordinary work",
          clientRequestId: "ordinary-run",
        });
        yield* h.start(task);
        const requestId = yield* h.ask(task, "user_input", "ordinary-rejected");
        let caller = scope;
        const response = {
          threadId: task.childThreadId,
          requestId,
          answers: { question: "main" },
          userConfirmed: scenario !== "no-consent",
          clientRequestId: "ordinary-rejected-response",
        };
        let code: OrchestratorMcpFailure["code"] = "invalid_request";
        switch (scenario) {
          case "read-only":
            caller = yield* h.service.restrictCallInvocation(scope, "read-only");
            code = "capability_denied";
            break;
          case "no-consent":
            code = "capability_denied";
            break;
          case "stale-call":
            caller = { ...scope };
            code = "parent_not_active";
            break;
          case "ended-call":
            yield* h.service.releaseCallInvocation(scope);
            code = "parent_not_active";
            break;
          case "archived":
          case "deleted":
            yield* h.orchestrator.dispatch({
              type: scenario === "archived" ? "thread.archive" : "thread.delete",
              commandId: CommandId.make(`target:${scenario}`),
              threadId: task.childThreadId,
            });
            code = "thread_not_found";
            break;
          case "runtime":
            yield* h.orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("narrow-call-mode"),
              threadId: parentThreadId,
              runtimeMode: "approval-required",
            });
            code = "runtime_mode_escalation_denied";
            break;
          case "interaction":
            yield* h.orchestrator.dispatch({
              type: "thread.interaction-mode.set",
              commandId: CommandId.make("narrow-call-mode"),
              threadId: parentThreadId,
              interactionMode: "plan",
            });
            code = "interaction_mode_escalation_denied";
            break;
          case "stale-request":
            yield* h.service.respondToCallRequest(scope, {
              ...response,
              clientRequestId: "earlier-response",
            });
            yield* h.worker.drain();
            break;
          case "ended-run":
            const child = h.turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
            const projection = yield* h.orchestrator.getThreadProjection(task.childThreadId);
            const providerTurn = projection.providerTurns[0]!;
            const interrupted = yield* h.watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === child.turn.runId &&
                event.payload.status === "interrupted",
            );
            yield* Queue.offer(child.events, {
              type: "turn.terminal",
              driver,
              providerThreadId: providerTurn.providerThreadId,
              providerTurnId: providerTurn.id,
              runOrdinal: child.turn.runOrdinal,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(interrupted);
            break;
          case "wrong-kind":
          case "implicit-target":
            break;
        }
        const events = Context.get(h.context, EventStore.EventStoreV2);
        const sequence = yield* events.latestSequence();
        const callbacks = h.approvalResponses.length;
        const { threadId: _threadId, ...implicit } = response;
        const refused = yield* h.service
          .respondToCallRequest(
            caller,
            scenario === "wrong-kind"
              ? {
                  threadId: task.childThreadId,
                  requestId,
                  decision: "accept",
                  userConfirmed: true,
                  clientRequestId: response.clientRequestId,
                }
              : scenario === "implicit-target"
                ? implicit
                : response,
          )
          .pipe(Effect.flip);
        assert.equal(refused.code, code);
        assert.equal(yield* events.latestSequence(), sequence);
        yield* h.worker.drain();
        assert.lengthOf(h.approvalResponses, callbacks);
      }),
    ),
);

it.effect("an ordinary-target response cannot answer another call's delegated thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const previous = yield* h.service.acquireCallInvocation(identity);
      const task = yield* h.delegate(previous, "other-call-task");
      yield* h.start(task);
      const requestId = yield* h.ask(task, "user_input", "other-call");
      yield* h.service.releaseCallInvocation(previous);
      const scope = yield* h.service.acquireCallInvocation({ ...identity, callId: "new-call" });
      const events = Context.get(h.context, EventStore.EventStoreV2);
      const sequence = yield* events.latestSequence();
      const refused = yield* h.service
        .respondToCallRequest(scope, {
          threadId: task.childThreadId,
          requestId,
          answers: { question: "main" },
          userConfirmed: true,
          clientRequestId: "other-call-response",
        })
        .pipe(Effect.flip);
      assert.equal(refused.code, "invalid_request");
      assert.equal(yield* events.latestSequence(), sequence);
      yield* h.worker.drain();
      assert.lengthOf(h.approvalResponses, 0);
    }),
  ),
);

it.effect.each(["user_input", "command"] as const)(
  "Direct responds to a nested %s notice through its origin thread and provider callback",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const context = yield* Layer.build(directLayerFor(h.context));
        const voice = Context.get(context, Direct.GrokBotVoiceOrchestration);
        const caller = {
          binding: identity.accountId,
          botId: identity.botId,
          callId: identity.callId,
          access: "operate" as const,
          canonicalThreadId: parentThreadId,
        };
        yield* voice.activate(caller);
        const scope = yield* h.service.acquireCallInvocation({
          ...identity,
          access: "full-access",
        });
        const task = yield* h.delegate(scope, "direct-root");
        yield* h.start(task);
        const { call: _call, ...providerScope } = scope;
        const grandchild = yield* h.delegate(
          {
            ...providerScope,
            client: undefined,
            thread: {
              threadId: task.childThreadId,
              providerSessionId: "child-provider",
              providerInstanceId: instanceId,
            },
          },
          "direct-grandchild",
        );
        yield* h.start(grandchild);
        const requestId = yield* h.ask(grandchild, kind, "direct-grandchild");
        const notice = yield* voice.wait({ ...caller, taskId: task.taskId, seenApprovalIds: [] });
        const output = notice.result.output as {
          questions?: Array<{ threadId: string; requestId: string }>;
          approvals?: Array<{ threadId: string; requestId: string }>;
        };
        const request = (kind === "user_input" ? output.questions : output.approvals)?.[0];
        assert.equal(request?.threadId, grandchild.childThreadId);
        assert.equal(request?.requestId, requestId);
        const response = {
          ...caller,
          name:
            kind === "user_input" ? "t3_pending_request_respond" : "t3_pending_approval_respond",
          toolCallId: "direct-response",
          input: {
            ...request,
            userConfirmed: false,
            ...(kind === "user_input"
              ? { answers: { question: "main" } }
              : { decision: "decline" }),
          },
        };
        assert.equal((yield* voice.call(response)).result.kind, "invalid_input");
        assert.equal(h.approvalResponses.length, 0);
        const accepted = yield* voice.call({
          ...response,
          input: { ...response.input, userConfirmed: true },
        });
        assert.equal(accepted.result.kind, "served");
        yield* h.worker.drain();
        assert.equal(h.approvalResponses.length, 1);
        assert.equal(h.approvalResponses[0]?.requestId, requestId);
        if (kind === "user_input")
          assert.deepEqual(h.approvalResponses[0]?.answers, { question: "main" });
        else assert.equal(h.approvalResponses[0]?.decision, "decline");
        yield* voice.forget(identity.callId);
      }),
    ),
);

it.effect("a live call posts one visible assistant message without starting a bot turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* setup;
      const scope = yield* h.service.acquireCallInvocation({ ...identity, access: "full-access" });
      assert.equal((yield* h.service.capabilities(scope)).runtimeMode, "full-access");
      const first = yield* h.service.postCallChat(scope, {
        text: "Written call summary.",
        clientRequestId: "post-chat",
      });
      const duplicate = yield* h.service.postCallChat(scope, {
        text: "Written call summary.",
        clientRequestId: "post-chat",
      });
      assert.deepEqual(first, duplicate);
      const projection = yield* h.orchestrator.getThreadProjection(parentThreadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.messages[0]?.role, "assistant");
      assert.equal(projection.messages[0]?.text, "Written call summary.");
      assert.equal(projection.runs.length, 0);
      assert.equal(h.turns.length, 0);
      const readonly = yield* h.service.restrictCallInvocation(scope, "read-only");
      assert.equal(
        (yield* Effect.flip(
          h.service.postCallChat(readonly, { text: "Denied", clientRequestId: "denied" }),
        )).code,
        "capability_denied",
      );
      yield* h.service.releaseCallInvocation(scope);
      assert.equal(
        (yield* Effect.flip(
          h.service.postCallChat(scope, { text: "Ended", clientRequestId: "ended" }),
        )).code,
        "parent_not_active",
      );
    }),
  ),
);

it.effect(
  "a call observes and approves only its own pending request with explicit caller consent",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const scope = yield* h.service.acquireCallInvocation(identity);
        const task = yield* h.delegate(scope);
        const child = yield* h.start(task);
        const projection = yield* h.orchestrator.getThreadProjection(task.childThreadId);
        const requestId = RuntimeRequestId.make("call-command-approval");
        const wait = yield* h.service
          .waitForTask(scope, task.taskId, 20_000, [])
          .pipe(Effect.forkScoped);
        const persisted = yield* h.watch(
          (event) => event.type === "runtime-request.updated" && event.payload.id === requestId,
        );
        const now = yield* DateTime.now;
        const approvalItemId = TurnItemId.make("call-command-approval-item");
        const approvalPersisted = yield* h.watch(
          (event) => event.type === "turn-item.updated" && event.payload.id === approvalItemId,
        );
        yield* Queue.offer(child.events, {
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: approvalItemId,
            threadId: task.childThreadId,
            runId: child.turn.runId,
            nodeId: child.turn.rootNodeId,
            providerThreadId: projection.providerTurns[0]!.providerThreadId,
            providerTurnId: projection.providerTurns[0]!.id,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "approval_request",
            requestId,
            requestKind: "command",
            prompt: "May I publish this release?",
          },
        });
        yield* Fiber.join(approvalPersisted);
        yield* Queue.offer(child.events, {
          type: "runtime_request.updated",
          driver,
          runtimeRequest: {
            id: requestId,
            nodeId: child.turn.rootNodeId,
            providerTurnId: projection.providerTurns[0]!.id,
            nativeRequestRef: { driver, nativeId: "native-command-approval", strength: "strong" },
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: child.turn.providerThread.providerSessionId!,
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
        yield* Fiber.join(persisted);
        const noticed = yield* Fiber.join(wait);
        assert.equal(noticed.pendingApprovals?.[0]?.requestId, requestId);
        assert.equal(noticed.pendingApprovals?.[0]?.title, "May I publish this release?");
        assert.equal(noticed.pendingApprovals?.[0]?.prompt, "May I publish this release?");
        assert.equal(noticed.waitTimedOut, false);
        const request = {
          taskId: task.taskId,
          requestId,
          decision: "accept" as const,
          userConfirmed: false,
          clientRequestId: "approve-command",
        };
        assert.equal(
          (yield* Effect.flip(h.service.respondToCallApproval(scope, request))).code,
          "capability_denied",
        );
        const other = yield* h.service.acquireCallInvocation({
          ...identity,
          callId: "another-call",
          threadId: task.childThreadId,
        });
        assert.equal(
          (yield* Effect.flip(
            h.service.respondToCallApproval(other, { ...request, userConfirmed: true }),
          )).code,
          "task_not_found",
        );
        yield* h.service.respondToCallApproval(scope, { ...request, userConfirmed: true });
        yield* h.service.respondToCallApproval(scope, { ...request, userConfirmed: true });
        yield* h.worker.drain();
        assert.equal(h.approvalResponses.length, 1);
        assert.equal(h.approvalResponses[0]?.requestId, requestId);
        assert.equal(h.approvalResponses[0]?.decision, "accept");
        const resolved = yield* h.service.taskStatus(scope, task.taskId);
        assert.deepEqual(resolved.pendingApprovals, []);
        yield* h.finish(task);
        const completed = yield* h.service.waitForTask(scope, task.taskId, 20_000, [requestId]);
        assert.equal(completed.status, "completed");
      }),
    ),
);

it.effect.each(["user_input", "command"] as const)(
  "a call notices nested %s requests created after its task wait starts",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const scope = yield* h.service.acquireCallInvocation(identity);
        const task = yield* h.delegate(scope, "nested-root");
        yield* h.start(task);
        const waiter = yield* h.service
          .waitForTask(scope, task.taskId, 20_000, [])
          .pipe(Effect.forkScoped);
        yield* Stream.fromQueue(h.subscriptions).pipe(
          Stream.filter(
            (subscription) =>
              subscription.threadId === task.childThreadId &&
              subscription.eventType === "subagent.updated",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const { call: _call, ...providerFields } = scope;
        const providerScope: Invocation.McpInvocationScope = {
          ...providerFields,
          client: undefined,
          thread: {
            threadId: task.childThreadId,
            providerSessionId: "child-provider",
            providerInstanceId: instanceId,
          },
        };
        const grandchild = yield* h.delegate(providerScope, "grandchild");
        yield* h.start(grandchild);
        const requestId = yield* h.ask(grandchild, kind, "grandchild");
        const notice = yield* Fiber.join(waiter);
        assert.isFalse(notice.waitTimedOut);
        const requests = kind === "user_input" ? notice.pendingQuestions : notice.pendingApprovals;
        assert.deepEqual(
          requests?.map((request) => [request.threadId, request.requestId]),
          [[grandchild.childThreadId, requestId]],
        );
        if (kind === "command")
          assert.equal(notice.pendingApprovals?.[0]?.prompt, "May I publish the nested change?");

        const unrelated = yield* h.delegate(scope, "unrelated-call-task");
        yield* h.start(unrelated);
        yield* h.ask(unrelated, kind, "unrelated");
        const reread = yield* h.service.taskStatus(scope, task.taskId);
        const scoped = kind === "user_input" ? reread.pendingQuestions : reread.pendingApprovals;
        assert.deepEqual(
          scoped?.map((request) => request.threadId),
          [grandchild.childThreadId],
        );
        assert.equal(
          (yield* h.service
            .respondToCallApproval(scope, {
              taskId: task.taskId,
              requestId: RuntimeRequestId.make("nested-request:unrelated"),
              userConfirmed: true,
              decision: "accept",
              clientRequestId: "unrelated-response",
            })
            .pipe(Effect.flip)).code,
          "invalid_request",
        );
        const response = {
          taskId: task.taskId,
          threadId: grandchild.childThreadId,
          requestId,
          userConfirmed: true,
          clientRequestId: "nested-response",
          ...(kind === "user_input"
            ? { answers: { question: "main" } }
            : { decision: "accept" as const }),
        };
        assert.equal(
          (yield* h.service
            .respondToCallRequest(scope, { ...response, userConfirmed: false })
            .pipe(Effect.flip)).code,
          "capability_denied",
        );
        assert.equal(
          (yield* h.service
            .respondToCallRequest(scope, {
              ...response,
              threadId: unrelated.childThreadId,
              requestId: RuntimeRequestId.make("nested-request:unrelated"),
            })
            .pipe(Effect.flip)).code,
          "invalid_request",
        );
        const command = {
          type: "call.runtime-request.respond" as const,
          commandId: CommandId.make("nested-direct-response"),
          parentThreadId,
          parentNodeId: scope.call!.parentNodeId,
          authority: scope.call!,
          taskId: task.taskId,
          threadId: grandchild.childThreadId,
          requestId,
          ...(kind === "user_input"
            ? { answers: { question: "main" } }
            : { decision: "accept" as const }),
        };
        const unrelatedDispatch = yield* h.orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make("unrelated-direct-response"),
            threadId: unrelated.childThreadId,
            requestId: RuntimeRequestId.make("nested-request:unrelated"),
          })
          .pipe(Effect.flip);
        assert.equal(unrelatedDispatch._tag, "OrchestratorDispatchError");
        const stale = yield* h.orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make("stale-direct-response"),
            authority: { ...scope.call!, authorityId: "stale-authority" },
          })
          .pipe(Effect.flip);
        assert.equal(stale._tag, "OrchestratorDispatchError");
        assert.equal(h.approvalResponses.length, 0);
        const { taskId: _taskId, ...threadResponse } = response;
        yield* h.service.respondToCallRequest(scope, threadResponse);
        yield* h.service.respondToCallRequest(scope, response);
        yield* h.worker.drain();
        assert.equal(h.approvalResponses.length, 1);
        assert.equal(h.approvalResponses[0]?.requestId, requestId);
        if (kind === "user_input")
          assert.deepEqual(h.approvalResponses[0]?.answers, { question: "main" });
        else assert.equal(h.approvalResponses[0]?.decision, "accept");
        const pendingRequestId = yield* h.ask(grandchild, kind, "after-response");
        yield* h.service.releaseCallInvocation(scope);
        assert.equal(
          (yield* h.service
            .respondToCallRequest(scope, {
              ...response,
              requestId: pendingRequestId,
              clientRequestId: "ended-response",
            })
            .pipe(Effect.flip)).code,
          "parent_not_active",
        );
        assert.equal(
          (yield* h.orchestrator
            .dispatch({
              ...command,
              commandId: CommandId.make("ended-direct-response"),
              requestId: pendingRequestId,
            })
            .pipe(Effect.flip))._tag,
          "OrchestratorDispatchError",
        );
        yield* h.worker.drain();
        assert.equal(h.approvalResponses.length, 1);
      }),
    ),
);

it.effect.each(["runtime", "interaction"] as const)(
  "call responses refuse a nested request above the call's %s mode",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const scope = yield* h.service.acquireCallInvocation(identity);
        const task = yield* h.delegate(scope, "limited-root");
        yield* h.start(task);
        const { call: _call, ...providerScope } = scope;
        const grandchild = yield* h.delegate(
          {
            ...providerScope,
            client: undefined,
            thread: {
              threadId: task.childThreadId,
              providerSessionId: "child-provider",
              providerInstanceId: instanceId,
            },
          },
          "limited-grandchild",
        );
        yield* h.start(grandchild);
        const requestId = yield* h.ask(grandchild, "user_input", "limited-grandchild");
        yield* h.orchestrator.dispatch(
          mode === "runtime"
            ? {
                type: "thread.runtime-mode.set",
                commandId: CommandId.make("raise-descendant-mode"),
                threadId: grandchild.childThreadId,
                runtimeMode: "full-access",
              }
            : {
                type: "thread.interaction-mode.set",
                commandId: CommandId.make("tighten-parent-mode"),
                threadId: parentThreadId,
                interactionMode: "plan",
              },
        );
        const refused = yield* h.service
          .respondToCallRequest(scope, {
            threadId: grandchild.childThreadId,
            requestId,
            answers: { question: "main" },
            userConfirmed: true,
            clientRequestId: "limited-response",
          })
          .pipe(Effect.flip);
        assert.equal(
          refused.code,
          mode === "runtime"
            ? "runtime_mode_escalation_denied"
            : "interaction_mode_escalation_denied",
        );
        const commandRefused = yield* h.orchestrator
          .dispatch({
            type: "call.runtime-request.respond",
            commandId: CommandId.make("limited-direct-response"),
            parentThreadId,
            parentNodeId: scope.call!.parentNodeId,
            authority: scope.call!,
            taskId: task.taskId,
            threadId: grandchild.childThreadId,
            requestId,
            answers: { question: "main" },
          })
          .pipe(Effect.flip);
        assert.equal(
          commandRefused._tag,
          mode === "runtime"
            ? "OrchestratorThreadAboveModeLimitError"
            : "OrchestratorDispatchError",
        );
        yield* h.worker.drain();
        assert.equal(h.approvalResponses.length, 0);
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(
            grandchild.childThreadId,
          )).runtimeRequests.find((request) => request.id === requestId)?.status,
          "pending",
        );
      }),
    ),
);

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
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            ServerSettings.layerTest(),
            Layer.succeedContext(h.context),
          ),
        ),
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
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              ServerSettings.layerTest(),
              Layer.succeedContext(h.context),
            ),
          ),
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
        const capabilities = yield* h.service.capabilities(scope);
        assert.isNull(capabilities.inheritedProviderInstanceId);
        assert.isNull(capabilities.inheritedModel);
        assert.isFalse(capabilities.features.batchThreadCreation);
        yield* h.expectDenied(
          scope,
          "delegate_task",
          { task: "Use the requested coding model", mode: "async" },
          "invalid_request",
        );
        yield* h.expectDenied(
          scope,
          "delegate_task",
          { task: "Use the requested coding model", target: { model: selection.model } },
          "invalid_request",
        );
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

it.effect(
  "a call forwards only chat-owned screenshot references into its child's first provider turn",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const attachment = {
          type: "image" as const,
          id: "call-screenshot",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 42,
        };
        yield* h.orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("record-screenshot"),
          threadId: parentThreadId,
          messageId: MessageId.make("image-only-message"),
          text: "",
          attachments: [attachment],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const scope = yield* h.service.acquireCallInvocation(identity);
        yield* h.expectDenied(
          scope,
          "delegate_task",
          {
            task: "Inspect this screenshot",
            target: { providerInstanceId: instanceId, model: selection.model },
            attachmentIds: ["another-threads-file"],
          },
          "invalid_request",
        );
        const result = yield* h.invoke(scope, "delegate_task", {
          task: "Inspect this screenshot",
          title: "Inspect screenshot",
          mode: "async",
          clientRequestId: "forward-image",
          target: { providerInstanceId: instanceId, model: selection.model },
          attachmentIds: [attachment.id, attachment.id],
        });
        assert.isFalse(result.isFailure);
        const task = yield* decodeTask(result.encodedResult);
        const child = yield* h.orchestrator.getThreadProjection(task.childThreadId);
        assert.deepStrictEqual(child.messages[0]?.attachments, [attachment]);
        const turn = yield* h.start(task);
        assert.deepStrictEqual(turn.turn.message.attachments, [attachment]);
        const replay = yield* h.invoke(scope, "delegate_task", {
          task: "Inspect this screenshot",
          title: "Inspect screenshot",
          mode: "async",
          clientRequestId: "forward-image",
          target: { providerInstanceId: instanceId, model: selection.model },
          attachmentIds: [attachment.id],
        });
        assert.deepStrictEqual((replay.encodedResult as { taskId: string }).taskId, task.taskId);
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
        {
          task: "Escalate",
          runtimeMode: "full-access",
          target: { providerInstanceId: instanceId, model: selection.model },
        },
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
          Access.HandlersLayer.layer(ThreadHandlers.layer).pipe(
            Layer.provide(ProviderRegistryMock.layer(providers)),
            Layer.provide(NodeServices.layer),
          ),
          Layer.succeed(ThreadSearch.ThreadSearch, {} as never),
          Layer.succeed(ScheduledTaskService.ScheduledTaskService, {} as never),
          Layer.succeed(SourceControl.SourceControlRepositoryService, {} as never),
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
        message(
          encode({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "current-caller-request",
            transcript: "Delegate a task to inspect call authority.",
          }),
        );
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
          title: "Inspect call authority",
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
          ["conversation.item.create", "conversation.item.create", "conversation.item.create"],
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
