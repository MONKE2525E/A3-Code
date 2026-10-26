import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  WsRpcGroup,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput as LaunchSchema,
  RunId,
  RuntimeRequestId,
  ThreadId,
  ServerConfig as WireConfig,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as RemoteClient from "./RemoteEnvironmentClient.ts";
import * as Registry from "./PeerEnvironmentRegistry.ts";
import * as Tasks from "./RemoteTaskService.ts";

const decodeConfig = Schema.decodeEffect(WireConfig);
const decodeLaunch = Schema.decodeUnknownEffect(LaunchSchema);
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);
const decodeThreadPayload = Schema.decodeUnknownEffect(Schema.Struct({ threadId: ThreadId }));
const decodeJsonObject = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const parentThreadId = ThreadId.make("parent");
const environmentId = EnvironmentId.make("box-b");
const runId = RunId.make("run-b");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const launch = {
  commandId: CommandId.make("caller-command"),
  projectId: ProjectId.make("project-b"),
  title: "Remote task",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "auto",
  interactionMode: "plan",
  workspaceStrategy: { type: "root" },
  initialMessage: { text: "Do the task", attachments: [] },
} satisfies OrchestrationV2ThreadLaunchInput;

const fixture = Effect.fn("RemoteTaskTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const attempts = yield* Queue.make<OrchestrationV2ThreadLaunchInput>();
  const stops = yield* Queue.make<OrchestrationV2ServerCommand>();
  const persistedOffline = yield* Queue.make<void>();
  const wakes = yield* Queue.make<OrchestrationV2ServerCommand>();
  const wakeAttempts = yield* Queue.make<OrchestrationV2ServerCommand>();
  const wakeEntered = yield* Queue.make<void>();
  const wakeGate = yield* Deferred.make<void>();
  const historyReads = yield* Queue.make<ThreadId>();
  const watching = yield* Queue.make<void>();
  const events = yield* Queue.make<OrchestrationV2ShellStreamItem>();
  const receipts = new Set<string>();
  const launches = new Map<string, ThreadId>();
  const control: {
    online: boolean;
    guardedStop: boolean;
    rejectStop: boolean;
    genericStopFailure: boolean;
    loseStop: boolean;
    restart: boolean;
    loseLaunch: boolean;
    genericLaunchFailure: boolean;
    status: OrchestrationV2Run["status"];
    broader: boolean;
    question: boolean;
    approval: boolean;
    nested: boolean;
    parentDeleted: boolean;
    failWakeAfterCommit: boolean;
    deleted: boolean;
    bounded: boolean;
    continuation: boolean;
    unrelated: boolean;
    holdWake: boolean;
  } = {
    online: true,
    guardedStop: true,
    rejectStop: false,
    genericStopFailure: false,
    loseStop: false,
    restart: false,
    loseLaunch: false,
    genericLaunchFailure: false,
    status: "running",
    broader: false,
    question: false,
    approval: false,
    nested: false,
    parentDeleted: false,
    failWakeAfterCommit: false,
    deleted: false,
    bounded: false,
    continuation: false,
    unrelated: false,
    holdWake: false,
  };

  let destinationThreadId = ThreadId.make("unlaunched");
  const projection = (): OrchestrationV2ThreadProjection => {
    const base = idleThreadProjection(
      liveThreadShell(destinationThreadId, {
        runtimeMode: control.broader ? "full-access" : "auto",
        interactionMode: "plan",
      }),
    );
    const run: OrchestrationV2Run = {
      id: runId,
      threadId: destinationThreadId,
      ordinal: 1,
      providerInstanceId: launch.modelSelection.instanceId,
      modelSelection: launch.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("initial"),
      rootNodeId: null,
      activeAttemptId: null,
      status: control.status,
      requestedAt: now,
      startedAt: now,
      completedAt: control.status === "running" ? null : now,
      checkpointId: null,
      contextHandoffId: null,
    };
    return {
      ...base,
      runs: [
        run,
        ...(control.continuation || control.unrelated || control.restart
          ? [
              {
                ...run,
                id: RunId.make("later-run"),
                ordinal: 2,
                ...(control.restart ? { restartContinuationOfRunId: runId } : {}),
                userMessageId: MessageId.make("later-input"),
                status: "running" as const,
              },
            ]
          : []),
      ],
      messages: [
        ...(control.continuation || control.unrelated || control.restart
          ? [
              {
                id: MessageId.make("later-input"),
                threadId: destinationThreadId,
                runId: RunId.make("later-run"),
                nodeId: null,
                role: "user" as const,
                text: "later input",
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
                createdBy: "agent" as const,
                creationSource: "server" as const,
                ...(control.continuation
                  ? {
                      delegatedCompletion: {
                        parentRunId: runId,
                        generation: 1,
                        taskIds: [NodeId.make("nested")],
                      },
                    }
                  : {}),
              },
            ]
          : []),
        {
          id: MessageId.make("result"),
          threadId: destinationThreadId,
          runId,
          nodeId: null,
          role: "assistant",
          text: "Frozen result from B",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          createdBy: "agent",
          creationSource: "provider",
        },
      ],
      nodes:
        control.question || control.approval
          ? [
              {
                id: NodeId.make("request-node"),
                threadId: destinationThreadId,
                runId,
                parentNodeId: null,
                rootNodeId: NodeId.make("request-node"),
                kind: "user_input_request",
                status: "waiting",
                countsForRun: true,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: RuntimeRequestId.make("question"),
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            ]
          : [],
      runtimeRequests:
        control.question || control.approval
          ? [
              {
                id: RuntimeRequestId.make("question"),
                nodeId: NodeId.make("request-node"),
                providerTurnId: null,
                nativeRequestRef: null,
                kind: control.approval ? "command" : "user_input",
                status: "pending",
                responseCapability: {
                  type: "live",
                  providerSessionId: ProviderSessionId.make("session"),
                },
                createdAt: now,
                resolvedAt: null,
              },
            ]
          : [],
      subagents: control.nested
        ? [
            {
              id: NodeId.make("nested"),
              threadId: destinationThreadId,
              runId,
              parentNodeId: NodeId.make("root"),
              origin: "app_owned",
              createdBy: "agent",
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: launch.modelSelection.instanceId,
              providerThreadId: null,
              childThreadId: ThreadId.make("nested-child"),
              nativeTaskRef: null,
              prompt: "nested",
              title: null,
              model: "test",
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          ]
        : [],
    };
  };
  const config = yield* decodeConfig({
    environment: {
      environmentId,
      label: "Box B",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "test",
      capabilities: { repositoryIdentity: false, remoteTaskStop: true },
    },
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "test",
    },
    cwd: "/test",
    keybindingsConfigPath: "/test/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    settings: {},
    observability: {
      logsDirectoryPath: "/test/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
  });
  const fixtureScope = yield* Effect.scope;
  let write: (
    message: RpcMessage.FromServer<RpcGroup.Rpcs<typeof WsRpcGroup>>,
  ) => Effect.Effect<void> = () => Effect.void;
  const subscriptions = new Map<RpcMessage.RequestId, Fiber.Fiber<void>>();
  const rpc = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
    onFromClient: ({ message }): Effect.Effect<void, RpcClientError> =>
      Effect.gen(function* () {
        if (message._tag === "Interrupt") {
          const fiber = subscriptions.get(message.requestId);
          if (fiber) yield* Fiber.interrupt(fiber);
          return;
        }
        if (message._tag !== "Request") return;

        switch (message.tag) {
          case ORCHESTRATION_V2_WS_METHODS.launchThread: {
            const input = yield* decodeLaunch(message.payload).pipe(Effect.orDie);
            destinationThreadId = input.threadId ?? ThreadId.make("missing");
            launches.set(input.commandId, destinationThreadId);
            yield* Queue.offer(attempts, input);
            if (control.genericLaunchFailure) {
              control.genericLaunchFailure = false;
              return yield* write({
                _tag: "Exit",
                clientId: 0,
                requestId: message.id,
                exit: Exit.fail(
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: "Projection failed after initial message committed",
                  }),
                ),
              });
            }
            if (control.loseLaunch) {
              control.loseLaunch = false;
              return yield* new RpcClientError({
                reason: new RpcClientDefect({
                  message: "Response lost after commit",
                  cause: undefined,
                }),
              });
            }
            return yield* write({
              _tag: "Exit",
              clientId: 0,
              requestId: message.id,
              exit: Exit.succeed({
                threadId: destinationThreadId,
                projection: projection(),
                resumed: launches.size > 1,
              }),
            });
          }
          case ORCHESTRATION_V2_WS_METHODS.getThreadProjection:
            return yield* write({
              _tag: "Exit",
              clientId: 0,
              requestId: message.id,
              exit: control.deleted
                ? Exit.fail(
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: destinationThreadId,
                      message: "Thread not found",
                    }),
                  )
                : Exit.succeed(
                    control.bounded
                      ? { ...projection(), messages: [], turnItems: [] }
                      : projection(),
                  ),
            });
          case ORCHESTRATION_V2_WS_METHODS.dispatchCommand: {
            const command = yield* decodeCommand(message.payload).pipe(Effect.orDie);
            yield* Queue.offer(stops, command);
            if (control.loseStop) {
              control.loseStop = false;
              return yield* new RpcClientError({
                reason: new RpcClientDefect({ message: "Lost stop reply", cause: undefined }),
              });
            }
            if (control.genericStopFailure) {
              control.genericStopFailure = false;
              return yield* write({
                _tag: "Exit",
                clientId: 0,
                requestId: message.id,
                exit: Exit.fail(
                  new OrchestrationV2DispatchCommandError({
                    commandId: command.commandId,
                    commandType: command.type,
                    message: "Failed to read command receipt",
                  }),
                ),
              });
            }
            if (control.rejectStop)
              return yield* write({
                _tag: "Exit",
                clientId: 0,
                requestId: message.id,
                exit: Exit.fail(
                  new OrchestrationV2DispatchCommandError({
                    commandId: command.commandId,
                    commandType: command.type,
                    message: "Atomic cohort changed",
                    outcome: "rejected",
                  }),
                ),
              });
            return yield* write({
              _tag: "Exit",
              clientId: 0,
              requestId: message.id,
              exit: Exit.succeed({ sequence: 1 }),
            });
          }
          case ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot:
            return yield* write({
              _tag: "Exit",
              clientId: 0,
              requestId: message.id,
              exit: Exit.succeed({
                schemaVersion: 1,
                snapshotSequence: 1,
                projects: [],
                threads: [],
              }),
            });
          case ORCHESTRATION_V2_WS_METHODS.subscribeThread: {
            const payload = yield* decodeThreadPayload(message.payload).pipe(Effect.orDie);
            yield* Queue.offer(historyReads, payload.threadId);
            const full =
              payload.threadId === destinationThreadId
                ? projection()
                : idleThreadProjection(
                    liveThreadShell(payload.threadId, {
                      runtimeMode: "auto",
                      interactionMode: "plan",
                    }),
                  );
            return yield* write({
              _tag: "Chunk",
              clientId: 0,
              requestId: message.id,
              // @ts-expect-error -- Rpc.SuccessChunk does not distribute over mixed unary/stream RPC unions.
              values: [{ kind: "snapshot", snapshotSequence: 1, projection: full }],
            });
          }
          case ORCHESTRATION_V2_WS_METHODS.subscribeShell: {
            const fiber = yield* Stream.fromQueue(events).pipe(
              Stream.runForEach((event) =>
                write({
                  _tag: "Chunk",
                  clientId: 0,
                  requestId: message.id,
                  // @ts-expect-error -- Rpc.SuccessChunk does not distribute over mixed unary/stream RPC unions.
                  values: [event],
                }),
              ),
              Effect.forkIn(fixtureScope),
            );
            subscriptions.set(message.id, fiber);
            const snapshot: OrchestrationV2ShellStreamItem = {
              kind: "snapshot",
              snapshot: {
                schemaVersion: 1,
                snapshotSequence: 1,
                threads: control.deleted ? [] : [liveThreadShell(destinationThreadId)],
                archivedThreads: [],
                projects: [],
              },
            };
            yield* write({
              _tag: "Chunk",
              clientId: 0,
              requestId: message.id,
              // @ts-expect-error -- Rpc.SuccessChunk does not distribute over mixed unary/stream RPC unions.
              values: [snapshot],
            });
            yield* Queue.offer(watching, undefined);
            return;
          }
          default:
            return yield* Effect.die(`Unexpected RPC ${message.tag}`);
        }
      }),
  });
  write = rpc.write;
  const client = rpc.client;
  const fileSystem = Layer.succeed(FileSystem.FileSystem, {
    ...fs,
    rename: (from, to) =>
      fs.rename(from, to).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            const record = yield* decodeJsonObject(yield* fs.readFileString(to)).pipe(Effect.orDie);
            if (
              record.reachability === "offline" &&
              (record.stopPlan !== null || (record.phase === "launching" && launches.size > 0))
            )
              yield* Queue.offer(persistedOffline, undefined);
          }),
        ),
      ),
  });
  const deps = Layer.mergeAll(
    ServerConfig.layerTest("/test", directory),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("box-a")),
    }),
    Layer.mock(Registry.PeerEnvironmentRegistry)({
      get: () =>
        Effect.succeed({
          environmentId,
          label: "Box B",
          httpBaseUrl: "http://box-b",
          bearerToken: "test-token",
          maxRuntimeMode: "auto",
        }),
    }),
    Layer.mock(RemoteClient.RemoteEnvironmentClient)({
      connect: () =>
        control.online
          ? Effect.succeed({
              client,
              config: {
                ...config,
                environment: {
                  ...config.environment,
                  capabilities: {
                    ...config.environment.capabilities,
                    remoteTaskStop: control.guardedStop,
                  },
                },
              },
            })
          : Effect.fail(new RemoteClient.RemoteEnvironmentError({ reason: "unavailable" })),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: Effect.fn("RemoteTaskTest.parentShell")(function* (id) {
        if (control.holdWake) {
          yield* Queue.offer(wakeEntered, undefined);
          yield* Deferred.await(wakeGate);
        }
        return control.parentDeleted ? null : liveThreadShell(id);
      }),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Queue.offer(wakeAttempts, command);
          if (!receipts.has(command.commandId)) {
            receipts.add(command.commandId);
            yield* Queue.offer(wakes, command);
          }
          if (control.failWakeAfterCommit) {
            control.failWakeAfterCommit = false;
            return yield* Effect.die("crash after committed wake");
          }
          return { sequence: 1, storedEvents: [] };
        }),
    }),
  ).pipe(Layer.provideMerge(fileSystem));
  const open = Effect.fn("RemoteTaskTest.open")(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.buildWithScope(Tasks.layer.pipe(Layer.provide(deps)), scope);
    return { service: Context.get(context, Tasks.RemoteTaskService), scope };
  });
  const delegate = (service: Tasks.RemoteTaskService["Service"], requestId = "request") =>
    service.delegate({
      parentThreadId,
      parentRunId: RunId.make("parent-run"),
      requestId,
      environmentId,
      launch,
    });
  const start = (opened: Effect.Success<ReturnType<typeof open>>) =>
    opened.service.start.pipe(Scope.provide(opened.scope));
  const changed = Effect.suspend(() =>
    Queue.offer(events, {
      kind: "thread.updated",
      sequence: 1,
      location: "active",
      thread: liveThreadShell(destinationThreadId),
    }),
  );
  return {
    persistedOffline,
    open,
    start,
    delegate,
    control,
    events,
    wakeEntered,
    wakeGate,
    historyReads,
    attempts,
    stops,
    wakes,
    wakeAttempts,
    watching,
    changed,
    launches,
    directory,
  };
});

it.effect(
  "lost launch response retries the identical durable launch and adopts one destination thread",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();

      f.control.loseLaunch = true;
      const first = yield* f.open();

      const task = yield* f.delegate(first.service);
      yield* f.start(first);

      const initial = yield* Queue.take(f.attempts);

      yield* Scope.close(first.scope, Exit.void);

      const second = yield* f.open();

      expect(yield* second.service.existing(parentThreadId, "request")).toMatchObject({
        taskId: task.taskId,
      });
      yield* f.start(second);
      const retried = yield* Queue.take(f.attempts);

      yield* Queue.take(f.watching);
      expect(retried).toEqual(initial);
      expect(f.launches.size).toBe(1);
      expect(yield* f.delegate(second.service)).toMatchObject({
        taskId: task.taskId,
        childRunId: runId,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("offline cancellation survives restart and interrupts only the bound run", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const first = yield* f.open();
    const task = yield* f.delegate(first.service);
    yield* f.start(first);
    yield* Queue.take(f.watching);
    f.control.online = false;
    yield* first.service.cancel(parentThreadId, task.taskId, launch);
    yield* Scope.close(first.scope, Exit.void);
    f.control.online = true;
    const second = yield* f.open();
    yield* f.start(second);
    expect(yield* Queue.take(f.stops)).toMatchObject({
      type: "remote-task.stop",
      threadId: task.childThreadId,
      commandId: `${task.taskId}:stop:1`,
    });
    yield* Queue.take(f.watching);
    f.control.status = "cancelled";
    yield* f.changed;
    expect(yield* Queue.take(f.wakes)).toMatchObject({
      type: "message.dispatch",
      notification: { outcome: "cancelled" },
    });
    expect(yield* second.service.status(parentThreadId, task.taskId)).toMatchObject({
      status: "cancelled",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "terminal result is frozen and committed wake receipts survive a lost response and restart",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.open();
      const task = yield* f.delegate(first.service);
      yield* f.start(first);
      yield* Queue.take(f.watching);
      f.control.status = "completed";
      f.control.failWakeAfterCommit = true;
      yield* f.changed;
      const wake = yield* Queue.take(f.wakes);
      if (wake.type !== "message.dispatch") throw new Error("Expected a parent wake message.");
      expect(wake.notification?.source).toMatchObject({ kind: "delegated_task" });
      expect(wake.notification?.source).not.toHaveProperty("childThreadId");
      const frozen = yield* first.service.wait(parentThreadId, task.taskId, 0);
      expect(frozen).toMatchObject({ status: "completed", summary: "Frozen result from B" });
      yield* Scope.close(first.scope, Exit.void);
      const second = yield* f.open();
      yield* f.start(second);
      expect(yield* second.service.status(parentThreadId, task.taskId)).toEqual(frozen);
      yield* Queue.take(f.wakeAttempts);
      expect((yield* Queue.take(f.wakeAttempts)).commandId).toBe(wake.commandId);
      expect(yield* Queue.size(f.wakes)).toBe(0);
      expect(wake.commandId).toBe(`${task.taskId}:wake:terminal`);
      expect(f.launches.size).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("another parent cannot read, wait, or cancel a durable handle", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const { service } = yield* f.open();
    const task = yield* f.delegate(service);
    const other = ThreadId.make("other-parent");
    for (const effect of [
      service.status(other, task.taskId),
      service.cancel(other, task.taskId, launch),
      service.wait(other, task.taskId, 0),
    ]) {
      expect(yield* Effect.flip(effect)).toMatchObject({ reason: "task_not_found" });
    }
    expect(yield* service.existing(other, "request")).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("terminal initial run stays waiting while its nested delegated work is active", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.status = "completed";
    f.control.nested = true;
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    expect(yield* opened.service.status(parentThreadId, task.taskId)).toMatchObject({
      status: "running",
      workState: "waiting_for_children",
      hasPendingChildRuns: true,
    });
    f.control.nested = false;
    yield* f.changed;
    yield* Queue.take(f.wakes);
    expect(yield* opened.service.status(parentThreadId, task.taskId)).toMatchObject({
      status: "completed",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("live pending questions and approvals end wait without completing the task", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.question = true;
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    expect(yield* opened.service.wait(parentThreadId, task.taskId, 0)).toMatchObject({
      hasPendingQuestion: true,
      waitTimedOut: false,
      status: "running",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancellation rejects a destination whose authority grew beyond the launch ceiling", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    f.control.broader = true;
    expect(
      yield* Effect.flip(opened.service.cancel(parentThreadId, task.taskId, launch)),
    ).toMatchObject({ reason: "mode_exceeded" });
    expect(yield* Queue.take(f.wakes)).toMatchObject({
      type: "message.dispatch",
      notification: { outcome: "updated" },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("current caller limits reject cancellation before any durable intent is recorded", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    expect(
      yield* Effect.flip(
        opened.service.cancel(parentThreadId, task.taskId, {
          runtimeMode: "approval-required",
          interactionMode: "plan",
        }),
      ),
    ).toMatchObject({ reason: "mode_exceeded" });
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(`${f.directory}/userdata/remote-tasks`);
    const record = yield* fs.readFileString(`${f.directory}/userdata/remote-tasks/${names[0]}`);
    expect(JSON.parse(record)).toMatchObject({ cancelRequested: false, cancelLimits: null });
    expect(yield* Queue.size(f.stops)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "owned completion continuations and nested tasks use a subtree stop after full preflight",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.control.status = "completed";
      f.control.continuation = true;
      f.control.nested = true;
      const opened = yield* f.open();
      const task = yield* f.delegate(opened.service);
      yield* f.start(opened);
      yield* Queue.take(f.watching);
      yield* opened.service.cancel(parentThreadId, task.taskId, launch);
      expect(yield* Queue.take(f.stops)).toMatchObject({
        type: "remote-task.stop",
        threadId: task.childThreadId,
      });
      const reads = yield* Queue.takeAll(f.historyReads);
      expect(reads).toContain(ThreadId.make("nested-child"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("unrelated later user turns prohibit a thread-wide stop", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.unrelated = true;
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    expect(
      yield* Effect.flip(opened.service.cancel(parentThreadId, task.taskId, launch)),
    ).toMatchObject({ reason: "destination_reused" });
    expect(yield* Queue.size(f.stops)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("authoritative absence after offline restart reports deletion and wakes the parent", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const first = yield* f.open();
    const task = yield* f.delegate(first.service);
    yield* f.start(first);
    yield* Queue.take(f.watching);
    yield* Scope.close(first.scope, Exit.void);
    f.control.deleted = true;
    const second = yield* f.open();
    yield* f.start(second);
    expect(yield* Queue.take(f.wakes)).toMatchObject({
      notification: { outcome: "failed", summary: "Remote thread was deleted." },
    });
    expect(yield* second.service.status(parentThreadId, task.taskId)).toMatchObject({
      status: "failed",
      reachability: "online",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("paged-out bound assistant output is restored before terminal publication", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.bounded = true;
    f.control.status = "completed";
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    expect(yield* Queue.take(f.historyReads)).toBe(task.childThreadId);
    expect(yield* Queue.take(f.wakes)).toMatchObject({
      notification: { summary: "Frozen result from B" },
    });
    expect(yield* opened.service.status(parentThreadId, task.taskId)).toMatchObject({
      summary: "Frozen result from B",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("wait cannot steal an already claimed terminal wake while dispatch is in flight", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    f.control.holdWake = true;
    f.control.status = "completed";
    yield* f.changed;
    yield* Queue.take(f.wakeEntered);
    expect(yield* opened.service.wait(parentThreadId, task.taskId, 0)).toMatchObject({
      status: "completed",
      waitTimedOut: false,
    });
    yield* Deferred.succeed(f.wakeGate, undefined);
    expect(yield* Queue.take(f.wakes)).toMatchObject({ commandId: `${task.taskId}:wake:terminal` });
    expect(yield* Queue.size(f.wakes)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a pending live approval ends wait", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.approval = true;
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    expect(yield* opened.service.wait(parentThreadId, task.taskId, 0)).toMatchObject({
      status: "running",
      waitTimedOut: false,
      pendingApproval: { kind: "command", runId },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "empty marked enrichment and stale shell snapshots cannot delete an existing destination",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const opened = yield* f.open();
      const task = yield* f.delegate(opened.service);
      yield* f.start(opened);
      yield* Queue.take(f.watching);
      yield* Queue.offer(f.events, {
        kind: "snapshot",
        resolvedRepositoryIdentityRoots: [],
        snapshot: {
          schemaVersion: 1,
          snapshotSequence: 2,
          threads: [],
          archivedThreads: [],
          projects: [],
        },
      });
      // A queued owned stop is a milestone after the earlier snapshot has been processed.
      yield* opened.service.cancel(parentThreadId, task.taskId, launch);
      yield* Queue.take(f.stops);
      expect(yield* opened.service.status(parentThreadId, task.taskId)).toMatchObject({
        status: "running",
        reachability: "online",
      });
      expect(yield* Queue.size(f.wakes)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["status", "wait"] as const)(
  "terminal %s acknowledges pending delivery across restart",
  (method) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.open();
      const task = yield* f.delegate(first.service);
      yield* Scope.close(first.scope, Exit.void);
      const fs = yield* FileSystem.FileSystem;
      const directory = `${f.directory}/userdata/remote-tasks`;
      const names = yield* fs.readDirectory(directory);
      const file = `${directory}/${names[0]}`;
      const record = yield* decodeJsonObject(yield* fs.readFileString(file));
      // Model a crash after final snapshot persistence, before the delivery owner was chosen.
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          ...record,
          phase: "terminal",
          status: "completed",
          workState: "result_available",
          summary: "Durable final result",
        }),
      );
      const second = yield* f.open();
      const result = yield* method === "status"
        ? second.service.status(parentThreadId, task.taskId)
        : second.service.wait(parentThreadId, task.taskId, 0);
      expect(result).toMatchObject({ status: "completed", summary: "Durable final result" });
      yield* f.start(second);
      const saved = yield* decodeJsonObject(yield* fs.readFileString(file));
      expect(saved.delivery).toBe("wait");
      expect(yield* Queue.size(f.wakes)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a held initial queued run is explicitly cancelled rather than left nonterminal", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.status = "queued";
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    yield* opened.service.cancel(parentThreadId, task.taskId, launch);
    expect(yield* Queue.take(f.stops)).toMatchObject({
      type: "remote-task.stop",
      threadId: task.childThreadId,
    });
    expect(yield* Queue.size(f.stops)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("destinations without guarded stop support reject cancellation without a stop", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.guardedStop = false;
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    expect(
      yield* Effect.flip(opened.service.cancel(parentThreadId, task.taskId, launch)),
    ).toMatchObject({ reason: "cancel_blocked" });
    yield* Queue.take(f.wakes);
    expect(yield* Queue.size(f.stops)).toBe(0);
    expect(yield* opened.service.status(parentThreadId, task.taskId)).toMatchObject({
      reachability: "online",
      status: "running",
      summary: expect.stringContaining("guarded cancellation"),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "offline cancellation rechecks guarded support after restart and wakes instead of stopping",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.open();
      const task = yield* f.delegate(first.service);
      yield* f.start(first);
      yield* Queue.take(f.watching);
      f.control.online = false;
      yield* first.service.cancel(parentThreadId, task.taskId, launch);
      yield* Scope.close(first.scope, Exit.void);
      f.control.online = true;
      f.control.guardedStop = false;
      const second = yield* f.open();
      yield* f.start(second);
      yield* Queue.take(f.wakes);
      expect(yield* Queue.size(f.stops)).toBe(0);
      expect(yield* second.service.status(parentThreadId, task.taskId)).toMatchObject({
        reachability: "online",
        status: "running",
        summary: expect.stringContaining("guarded cancellation"),
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a definitive guarded rejection permits a fresh stop transaction ID", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.rejectStop = true;
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    yield* opened.service.cancel(parentThreadId, task.taskId, launch);
    const rejected = yield* Queue.take(f.stops);
    yield* Queue.take(f.wakes);
    f.control.rejectStop = false;
    yield* opened.service.cancel(parentThreadId, task.taskId, launch);
    const accepted = yield* Queue.take(f.stops);
    expect(rejected).toMatchObject({
      type: "remote-task.stop",
      commandId: `${task.taskId}:stop:1`,
    });
    expect(accepted).toMatchObject({
      type: "remote-task.stop",
      commandId: `${task.taskId}:stop:2`,
    });
    yield* Queue.take(f.watching);
    expect(yield* Queue.size(f.stops)).toBe(0);
    expect(yield* opened.service.status(parentThreadId, task.taskId)).toMatchObject({
      reachability: "online",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a lost guarded stop response replays the frozen transaction across restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.loseStop = true;
    const first = yield* f.open();
    const task = yield* f.delegate(first.service);
    yield* f.start(first);
    yield* Queue.take(f.watching);
    yield* first.service.cancel(parentThreadId, task.taskId, launch);
    const uncertain = yield* Queue.take(f.stops);
    yield* Scope.close(first.scope, Exit.void);
    f.control.guardedStop = false;
    const second = yield* f.open();
    yield* f.start(second);
    yield* Queue.take(f.wakes);
    expect(yield* Queue.size(f.stops)).toBe(0);
    yield* Scope.close(second.scope, Exit.void);
    f.control.guardedStop = true;
    const third = yield* f.open();
    yield* third.service.cancel(parentThreadId, task.taskId, launch);
    yield* f.start(third);
    const replay = yield* Queue.take(f.stops);
    expect(replay).toEqual(uncertain);
    expect(replay).toMatchObject({ type: "remote-task.stop", initialRunId: runId });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("restart continuations remain owned work for completion and guarded cancellation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.control.status = "completed";
    f.control.restart = true;
    const opened = yield* f.open();
    const task = yield* f.delegate(opened.service);
    yield* f.start(opened);
    yield* Queue.take(f.watching);
    expect(yield* opened.service.status(parentThreadId, task.taskId)).toMatchObject({
      status: "running",
    });
    yield* opened.service.cancel(parentThreadId, task.taskId, launch);
    expect(yield* Queue.take(f.stops)).toMatchObject({
      type: "remote-task.stop",
      expectedThreads: [
        { threadId: task.childThreadId, runIds: [runId, "later-run"], subagentIds: [] },
      ],
    });
    expect(yield* Queue.size(f.wakes)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "generic dispatch failures automatically retry the same frozen stop transaction after restart",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.control.genericStopFailure = true;
      const opened = yield* f.open();
      const task = yield* f.delegate(opened.service);
      yield* f.start(opened);
      yield* Queue.take(f.watching);
      yield* opened.service.cancel(parentThreadId, task.taskId, launch);
      const uncertain = yield* Queue.take(f.stops);
      yield* Queue.take(f.persistedOffline);
      yield* Scope.close(opened.scope, Exit.void);
      const recovered = yield* f.open();
      yield* f.start(recovered);
      const retried = yield* Queue.take(f.stops);
      expect(retried).toEqual(uncertain);
      expect(retried).toMatchObject({
        type: "remote-task.stop",
        commandId: `${task.taskId}:stop:1`,
      });
      yield* Queue.take(f.watching);
      expect(yield* Queue.size(f.wakes)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a generic launch error after acceptance retries the identical launch and delivers its result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.control.genericLaunchFailure = true;
      const first = yield* f.open();
      const task = yield* f.delegate(first.service);
      yield* f.start(first);
      const uncertain = yield* Queue.take(f.attempts);
      yield* Queue.take(f.persistedOffline);
      expect(yield* first.service.status(parentThreadId, task.taskId)).toMatchObject({
        status: "queued",
      });
      expect(yield* Queue.size(f.wakes)).toBe(0);
      yield* Scope.close(first.scope, Exit.void);
      f.control.status = "completed";
      const second = yield* f.open();
      yield* f.start(second);
      expect(yield* Queue.take(f.attempts)).toEqual(uncertain);
      yield* Queue.take(f.wakes);
      expect(f.launches.size).toBe(1);
      expect(yield* second.service.status(parentThreadId, task.taskId)).toMatchObject({
        status: "completed",
        summary: "Frozen result from B",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
