import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        restartContinuationPending: () => Effect.succeed(false),
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(layerTest));
});

it.effect.each(["user_input", "command"] as const)(
  "thread watches wake for %s, acknowledge it, and keep waiting for completion",
  (kind) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const subscribed = yield* Deferred.make<void>();
      const resubscribed = yield* Deferred.make<void>();
      let subscriptions = 0;
      const threadId = ThreadId.make("watched-thread");
      const projectId = ProjectId.make("watched-project");
      const runId = RunId.make("watched-run");
      const nodeId = NodeId.make("watched-node");
      let pending = false;
      let status: OrchestrationV2Run["status"] = "running";
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            restartContinuationPending: () => Effect.succeed(false),
            getThreadEventSequence: () => Effect.succeed(0),
            streamStoredEventsFrom: (input) =>
              input?.eventType === "runtime-request.updated"
                ? Stream.fromEffect(
                    Deferred.succeed(
                      subscriptions++ === 0 ? subscribed : resubscribed,
                      undefined,
                    ).pipe(Effect.asVoid),
                  ).pipe(Stream.drain, Stream.concat(Stream.fromQueue(events)))
                : Stream.never,
            getThreadRecords: () =>
              Effect.sync(
                () =>
                  ({
                    thread: { id: threadId, projectId, deletedAt: null },
                    runs: [{ id: runId, status }],
                    nodes: [{ id: nodeId, runId }],
                    runtimeRequests: pending
                      ? [{ id: "request", nodeId, kind, status: "pending" }]
                      : [],
                    turnItems: pending
                      ? [
                          {
                            id: "question",
                            requestId: "request",
                            type: kind === "user_input" ? "user_input_request" : "approval_request",
                            status: "waiting",
                            runId,
                            questions: [
                              { id: "question", question: "May I continue?", options: [] },
                            ],
                          },
                        ]
                      : [],
                  }) as unknown as OrchestrationV2ThreadProjection,
              ),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      const first = yield* service
        .waitForThread({ projectId, threadId, runId, timeoutMs: 60_000, seenRequestIds: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      pending = true;
      yield* Queue.offer(events, {
        sequence: 1,
        event: { threadId, type: "runtime-request.updated" },
      } as unknown as OrchestrationV2StoredEvent);
      const notice = yield* Fiber.join(first);
      expect(notice.pendingRequests?.map((item) => item.requestId)).toEqual(["request"]);
      expect(notice.run?.status).toBe("running");
      const second = yield* service
        .waitForThread({
          projectId,
          threadId,
          runId,
          timeoutMs: 60_000,
          seenRequestIds: ["request"],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(resubscribed);
      // The queue is retained across event-driven waits; no sleep or polling is needed.
      status = "completed";
      yield* Queue.offer(events, {
        sequence: 2,
        event: { threadId, type: "runtime-request.updated" },
      } as unknown as OrchestrationV2StoredEvent);
      const finished = yield* Fiber.join(second);
      expect(finished.run?.status).toBe("completed");
      expect(finished.pendingRequests ?? []).toEqual([]);
    }),
);

it.effect(
  "an explicit watch follows an idle thread across completed runs without repeating a result",
  () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const subscribed = yield* Deferred.make<void>();
      const resubscribed = yield* Deferred.make<void>();
      let subscriptions = 0;
      let ordinal = 0;
      const threadId = ThreadId.make("future-thread");
      const projectId = ProjectId.make("future-project");
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            restartContinuationPending: () => Effect.succeed(false),
            getThreadEventSequence: () => Effect.succeed(0),
            streamStoredEventsFrom: (input) =>
              input?.eventType === "run.updated"
                ? Stream.fromEffect(
                    Deferred.succeed(
                      subscriptions++ === 0 ? subscribed : resubscribed,
                      undefined,
                    ).pipe(Effect.asVoid),
                  ).pipe(Stream.drain, Stream.concat(Stream.fromQueue(events)))
                : Stream.never,
            getThreadRecords: () =>
              Effect.sync(
                () =>
                  ({
                    thread: { id: threadId, projectId, deletedAt: null },
                    runs:
                      ordinal === 0
                        ? []
                        : [
                            {
                              id: RunId.make(`future-run-${ordinal}`),
                              ordinal,
                              status: "completed",
                            },
                          ],
                    nodes: [],
                    runtimeRequests: [],
                    turnItems: [],
                  }) as unknown as OrchestrationV2ThreadProjection,
              ),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      const first = yield* service
        .waitForThread({
          projectId,
          threadId,
          timeoutMs: 60_000,
          followThread: true,
          seenRequestIds: [],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      ordinal = 1;
      yield* Queue.offer(events, {
        sequence: 1,
        event: { threadId, type: "run.updated", payload: { id: "future-run-1" } },
      } as unknown as OrchestrationV2StoredEvent);
      expect((yield* Fiber.join(first)).run?.id).toBe("future-run-1");
      const second = yield* service
        .waitForThread({
          projectId,
          threadId,
          timeoutMs: 60_000,
          followThread: true,
          seenRequestIds: [],
          completionAfterOrdinal: 1,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(resubscribed);
      ordinal = 2;
      yield* Queue.offer(events, {
        sequence: 2,
        event: { threadId, type: "run.updated", payload: { id: "future-run-2" } },
      } as unknown as OrchestrationV2StoredEvent);
      expect((yield* Fiber.join(second)).run?.id).toBe("future-run-2");
    }),
);

it.effect.each([
  { kind: "user_input", terminalStatus: "completed" },
  { kind: "command", terminalStatus: "completed" },
  { kind: "user_input", terminalStatus: "failed" },
  { kind: "command", terminalStatus: "failed" },
] as const)(
  "follow watches replay $kind ahead of queued work, acknowledge $terminalStatus, and await the next run",
  ({ kind, terminalStatus }) =>
    Effect.gen(function* () {
      const runEvents = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const requestEvents = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      let subscribed = yield* Deferred.make<void>();
      const threadId = ThreadId.make("follow-queued-thread");
      const projectId = ProjectId.make("follow-queued-project");
      const runA = RunId.make("follow-run-a");
      const runB = RunId.make("follow-run-b");
      const nodeId = NodeId.make("follow-node-a");
      let statusA: OrchestrationV2Run["status"] = "running";
      let statusB: OrchestrationV2Run["status"] = "queued";
      let pending = false;
      let sequence = 10;
      let reads = 0;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            restartContinuationPending: () => Effect.succeed(false),
            getThreadEventSequence: () => Effect.sync(() => sequence),
            streamStoredEventsFrom: (input) => {
              const events =
                input?.eventType === "run.updated"
                  ? runEvents
                  : input?.eventType === "runtime-request.updated"
                    ? requestEvents
                    : undefined;
              if (events === undefined) return Stream.empty;
              return Stream.fromEffect(
                input?.eventType === "runtime-request.updated"
                  ? Deferred.succeed(subscribed, undefined)
                  : Effect.void,
              ).pipe(
                Stream.drain,
                Stream.concat(Stream.fromQueue(events)),
                Stream.filter((stored) => stored.sequence > (input?.afterSequence ?? 0)),
              );
            },
            getThreadRecords: () =>
              Effect.gen(function* () {
                const projection = {
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs: [
                    { id: runB, ordinal: 2, status: statusB },
                    { id: runA, ordinal: 1, status: statusA },
                  ],
                  nodes: [{ id: nodeId, runId: runA }],
                  runtimeRequests: pending
                    ? [{ id: "request-a", nodeId, kind, status: "pending" }]
                    : [],
                  turnItems: pending
                    ? [
                        {
                          id: "question-a",
                          requestId: "request-a",
                          type: kind === "user_input" ? "user_input_request" : "approval_request",
                          status: "waiting",
                          runId: runA,
                          questions: [{ id: "question", question: "May I continue?", options: [] }],
                        },
                      ]
                    : [],
                } as unknown as OrchestrationV2ThreadProjection;
                if (reads++ === 0) {
                  // The question arrives after this snapshot, before either stream subscribes.
                  pending = true;
                  yield* Queue.offer(requestEvents, {
                    sequence: ++sequence,
                    event: { threadId, type: "runtime-request.updated" },
                  } as unknown as OrchestrationV2StoredEvent);
                }
                return projection;
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      const wait = (seenRequestIds: readonly string[], completionAfterOrdinal?: number) =>
        service.waitForThread({
          projectId,
          threadId,
          followThread: true,
          timeoutMs: 60_000,
          seenRequestIds,
          ...(completionAfterOrdinal === undefined ? {} : { completionAfterOrdinal }),
        });
      const question = yield* wait([]);
      expect(question).toMatchObject({ timedOut: false, run: { id: runA, status: "running" } });
      expect(question.pendingRequests?.map((item) => item.requestId)).toEqual(["request-a"]);

      subscribed = yield* Deferred.make<void>();
      const afterQuestion = yield* wait(["request-a"]).pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      pending = false;
      statusA = terminalStatus;
      yield* Queue.offer(runEvents, {
        sequence: ++sequence,
        event: { threadId, type: "run.updated", payload: { id: runA } },
      } as unknown as OrchestrationV2StoredEvent);
      const resultA = yield* Fiber.join(afterQuestion);
      expect(resultA).toMatchObject({ timedOut: false, run: { id: runA, status: terminalStatus } });
      expect(resultA.pendingRequests ?? []).toEqual([]);

      subscribed = yield* Deferred.make<void>();
      const afterResult = yield* wait(["request-a"], 1).pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      statusB = "completed";
      yield* Queue.offer(runEvents, {
        sequence: ++sequence,
        event: { threadId, type: "run.updated", payload: { id: runB } },
      } as unknown as OrchestrationV2StoredEvent);
      expect(yield* Fiber.join(afterResult)).toMatchObject({
        timedOut: false,
        run: { id: runB, status: "completed" },
        pendingRequests: [],
      });
    }),
);

it.effect.each([
  { notice: "input", kind: "user_input", status: "running", runless: false },
  { notice: "approval", kind: "command", status: "running", runless: false },
  { notice: "completion", kind: null, status: "completed", runless: false },
  { notice: "failure", kind: null, status: "failed", runless: false },
  { notice: "runless input", kind: "user_input", status: "running", runless: true },
  { notice: "runless approval", kind: "command", status: "running", runless: true },
] as const)("follow watches select an existing $notice ahead of queued runs", (scenario) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("follow-existing-thread");
    const projectId = ProjectId.make("follow-existing-project");
    const runA = RunId.make("follow-existing-a");
    const runB = RunId.make("follow-existing-b");
    const historicalRun = RunId.make("follow-existing-history");
    const nodeId = NodeId.make("follow-existing-node");
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          restartContinuationPending: () => Effect.succeed(false),
          getThreadEventSequence: () => Effect.succeed(0),
          streamStoredEventsFrom: () => Stream.empty,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [
                { id: runB, ordinal: 3, status: "queued" },
                { id: runA, ordinal: 2, status: scenario.status },
                { id: historicalRun, ordinal: 1, status: "completed" },
              ],
              nodes: [{ id: nodeId, runId: scenario.runless ? null : runA }],
              runtimeRequests: scenario.kind
                ? [{ id: "request-a", nodeId, kind: scenario.kind, status: "pending" }]
                : [],
              turnItems: scenario.kind
                ? [
                    {
                      id: "question-a",
                      requestId: "request-a",
                      type:
                        scenario.kind === "user_input" ? "user_input_request" : "approval_request",
                      status: "waiting",
                      runId: scenario.runless ? null : runA,
                    },
                  ]
                : [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const wait = (seenRequestIds: readonly string[], completionAfterOrdinal?: number) =>
      service.waitForThread({
        projectId,
        threadId,
        followThread: true,
        timeoutMs: 60_000,
        seenRequestIds,
        ...(completionAfterOrdinal === undefined ? {} : { completionAfterOrdinal }),
      });
    const result = yield* wait([]);
    expect(result).toMatchObject({
      timedOut: false,
      run: scenario.runless ? null : { id: runA, status: scenario.status },
    });
    expect(result.pendingRequests?.map((item) => item.requestId) ?? []).toEqual(
      scenario.kind ? ["request-a"] : [],
    );
    if (scenario.kind) {
      expect(yield* wait(["request-a"])).toMatchObject({
        timedOut: true,
        run: { id: runB, status: "queued" },
      });
      // An explicit older cursor can include history, but requests still take priority.
      expect(yield* wait([], 0)).toMatchObject({
        timedOut: false,
        run: scenario.runless ? null : { id: runA, status: "running" },
      });
      expect(yield* wait(["request-a"], 0)).toMatchObject({
        timedOut: false,
        run: { id: historicalRun, status: "completed" },
      });
    } else {
      expect(yield* wait([], 0)).toMatchObject({
        timedOut: false,
        run: { id: historicalRun, status: "completed" },
      });
      expect(yield* wait([], 2)).toMatchObject({
        timedOut: true,
        run: { id: runB, status: "queued" },
      });
    }
  }),
);

it.effect(
  "follow watches keep a completion cursor past 513 historical runs while request acknowledgements rotate",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("follow-history-thread");
      const projectId = ProjectId.make("follow-history-project");
      const history = Array.from({ length: 513 }, (_, index) => ({
        id: RunId.make(`history-${index + 1}`),
        ordinal: index + 1,
        status: "completed" as const,
      })).toReversed();
      const runA = RunId.make("history-active-a");
      const runB = RunId.make("history-queued-b");
      const runC = RunId.make("history-future-c");
      let statusA: OrchestrationV2Run["status"] | undefined;
      let statusB: OrchestrationV2Run["status"] = "queued";
      let includeC = false;
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      let subscribed = yield* Deferred.make<void>();
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            restartContinuationPending: () => Effect.succeed(false),
            getThreadEventSequence: () => Effect.succeed(0),
            streamStoredEventsFrom: (input) =>
              input?.eventType === "run.updated"
                ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(events)),
                  )
                : Stream.never,
            getThreadRecords: () =>
              Effect.sync(
                () =>
                  ({
                    thread: { id: threadId, projectId, deletedAt: null },
                    runs: [
                      ...history,
                      ...(statusA === undefined
                        ? []
                        : [
                            { id: runB, ordinal: 515, status: statusB },
                            { id: runA, ordinal: 514, status: statusA },
                          ]),
                      ...(includeC ? [{ id: runC, ordinal: 516, status: "completed" }] : []),
                    ],
                    nodes: [],
                    runtimeRequests: [],
                    turnItems: [],
                  }) as unknown as OrchestrationV2ThreadProjection,
              ),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      const wait = (seenRequestIds: readonly string[], completionAfterOrdinal?: number) =>
        service.waitForThread({
          projectId,
          threadId,
          followThread: true,
          timeoutMs: 60_000,
          seenRequestIds,
          ...(completionAfterOrdinal === undefined ? {} : { completionAfterOrdinal }),
        });
      const seenRequestIds = Array.from({ length: 512 }, (_, index) => `request-${index}`);
      const latest = yield* wait(seenRequestIds);
      expect(latest).toMatchObject({ timedOut: false, run: { id: "history-513", ordinal: 513 } });

      // A default baseline includes waiting A even though queued B has the highest ordinal.
      statusA = "waiting";
      const active = yield* wait(seenRequestIds).pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      statusA = "completed";
      yield* Queue.offer(events, {
        sequence: 1,
        event: { threadId, type: "run.updated", payload: { id: runA } },
      } as unknown as OrchestrationV2StoredEvent);
      const resultA = yield* Fiber.join(active);
      expect(resultA).toMatchObject({ timedOut: false, run: { id: runA, ordinal: 514 } });

      subscribed = yield* Deferred.make<void>();
      const next = yield* wait(
        seenRequestIds.map((id) => `new-${id}`),
        resultA.run!.ordinal,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      statusB = "failed";
      yield* Queue.offer(events, {
        sequence: 2,
        event: { threadId, type: "run.updated", payload: { id: runB } },
      } as unknown as OrchestrationV2StoredEvent);
      const resultB = yield* Fiber.join(next);
      expect(resultB).toMatchObject({
        timedOut: false,
        run: { id: runB, ordinal: 515, status: "failed" },
      });

      subscribed = yield* Deferred.make<void>();
      const future = yield* wait([], resultB.run!.ordinal).pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      includeC = true;
      yield* Queue.offer(events, {
        sequence: 3,
        event: { threadId, type: "run.updated", payload: { id: runC } },
      } as unknown as OrchestrationV2StoredEvent);
      expect(yield* Fiber.join(future)).toMatchObject({
        timedOut: false,
        run: { id: runC, ordinal: 516 },
      });
    }),
);

it.effect.each(["explicit", "latest"] as const)(
  "waitForThread reads the %s selected run again only when that run updates",
  (selection) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:thread-management:wait-event");
      const threadId = ThreadId.make("thread:thread-management:wait-event");
      const runId = RunId.make("run:thread-management:wait-event");
      const subscribed = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      let status: OrchestrationV2Run["status"] = "running";
      let queued = false;
      let reads = 0;
      const stored = (sequence: number, event: object) =>
        ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            restartContinuationPending: () => Effect.succeed(false),
            getThreadEventSequence: () => Effect.succeed(0),
            // Only the run.updated stream carries events in this test.
            streamStoredEventsFrom: (input) =>
              input?.eventType === "run.updated"
                ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(events)),
                  )
                : Stream.never,
            getThreadRecords: () =>
              Effect.sync(() => {
                reads += 1;
                return {
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs: [
                    { id: runId, ordinal: 1, status },
                    ...(queued ? [{ id: "other-run", ordinal: 2, status: "queued" }] : []),
                  ],
                } as unknown as OrchestrationV2ThreadProjection;
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      const fiber = yield* service
        .waitForThread({
          projectId,
          threadId,
          ...(selection === "explicit" ? { runId } : {}),
          completionAfterOrdinal: 100,
          timeoutMs: 60 * 60 * 1_000,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      queued = true;
      status = "completed";
      yield* Queue.offer(events, stored(1, { type: "run.updated", payload: { id: "other-run" } }));
      yield* Queue.offer(
        events,
        stored(2, { type: "run.updated", payload: { id: runId, status } }),
      );
      const result = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "completed" } });
      // The first read plus one for this run's update. The other run caused none.
      expect(reads).toBe(2);
    }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          restartContinuationPending: () => Effect.succeed(false),
          getThreadEventSequence: () => Effect.succeed(0),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each(["live", "no-session", "unsupported-runtime"] as const)(
  "marks background work awaited on the thread's active provider thread with state %s",
  (state) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:background-wait");
      const providerThreadId = ProviderThreadId.make("provider-thread:background-wait");
      const providerSessionId = ProviderSessionId.make("provider-session:background-wait");
      const driver = ProviderDriverKind.make("claudeAgent");
      const now = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "tests", kind: "command" }],
        contextUsage: null,
        nativeMetadata: null,
        createdAt: now,
        updatedAt: now,
      };
      const calls: Array<{ providerThreadId: ProviderThreadId; awaited: boolean }> = [];
      const runtime = {
        driver,
        providerSessionId,
        ...(state === "unsupported-runtime"
          ? {}
          : {
              awaitBackgroundTasks: (input: {
                readonly providerThread: OrchestrationV2ProviderThread;
                readonly taskIds: ReadonlyArray<string>;
                readonly awaited: boolean;
              }) =>
                Effect.sync(() => {
                  calls.push({
                    providerThreadId: input.providerThread.id,
                    awaited: input.awaited,
                  });
                  return { matched: input.taskIds.filter((taskId) => taskId === "tests") };
                }),
            }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    deletedAt: null,
                    activeProviderThreadId: providerThreadId,
                  },
                  providerThreads: [providerThread],
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.succeed(state === "no-session" ? Option.none() : Option.some(runtime)),
            }),
          ),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        return yield* service
          .awaitBackgroundTasks({ threadId, taskIds: ["tests", "finished"], awaited: true })
          .pipe(Effect.result);
      }).pipe(Effect.provide(Layer.merge(layerTest, ThreadCommandExecutor.layer)));

      if (state === "live") {
        expect(result).toMatchObject({
          success: { matched: ["tests"], unmatched: ["finished"] },
        });
        expect(calls).toEqual([{ providerThreadId, awaited: true }]);
      } else {
        expect(result).toMatchObject({
          failure: {
            _tag: "ThreadManagementBackgroundWaitError",
            reason: state === "no-session" ? "unavailable" : "unsupported",
          },
        });
        expect(calls).toEqual([]);
      }
    }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);
