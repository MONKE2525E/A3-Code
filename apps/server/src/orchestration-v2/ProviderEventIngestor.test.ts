import { type OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  GitCommandError,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  PlanId,
  type ProviderSessionId,
  type ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { toolOutputImages } from "@t3tools/shared/toolOutput";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderEventRoutingState,
  type ProviderEventRouteIdentity,
  routeProviderEvent,
  selectInheritedBackgroundTurnItems,
} from "./RunExecutionService.ts";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);

const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-git-" })),
  Layer.provideMerge(NodeServices.layer),
);

const layerTest = Layer.mergeAll(
  layerTestDatabase,
  layerTestStores,
  layerTestEventSink,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  layerGit,
  ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerTestStores,
        layerTestEventSink,
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        layerGit,
      ),
    ),
  ),
);

const makeSharedWorktree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ingestor-worktree-" });
  const repo = `${directory}/repo`;
  const worktreePath = `${directory}/shared`;
  yield* fs.makeDirectory(repo);
  const command = (cwd: string, args: string[]) =>
    git.execute({ operation: "ingestor-test", cwd, args });
  yield* command(repo, ["init", "-b", "main"]);
  yield* command(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  yield* command(repo, ["worktree", "add", "-b", "t3/abcd1234", worktreePath]);
  return { repo, worktreePath, command };
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<
  Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
  IdAllocator.IdAllocatorV2Error,
  IdAllocator.IdAllocatorV2
> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });
}

const layer = it.layer(layerTest);

layer("native Muse observer ownership", (it) => {
  const fixture = (name: string, source = "muse-agent") =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`${source}:ownership-${name}`);
      const original = yield* threadCreatedEvent(now);
      yield* sink.write({
        events: [
          {
            ...original,
            threadId,
            payload: {
              ...original.payload,
              id: threadId,
              lineage: { ...original.payload.lineage, rootThreadId: threadId },
            },
          },
        ],
      });
      const driver = ProviderDriverKind.make(source);
      const providerSessionId = yield* allocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const pair = (text: string, owned: boolean, suffix = "answer") => {
        const message: OrchestrationV2ConversationMessage = {
          id: MessageId.make(`${threadId}:${suffix}`),
          threadId,
          runId: owned ? RunId.make(`${threadId}:run`) : null,
          nodeId: owned ? NodeId.make(`${threadId}:node`) : null,
          role: "assistant",
          createdBy: "agent",
          creationSource: "provider",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        };
        const turnItem: OrchestrationV2TurnItem = {
          id: TurnItemId.make(`${threadId}:item:${suffix}`),
          type: "assistant_message",
          threadId,
          runId: message.runId,
          nodeId: message.nodeId,
          providerThreadId: original.payload.activeProviderThreadId,
          providerTurnId: owned ? ProviderTurnId.make(`${threadId}:turn`) : null,
          nativeItemRef: { driver, nativeId: suffix, strength: "strong" },
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          messageId: message.id,
          text,
          attachments: [],
          streaming: false,
        };
        return { message, turnItem };
      };
      const normalize = (value: ReturnType<typeof pair>) =>
        Effect.gen(function* () {
          const input = {
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            threadId,
          };
          const messages = yield* ingestor.normalize({
            ...input,
            event: { type: "message.updated", driver, message: value.message },
          });
          const items = yield* ingestor.normalize({
            ...input,
            event: { type: "turn_item.updated", driver, turnItem: value.turnItem },
          });
          return [...messages, ...items];
        });
      const ingest = (value: ReturnType<typeof pair>) =>
        Effect.gen(function* () {
          const input = {
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            threadId,
          };
          const messages = yield* ingestor.ingestNormalized({
            ...input,
            event: { type: "message.updated", driver, message: value.message },
          });
          const items = yield* ingestor.ingestNormalized({
            ...input,
            event: { type: "turn_item.updated", driver, turnItem: value.turnItem },
          });
          return [...messages, ...items];
        });
      const saved = (value: ReturnType<typeof pair>) =>
        Effect.gen(function* () {
          const records = yield* store.getThreadRecords(threadId, ["messages"], {
            messageIds: [value.message.id],
          });
          const item = yield* store.getTurnItem({ threadId, itemId: value.turnItem.id });
          if (item?.type !== "assistant_message") throw new Error("expected assistant_message");
          return { message: records.messages[0]!, turnItem: item };
        });
      return { sink, threadId, pair, normalize, ingest, saved };
    });

  it.effect("rejects queued observer downgrades before event log and live publication", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture("downgrade");
        const owned = f.pair("Verified managed result", true);
        yield* f.ingest(owned);
        const sequence = yield* f.sink.latestSequence({ threadId: f.threadId });
        const live = yield* f.sink.stream({ threadId: f.threadId, afterSequence: sequence }).pipe(
          Stream.takeUntil(
            ({ event }) =>
              event.type === "message.updated" && event.payload.text === "Foreign observer marker",
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        assert.deepStrictEqual(yield* f.ingest(f.pair("Late runless replacement", false)), []);
        const marker = f.pair("Foreign observer marker", false, "foreign");
        yield* f.ingest(marker);
        const published = yield* Fiber.join(live);
        assert.deepStrictEqual(
          published.map(({ event }) => event.type),
          ["message.updated"],
        );
        assert.strictEqual(
          published[0]!.event.type === "message.updated" && published[0]!.event.payload.id,
          marker.message.id,
        );
        const saved = yield* f.saved(owned);
        assert.strictEqual(saved.message.text, "Verified managed result");
        assert.strictEqual(saved.message.runId, owned.message.runId);
        assert.strictEqual(saved.turnItem.text, "Verified managed result");
        assert.strictEqual(saved.turnItem.runId, owned.message.runId);
        const logged = yield* f.sink
          .stream({ threadId: f.threadId, afterSequence: sequence })
          .pipe(Stream.take(2), Stream.runCollect);
        assert.deepStrictEqual(
          logged.map(({ event }) => event.type),
          ["message.updated", "turn-item.updated"],
        );
        assert.strictEqual(yield* f.sink.latestSequence({ threadId: f.threadId }), sequence + 2);
      }),
    ),
  );

  it.effect(
    "allows a first observer answer to acquire managed ownership and preserves foreign IDs",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("promotion");
        const runless = f.pair("First observer answer", false);
        assert.lengthOf(yield* f.ingest(runless), 2);
        const owned = f.pair("Managed canonical answer", true);
        assert.lengthOf(yield* f.ingest(owned), 2);
        const foreign = f.pair("Native phone answer", false, "phone");
        assert.lengthOf(yield* f.ingest(foreign), 2);
        const saved = yield* f.saved(owned);
        assert.strictEqual(saved.message.text, "Managed canonical answer");
        assert.strictEqual(saved.message.runId, owned.message.runId);
        assert.strictEqual(saved.turnItem.runId, owned.message.runId);
        const phone = yield* f.saved(foreign);
        assert.strictEqual(phone.message.text, "Native phone answer");
        assert.strictEqual(phone.message.runId, null);
        assert.strictEqual(phone.turnItem.runId, null);
      }),
  );

  it.effect("rejects same-batch observer downgrade after managed events", () =>
    Effect.gen(function* () {
      const f = yield* fixture("same-batch");
      const owned = f.pair("Accepted managed answer", true);
      const stale = f.pair("Queued observer body", false);
      const committed = yield* f.sink.write({
        events: [...(yield* f.normalize(owned)), ...(yield* f.normalize(stale))],
      });
      assert.deepStrictEqual(
        committed.map(({ event }) => event.type),
        ["message.updated", "turn-item.updated"],
      );
      const saved = yield* f.saved(owned);
      assert.strictEqual(saved.message.text, "Accepted managed answer");
      assert.strictEqual(saved.message.runId, owned.message.runId);
      assert.strictEqual(saved.turnItem.text, "Accepted managed answer");
      assert.strictEqual(saved.turnItem.runId, owned.message.runId);
    }),
  );

  it.effect("retains existing Grok observer update behavior", () =>
    Effect.gen(function* () {
      const f = yield* fixture("grok-unchanged", "grok-bot");
      yield* f.ingest(f.pair("Initial managed Grok reply", true));
      const observed = f.pair("Updated native Grok reply", false);
      assert.lengthOf(yield* f.ingest(observed), 2);
      const saved = yield* f.saved(observed);
      assert.strictEqual(saved.message.text, "Updated native Grok reply");
      assert.strictEqual(saved.message.runId, null);
      assert.strictEqual(saved.turnItem.text, "Updated native Grok reply");
      assert.strictEqual(saved.turnItem.runId, null);
    }),
  );
});

it.effect("records accepted billed turn usage once without billing the context window", () => {
  const recorded: Array<Readonly<Record<string, unknown>>> = [];
  const layerAnalytics = Layer.succeed(ProviderEventIngestor.ProviderTurnAnalytics, {
    record: (properties: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => {
        recorded.push(properties);
      }),
  });
  return Effect.gen(function* () {
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadEvent = yield* threadCreatedEvent(now);
    yield* eventSink.write({ events: [threadEvent] });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId: threadEvent.threadId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "billing-thread",
    });
    const providerTurn = {
      id: idAllocator.derive.providerTurn({ driver: CODEX_DRIVER, nativeTurnId: "billing-turn" }),
      providerThreadId,
      nodeId: NodeId.make("node:billing-turn"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed" as const,
      startedAt: now,
      completedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 120),
      tokenUsage: {
        inputTokens: 4000,
        cachedInputTokens: 3000,
        outputTokens: 100,
        usedTokens: 4100,
        updatedAt: DateTime.formatIso(now),
      },
      turnTokenUsage: {
        usageStatus: "complete" as const,
        usageScope: "main_agent" as const,
        hasSubagents: false,
        inputTokens: 40,
        cachedInputTokens: 30,
        outputTokens: 10,
      },
    };
    const input = {
      providerSessionId,
      providerInstanceId: modelSelection.instanceId,
      threadId: threadEvent.threadId,
      analyticsContext: {
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      },
      event: { type: "provider_turn.updated" as const, driver: CODEX_DRIVER, providerTurn },
    };
    yield* ingestor.ingestNormalized(input);
    yield* ingestor.ingestNormalized(input);
    const ignored = yield* ingestor.ingestNormalized({
      ...input,
      event: {
        ...input.event,
        providerTurn: {
          ...providerTurn,
          id: idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: "stale-billing-turn",
          }),
        },
      },
      writeIfRunCurrent: {
        runId: RunId.make("missing-run"),
        activeAttemptId: RunAttemptId.make("stale-attempt"),
        expectedStatus: "running",
      },
    });
    assert.isEmpty(ignored);
    assert.lengthOf(recorded, 1);
    assert.deepEqual(recorded[0], {
      provider: CODEX_DRIVER,
      terminalStatus: "completed",
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 40,
      cachedInputTokens: 30,
      outputTokens: 10,
      model: modelSelection.model,
      mixedModels: false,
      runtimeMode: "full-access",
      interactionMode: "default",
      durationMs: 120,
    });
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(layerAnalytics))));
});

const nativeWidgetDriver = ProviderDriverKind.make("grok-bot");
const nativeWidgetInstance = ProviderInstanceId.make("grok-bot");

const nativeWidgetQuestion = {
  id: "native-widget-entry",
  header: "Question",
  question: "Which workspace?",
  options: [{ label: "Existing", description: "Existing" }],
  multiSelect: false,
  allowCustomAnswer: true,
};

// One native question card as a provider reports it: request, node, and turn item sharing a
// stable native id. Message capability without a session models legacy grok-bot observations.
const nativeWidgetCard = (input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly requestId: RuntimeRequestId;
  readonly nativeId: string;
  readonly capability: OrchestrationV2RuntimeRequest["responseCapability"];
  readonly state: "pending" | "resolved" | "cancelled";
  readonly now: DateTime.Utc;
}) => {
  const nodeId = NodeId.make(`${input.requestId}:node`);
  const nativeItemRef = {
    driver: input.driver,
    nativeId: input.nativeId,
    strength: "strong" as const,
  };
  const settled = input.state !== "pending";
  const answers = { [nativeWidgetQuestion.id]: "Use a new workspace" };
  const request: OrchestrationV2RuntimeRequest = {
    id: input.requestId,
    nodeId,
    providerTurnId: null,
    nativeRequestRef: nativeItemRef,
    kind: "user_input",
    status: input.state,
    responseCapability: input.capability,
    createdAt: input.now,
    resolvedAt: settled ? input.now : null,
    ...(input.state === "resolved" ? { answers } : {}),
  };
  const nodeStatus =
    input.state === "pending" ? "waiting" : input.state === "resolved" ? "completed" : "cancelled";
  const node: OrchestrationV2ExecutionNode = {
    id: nodeId,
    threadId: input.threadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: nodeId,
    kind: "user_input_request",
    status: nodeStatus,
    countsForRun: false,
    providerThreadId: input.providerThreadId,
    providerTurnId: null,
    nativeItemRef,
    runtimeRequestId: input.requestId,
    checkpointScopeId: null,
    startedAt: input.now,
    completedAt: settled ? input.now : null,
  };
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`${input.requestId}:item`),
    threadId: input.threadId,
    runId: null,
    nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: null,
    nativeItemRef,
    parentItemId: null,
    ordinal: 0,
    status: nodeStatus,
    title: null,
    startedAt: input.now,
    completedAt: settled ? input.now : null,
    updatedAt: input.now,
    type: "user_input_request",
    requestId: input.requestId,
    questions: [nativeWidgetQuestion],
  };
  return { request, node, item };
};
type NativeWidgetCard = ReturnType<typeof nativeWidgetCard>;

layer("ProviderEventIngestorV2", (it) => {
  it.effect("normalizes provider events through the real event log and projection store", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThread: OrchestrationV2ProviderThread = {
        id: idAllocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "native-thread",
        }),
        driver: CODEX_DRIVER,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId,
        appThreadId: threadEvent.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CODEX_DRIVER,
          nativeId: "native-thread",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* eventSink.write({ events: [threadEvent] });
      const storedEvents = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const storedDomainEvents = yield* eventStore.read({}).pipe(Stream.runCollect);
      const afterFirstEvent = yield* eventStore
        .read({ afterSequence: 1, threadId: threadEvent.threadId })
        .pipe(Stream.runCollect);
      const latestThreadSequence = yield* eventStore.latestSequence({
        threadId: threadEvent.threadId,
      });

      assert.equal(storedEvents.length, 1);
      assert.equal(storedEvents[0]?.event.type, "provider-thread.updated");
      assert.deepEqual(
        projection.providerThreads.map((thread) => thread.id),
        [providerThread.id],
      );
      assert.deepEqual(
        Array.from(storedDomainEvents).map((stored) => stored.event.type),
        ["thread.created", "provider-thread.updated"],
      );
      assert.deepEqual(
        Array.from(storedDomainEvents).map((stored) => stored.sequence),
        [1, 2],
      );
      assert.deepEqual(
        Array.from(afterFirstEvent).map((stored) => stored.event.type),
        ["provider-thread.updated"],
      );
      assert.equal(latestThreadSequence, 2);
    }),
  );

  it.effect("skips a node update only when it matches the stored node", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const threadId = threadEvent.threadId;
      yield* eventSink.write({ events: [threadEvent] });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const nodeId = NodeId.make(`${threadId}:approval`);
      const node: OrchestrationV2ExecutionNode = {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const ingestNode = (sent: OrchestrationV2ExecutionNode) =>
        ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId,
          event: { type: "node.updated", driver: CODEX_DRIVER, node: sent },
        });

      assert.lengthOf(yield* ingestNode(node), 1);
      assert.isEmpty(yield* ingestNode({ ...node }));
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "node.updated",
            threadId,
            occurredAt: now,
            payload: { ...node, status: "completed", completedAt: now },
          },
        ],
      });
      assert.lengthOf(yield* ingestNode(node), 1);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.nodes.find((entry) => entry.id === nodeId)?.status, "waiting");
    }),
  );

  it.effect("rolls back runs a provider rewound off its active branch", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const threadId = threadEvent.threadId;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const rewoundThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "rewound-thread",
      });
      const otherThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "other-thread",
      });
      const scopeId = CheckpointScopeId.make("checkpoint-scope:rewound");
      const seedRun = Effect.fnUntraced(function* (input: {
        readonly ordinal: number;
        readonly providerThreadId: ProviderThreadId;
        readonly status: "completed" | "interrupted" | "running";
        readonly nativeTurnId: string | null;
      }) {
        const runId = RunId.make(`run:rewound:${input.ordinal}`);
        const attemptId = RunAttemptId.make(`attempt:rewound:${input.ordinal}`);
        const nodeId = NodeId.make(`node:rewound:${input.ordinal}`);
        const providerTurnId = ProviderTurnId.make(`provider-turn:rewound:${input.ordinal}`);
        const completedAt = input.status === "running" ? null : now;
        const eventId = () => idAllocator.allocate.event({ threadId });
        const events: Array<OrchestrationV2DomainEvent> = [
          {
            id: yield* eventId(),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: input.ordinal,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: input.providerThreadId,
              userMessageId: MessageId.make(`message:rewound:${input.ordinal}`),
              rootNodeId: nodeId,
              activeAttemptId: attemptId,
              status: input.status,
              requestedAt: now,
              startedAt: now,
              completedAt,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: yield* eventId(),
            type: "run-attempt.created",
            threadId,
            occurredAt: now,
            payload: {
              id: attemptId,
              runId,
              attemptOrdinal: 1,
              rootNodeId: nodeId,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              reason: "initial",
              status: input.status,
              startedAt: now,
              completedAt,
            },
          },
          {
            id: yield* eventId(),
            type: "provider-turn.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerTurnId,
              providerThreadId: input.providerThreadId,
              nodeId,
              runAttemptId: attemptId,
              nativeTurnRef:
                input.nativeTurnId === null
                  ? {
                      driver: CODEX_DRIVER,
                      nativeId: `synthetic:${input.ordinal}`,
                      strength: "weak",
                    }
                  : { driver: CODEX_DRIVER, nativeId: input.nativeTurnId, strength: "strong" },
              ordinal: input.ordinal,
              status: input.status,
              startedAt: now,
              completedAt,
            },
          },
          {
            id: yield* eventId(),
            type: "node.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "root_turn",
              status: input.status,
              countsForRun: true,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: scopeId,
              startedAt: now,
              completedAt,
            },
          },
          ...(input.status === "completed"
            ? [
                {
                  id: yield* eventId(),
                  type: "checkpoint.captured" as const,
                  threadId,
                  occurredAt: now,
                  payload: {
                    id: CheckpointId.make(`checkpoint:rewound:${input.ordinal}`),
                    threadId,
                    scopeId,
                    runId,
                    nodeId,
                    parentCheckpointId: null,
                    ordinalWithinScope: input.ordinal,
                    appRunOrdinal: input.ordinal,
                    ref: CheckpointRef.make(`refs/t3/checkpoints/rewound/${input.ordinal}`),
                    status: "ready" as const,
                    files: [],
                    capturedAt: now,
                  },
                },
              ]
            : []),
        ];
        yield* eventSink.write({ events });
        return runId;
      });

      yield* eventSink.write({ events: [threadEvent] });
      const otherProviderRun = yield* seedRun({
        ordinal: 1,
        providerThreadId: otherThreadId,
        status: "completed",
        nativeTurnId: "other-turn",
      });
      const keptRun = yield* seedRun({
        ordinal: 2,
        providerThreadId: rewoundThreadId,
        status: "completed",
        nativeTurnId: "kept-turn",
      });
      const abandonedRun = yield* seedRun({
        ordinal: 3,
        providerThreadId: rewoundThreadId,
        status: "completed",
        nativeTurnId: "abandoned-turn",
      });
      const unlocatedRun = yield* seedRun({
        ordinal: 4,
        providerThreadId: rewoundThreadId,
        status: "interrupted",
        nativeTurnId: null,
      });
      const rewindingRun = yield* seedRun({
        ordinal: 5,
        providerThreadId: rewoundThreadId,
        status: "running",
        nativeTurnId: null,
      });

      yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId,
        runId: rewindingRun,
        event: {
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread: {
            id: rewoundThreadId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: CODEX_DRIVER,
              nativeId: "rewound-thread",
              strength: "strong",
            },
            nativeConversationHeadRef: {
              driver: CODEX_DRIVER,
              nativeId: "kept-turn-reply",
              strength: "strong",
            },
            status: "idle",
            firstRunOrdinal: 2,
            lastRunOrdinal: 5,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
          retainedNativeTurnIds: ["turn-started-outside-t3", "kept-turn"],
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const runIds = [otherProviderRun, keptRun, abandonedRun, unlocatedRun, rewindingRun];
      assert.deepEqual(
        runIds.map((runId) => projection.runs.find((run) => run.id === runId)?.status),
        ["completed", "completed", "rolled_back", "rolled_back", "running"],
      );
      assert.deepEqual(
        runIds.map((runId) => projection.nodes.find((node) => node.runId === runId)?.status),
        ["completed", "completed", "rolled_back", "rolled_back", "running"],
      );
      assert.deepEqual(
        [otherProviderRun, keptRun, abandonedRun].map(
          (runId) =>
            projection.checkpoints.find((checkpoint) => checkpoint.runId === runId)?.status,
        ),
        ["ready", "ready", "stale"],
      );
      assert.equal(
        projection.providerThreads.find((thread) => thread.id === rewoundThreadId)?.lastRunOrdinal,
        5,
      );
    }),
  );

  it.effect(
    "treats successful provider terminal markers as non-persisted orchestration control signals",
    () =>
      Effect.gen(function* () {
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-event-terminal",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-event-terminal",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const normalized = yield* ingestor.normalize({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId,
          event: {
            type: "turn.terminal",
            driver: CODEX_DRIVER,
            providerThreadId: idAllocator.derive.providerThread({
              driver: CODEX_DRIVER,
              nativeThreadId: "native-thread",
            }),
            providerTurnId: idAllocator.derive.providerTurn({
              driver: CODEX_DRIVER,
              nativeTurnId: "native-turn",
            }),
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          },
        });

        assert.deepEqual(normalized, []);
      }),
  );

  it.effect("persists an interrupted run's inherited terminal through the live run router", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const priorRunId = RunId.make("run:provider-event-inherited:prior");
      const currentRunId = RunId.make("run:provider-event-inherited:current");
      const itemId = TurnItemId.make("turn-item:provider-event-inherited");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-thread-inherited",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "native-turn-inherited",
      });
      const runningItem = {
        id: itemId,
        threadId: threadEvent.threadId,
        runId: priorRunId,
        nodeId: NodeId.make("node:provider-event-inherited"),
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 101,
        status: "running",
        title: "Inherited background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 60",
      } satisfies OrchestrationV2TurnItem;
      const terminalItem = {
        ...runningItem,
        status: "completed" as const,
        completedAt: now,
        updatedAt: now,
      };

      yield* eventSink.write({ events: [threadEvent] });
      yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        runId: priorRunId,
        event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem: runningItem },
      });

      const identity: ProviderEventRouteIdentity = {
        threadId: threadEvent.threadId,
        runId: currentRunId,
        attemptId: RunAttemptId.make("attempt:provider-event-inherited:current"),
        providerThreadId,
      };
      const inheritedBackgroundTurnItems = selectInheritedBackgroundTurnItems({
        threadId: threadEvent.threadId,
        currentProviderThreadId: providerThreadId,
        currentRunOrdinal: 2,
        runs: [
          {
            id: priorRunId,
            threadId: threadEvent.threadId,
            ordinal: 1,
            status: "interrupted",
          } as OrchestrationV2Run,
          {
            id: currentRunId,
            threadId: threadEvent.threadId,
            ordinal: 2,
            status: "running",
          } as OrchestrationV2Run,
        ],
        turnItems: [runningItem],
      });
      const routeState = makeProviderEventRoutingState({
        identity,
        inheritedBackgroundTurnItems,
        providerTurnId: null,
      });
      const terminalEvent = {
        type: "turn_item.updated",
        driver: CODEX_DRIVER,
        turnItem: terminalItem,
      } as const;
      const [accepted] = routeProviderEvent(terminalEvent, identity, routeState);
      assert.isTrue(accepted);

      const stored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        runId: currentRunId,
        event: terminalEvent,
      });
      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const persisted = projection.turnItems.find((item) => item.id === itemId);

      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.event.type, "turn-item.updated");
      assert.equal(persisted?.runId, priorRunId);
      assert.equal(persisted?.threadId, threadEvent.threadId);
      assert.equal(persisted?.status, "completed");
    }),
  );

  it.effect("persists a completed run's late background terminal exactly once", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const priorRunId = RunId.make("run:provider-event-completed:prior");
      const currentRunId = RunId.make("run:provider-event-completed:current");
      const itemId = TurnItemId.make("turn-item:provider-event-completed");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-thread-completed",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "native-turn-completed",
      });
      const runningItem = {
        id: itemId,
        threadId: threadEvent.threadId,
        runId: priorRunId,
        nodeId: NodeId.make("node:provider-event-completed"),
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 101,
        status: "running",
        title: "Completed run background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 60",
      } satisfies OrchestrationV2TurnItem;
      const terminalEvent = {
        type: "turn_item.updated",
        driver: CODEX_DRIVER,
        turnItem: {
          ...runningItem,
          status: "completed" as const,
          completedAt: now,
          updatedAt: now,
        },
      } as const;

      yield* eventSink.write({ events: [threadEvent] });
      yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        runId: priorRunId,
        event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem: runningItem },
      });

      const priorIdentity: ProviderEventRouteIdentity = {
        threadId: threadEvent.threadId,
        runId: priorRunId,
        attemptId: RunAttemptId.make("attempt:provider-event-completed:prior"),
        providerThreadId,
      };
      const currentIdentity: ProviderEventRouteIdentity = {
        threadId: threadEvent.threadId,
        runId: currentRunId,
        attemptId: RunAttemptId.make("attempt:provider-event-completed:current"),
        providerThreadId,
      };
      const inheritedBackgroundTurnItems = selectInheritedBackgroundTurnItems({
        threadId: threadEvent.threadId,
        currentProviderThreadId: providerThreadId,
        currentRunOrdinal: 2,
        runs: [
          {
            id: priorRunId,
            threadId: threadEvent.threadId,
            ordinal: 1,
            status: "completed",
          } as OrchestrationV2Run,
          {
            id: currentRunId,
            threadId: threadEvent.threadId,
            ordinal: 2,
            status: "running",
          } as OrchestrationV2Run,
        ],
        turnItems: [runningItem],
      });
      const routers = [
        {
          identity: priorIdentity,
          state: makeProviderEventRoutingState({
            identity: priorIdentity,
            providerTurnId: providerTurnId,
          }),
        },
        {
          identity: currentIdentity,
          state: makeProviderEventRoutingState({
            identity: currentIdentity,
            inheritedBackgroundTurnItems,
            providerTurnId: null,
          }),
        },
      ];
      const acceptedRouters = routers.filter(
        ({ identity, state }) => routeProviderEvent(terminalEvent, identity, state)[0],
      );

      yield* Effect.forEach(
        acceptedRouters,
        ({ identity }) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            threadId: threadEvent.threadId,
            runId: identity.runId,
            event: terminalEvent,
          }),
        { concurrency: 1 },
      );

      const storedEvents = yield* eventStore
        .read({ threadId: threadEvent.threadId })
        .pipe(Stream.runCollect);
      const storedTerminals = Array.from(storedEvents).filter(
        (stored) =>
          stored.event.type === "turn-item.updated" &&
          stored.event.payload.id === itemId &&
          stored.event.payload.status === "completed",
      );

      assert.equal(storedTerminals.length, 1);
      assert.equal(acceptedRouters.length, 1);
      assert.equal(acceptedRouters[0]?.identity.runId, priorRunId);
    }),
  );

  it.effect.each(["interrupted", "control"] as const)(
    "dismisses only native questions when a provider turn ends with %s",
    (terminal) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const eventStore = yield* EventStore.EventStoreV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadEvent = yield* threadCreatedEvent(now);
        const threadId = threadEvent.threadId;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThreadId = idAllocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: `${threadId}:questions`,
        });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: `${threadId}:questions`,
        });
        const otherTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: `${threadId}:other-turn`,
        });
        const specs = [
          { key: "native", responseCapability: { type: "live", providerSessionId } },
          {
            key: "unavailable",
            responseCapability: { type: "not_resumable", reason: "Turn ended" },
          },
          { key: "message", responseCapability: { type: "message" } },
          { key: "answered", responseCapability: { type: "live", providerSessionId } },
          { key: "other-turn", responseCapability: { type: "live", providerSessionId } },
          { key: "approval", responseCapability: { type: "live", providerSessionId } },
        ] as const;
        const fixtures = specs.map((spec, ordinal) => {
          const nodeId = NodeId.make(`${threadId}:${spec.key}`);
          const resolved = spec.key === "answered";
          const request: OrchestrationV2RuntimeRequest = {
            id: RuntimeRequestId.make(`${threadId}:${spec.key}`),
            nodeId,
            providerTurnId: spec.key === "other-turn" ? otherTurnId : providerTurnId,
            nativeRequestRef: null,
            kind: spec.key === "approval" ? "command" : "user_input",
            status: resolved ? "resolved" : "pending",
            responseCapability: spec.responseCapability,
            createdAt: now,
            resolvedAt: resolved ? now : null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: spec.key === "approval" ? "approval_request" : "user_input_request",
            status: resolved ? "completed" : "waiting",
            countsForRun: false,
            providerThreadId,
            providerTurnId: request.providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: request.id,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: resolved ? now : null,
          };
          const item: OrchestrationV2TurnItem = {
            id: TurnItemId.make(`${threadId}:${spec.key}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId,
            providerTurnId: request.providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: resolved ? "completed" : "waiting",
            title: "Which option?",
            startedAt: now,
            completedAt: resolved ? now : null,
            updatedAt: now,
            ...(spec.key === "approval"
              ? { type: "approval_request", requestId: request.id, requestKind: "command" }
              : {
                  type: "user_input_request",
                  requestId: request.id,
                  questions: [],
                  ...(spec.key === "message" ? { responseMode: "message" as const } : {}),
                }),
          };
          return { key: spec.key, request, node, item };
        });
        const seedEvents: Array<OrchestrationV2DomainEvent> = [threadEvent];
        for (const fixture of fixtures) {
          for (const payload of [
            { type: "runtime-request.updated" as const, payload: fixture.request },
            { type: "node.updated" as const, payload: fixture.node },
            { type: "turn-item.updated" as const, payload: fixture.item },
          ]) {
            seedEvents.push({
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              ...payload,
            });
          }
        }
        yield* eventSink.write({ events: seedEvents });
        const input = {
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId,
          event:
            terminal === "control"
              ? {
                  type: "turn.terminal" as const,
                  driver: CODEX_DRIVER,
                  providerThreadId,
                  providerTurnId,
                  runOrdinal: 1,
                  status: "completed" as const,
                  failure: null,
                  threadDisposition: "reusable" as const,
                }
              : {
                  type: "provider_turn.updated" as const,
                  driver: CODEX_DRIVER,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId,
                    nodeId: NodeId.make(`${threadId}:root`),
                    runAttemptId: null,
                    nativeTurnRef: null,
                    ordinal: 1,
                    status: terminal,
                    startedAt: now,
                    completedAt: now,
                  },
                },
        };
        const stored = yield* ingestor.ingestNormalized(input);
        const projection = yield* projectionStore.getThreadProjection(threadId);
        for (const fixture of fixtures) {
          const closed = fixture.key === "native" || fixture.key === "unavailable";
          const request = projection.runtimeRequests.find(
            (item) => item.id === fixture.request.id,
          )!;
          const node = projection.nodes.find((item) => item.id === fixture.node.id)!;
          const item = projection.turnItems.find((item) => item.id === fixture.item.id)!;
          if (closed) {
            assert.equal(request.status, "cancelled");
            assert.isNotNull(request.resolvedAt);
            assert.equal(node.status, "cancelled");
            assert.isNotNull(node.completedAt);
            assert.equal(item.status, "cancelled");
            assert.isNotNull(item.completedAt);
          } else {
            assert.equal(request.status, fixture.request.status);
            assert.equal(node.status, fixture.node.status);
            assert.equal(item.status, fixture.item.status);
          }
        }
        assert.equal(
          stored.filter((entry) => entry.event.type === "runtime-request.updated").length,
          2,
        );
        assert.isEmpty(
          (yield* projectionStore.getPendingNativeUserInputs(threadId, providerTurnId))
            .runtimeRequests,
        );
        const replayed = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
        assert.equal(
          replayed.filter(
            (entry) =>
              entry.event.type === "runtime-request.updated" &&
              entry.event.payload.status === "cancelled",
          ).length,
          2,
        );
        const repeated = yield* ingestor.ingestNormalized(input);
        assert.isFalse(repeated.some((entry) => entry.event.type === "runtime-request.updated"));
      }),
  );

  it.effect(
    "preserves an answer committed after terminal normalization reads a pending question",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const eventStore = yield* EventStore.EventStoreV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const now = yield* DateTime.now;
          const threadEvent = yield* threadCreatedEvent(now);
          const threadId = threadEvent.threadId;
          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          const providerThreadId = idAllocator.derive.providerThread({
            driver: CODEX_DRIVER,
            nativeThreadId: `${threadId}:race`,
          });
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: `${threadId}:race`,
          });
          const nodeId = NodeId.make(`${threadId}:question`);
          const request: OrchestrationV2RuntimeRequest = {
            id: RuntimeRequestId.make(`${threadId}:question`),
            nodeId,
            providerTurnId,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "live", providerSessionId },
            createdAt: now,
            resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: request.id,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          };
          const item: OrchestrationV2TurnItem = {
            id: TurnItemId.make(`${threadId}:question`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: "Which option?",
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId: request.id,
            questions: [],
          };
          const seedEvents: Array<OrchestrationV2DomainEvent> = [threadEvent];
          for (const payload of [
            { type: "runtime-request.updated" as const, payload: request },
            { type: "node.updated" as const, payload: node },
            { type: "turn-item.updated" as const, payload: item },
          ])
            seedEvents.push({
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              ...payload,
            });
          yield* eventSink.write({ events: seedEvents });
          const normalized = yield* Deferred.make<void>();
          const releaseTerminalWrite = yield* Deferred.make<void>();
          const gatedSink = EventSink.EventSinkV2.of({
            ...eventSink,
            write: (input) =>
              Deferred.succeed(normalized, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTerminalWrite)),
                Effect.andThen(eventSink.write(input)),
              ),
          });
          const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
            Effect.provide(Layer.fresh(ProviderEventIngestor.layer)),
            Effect.provideService(EventSink.EventSinkV2, gatedSink),
          );
          const terminal = yield* ingestor
            .ingestNormalized({
              providerSessionId,
              providerInstanceId: modelSelection.instanceId,
              threadId,
              event: {
                type: "provider_turn.updated",
                driver: CODEX_DRIVER,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId,
                  nodeId,
                  runAttemptId: null,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                },
              },
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(normalized);
          const answers = { decision: "Use the existing workspace" };
          const responseEvents: Array<OrchestrationV2DomainEvent> = [];
          for (const payload of [
            {
              type: "runtime-request.updated" as const,
              payload: { ...request, status: "resolved" as const, answers, resolvedAt: now },
            },
            {
              type: "node.updated" as const,
              payload: { ...node, status: "completed" as const, completedAt: now },
            },
            {
              type: "turn-item.updated" as const,
              payload: { ...item, status: "completed" as const, completedAt: now },
            },
          ])
            responseEvents.push({
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              ...payload,
            });
          yield* eventSink.write({ events: responseEvents });
          yield* Deferred.succeed(releaseTerminalWrite, undefined);
          const committedTerminal = yield* Fiber.join(terminal);
          assert.deepEqual(
            committedTerminal.map((stored) => stored.event.type),
            ["provider-turn.updated"],
          );
          const projection = yield* projections.getThreadProjection(threadId);
          const answered = projection.runtimeRequests.find((entry) => entry.id === request.id)!;
          assert.equal(answered.status, "resolved");
          assert.deepEqual(answered.answers, answers);
          assert.equal(projection.nodes.find((entry) => entry.id === nodeId)!.status, "completed");
          assert.equal(
            projection.turnItems.find((entry) => entry.id === item.id)!.status,
            "completed",
          );
          const history = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
          assert.isFalse(
            history.some(
              (stored) =>
                stored.event.type === "runtime-request.updated" &&
                stored.event.payload.status === "cancelled",
            ),
          );
        }),
      ),
  );

  it.effect(
    "keeps a chat-recorded native question answer against cancelled artifacts ingested before cleanup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const eventStore = yield* EventStore.EventStoreV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
          const now = yield* DateTime.now;
          const threadEvent = yield* threadCreatedEvent(now);
          const threadId = threadEvent.threadId;
          const driver = ProviderDriverKind.make("grok-bot");
          const providerInstanceId = ProviderInstanceId.make("grok-bot");
          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId,
            threadId,
          });
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            nativeThreadId: `${threadId}:native-question`,
          });
          const nodeId = NodeId.make(`${threadId}:native-question`);
          const requestId = RuntimeRequestId.make(`${threadId}:native-question`);
          const question = {
            id: "native-question-entry",
            header: "Question",
            question: "Which workspace?",
            options: [{ label: "Existing", description: "Existing" }],
            multiSelect: false,
            allowCustomAnswer: true,
          };
          const native = {
            driver,
            threadId,
            nativeItemRef: {
              driver,
              nativeId: "widget/native-question-entry",
              strength: "strong" as const,
            },
          };
          const request: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: native.nativeItemRef,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message", providerSessionId },
            createdAt: now,
            resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: native.nativeItemRef,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          };
          const item: OrchestrationV2TurnItem = {
            id: TurnItemId.make(`${threadId}:native-question-item`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: native.nativeItemRef,
            parentItemId: null,
            ordinal: 0,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [question],
          };
          const seedEvents: Array<OrchestrationV2DomainEvent> = [threadEvent];
          for (const payload of [
            { type: "runtime-request.updated" as const, payload: request },
            { type: "node.updated" as const, payload: node },
            { type: "turn-item.updated" as const, payload: item },
          ])
            seedEvents.push({
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              ...payload,
            });
          yield* eventSink.write({ events: seedEvents });

          // The orchestrator commits a chat answer locally before the native card is cleaned up.
          const answers = { [question.id]: "Use a new workspace" };
          const recordedEvents: Array<OrchestrationV2DomainEvent> = [];
          for (const payload of [
            {
              type: "runtime-request.updated" as const,
              payload: { ...request, status: "resolved" as const, answers, resolvedAt: now },
            },
            {
              type: "node.updated" as const,
              payload: { ...node, status: "completed" as const, completedAt: now },
            },
            {
              type: "turn-item.updated" as const,
              payload: {
                ...item,
                status: "completed" as const,
                completedAt: now,
                updatedAt: now,
                questionAnswer: {
                  requestId,
                  answers,
                  attachmentsByQuestionId: {},
                  questionTextById: { [question.id]: question.question },
                },
              },
            },
          ])
            recordedEvents.push({
              id: yield* idAllocator.allocate.event({ threadId }),
              threadId,
              occurredAt: now,
              ...payload,
            });
          yield* eventSink.write({ events: recordedEvents });

          // Native then reports the same card as cancelled, as a supersede or delete would.
          const nativeCancelled = [
            {
              type: "runtime_request.updated" as const,
              driver,
              threadId,
              runtimeRequest: { ...request, status: "cancelled" as const, resolvedAt: now },
            },
            {
              type: "node.updated" as const,
              driver,
              node: { ...node, status: "cancelled" as const, completedAt: now },
            },
            {
              type: "turn_item.updated" as const,
              driver,
              turnItem: { ...item, status: "cancelled" as const, completedAt: now, updatedAt: now },
            },
          ];
          for (const event of nativeCancelled) {
            yield* ingestor.ingestNormalized({
              providerSessionId,
              providerInstanceId,
              threadId,
              event,
            });
          }

          const projection = yield* projections.getThreadProjection(threadId);
          const answered = projection.runtimeRequests.find((entry) => entry.id === requestId)!;
          assert.equal(answered.status, "resolved");
          assert.deepEqual(answered.answers, answers);
          assert.equal(projection.nodes.find((entry) => entry.id === nodeId)!.status, "completed");
          const recorded = projection.turnItems.find((entry) => entry.id === item.id)!;
          assert.equal(recorded.status, "completed");
          assert.equal(
            recorded.type === "user_input_request" ? recorded.questionAnswer?.requestId : undefined,
            requestId,
          );
          assert.deepEqual(
            recorded.type === "user_input_request" ? recorded.questionAnswer?.answers : undefined,
            answers,
          );
          const history = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
          assert.isFalse(
            history.some(
              (stored) =>
                (stored.event.type === "runtime-request.updated" &&
                  stored.event.payload.status === "cancelled") ||
                (stored.event.type === "turn-item.updated" &&
                  stored.event.payload.status === "cancelled"),
            ),
          );
        }),
      ),
  );

  const writeNativeWidgetCards = (threadId: ThreadId, cards: ReadonlyArray<NativeWidgetCard>) =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const events: Array<OrchestrationV2DomainEvent> = [];
      for (const card of cards)
        for (const payload of [
          { type: "runtime-request.updated" as const, payload: card.request },
          { type: "node.updated" as const, payload: card.node },
          { type: "turn-item.updated" as const, payload: card.item },
        ])
          events.push({
            id: yield* idAllocator.allocate.event({ threadId }),
            threadId,
            occurredAt: card.request.createdAt,
            ...payload,
          });
      yield* eventSink.write({ events });
    });

  // Replays one native card the way a provider reports it: request, then node, then turn item.
  const ingestNativeWidgetCard = (input: {
    readonly driver: ProviderDriverKind;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
    readonly card: NativeWidgetCard;
  }) =>
    Effect.gen(function* () {
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const { driver, providerInstanceId, providerSessionId, threadId, card } = input;
      const base = { providerSessionId, providerInstanceId, threadId };
      yield* ingestor.ingestNormalized({
        ...base,
        event: {
          type: "runtime_request.updated",
          driver,
          threadId,
          runtimeRequest: card.request,
        },
      });
      yield* ingestor.ingestNormalized({
        ...base,
        event: { type: "node.updated", driver, node: card.node },
      });
      yield* ingestor.ingestNormalized({
        ...base,
        event: { type: "turn_item.updated", driver, turnItem: card.item },
      });
    });

  const nativeWidgetThread = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadEvent = yield* threadCreatedEvent(now);
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({ events: [threadEvent] });
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: nativeWidgetInstance,
      threadId: threadEvent.threadId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: nativeWidgetDriver,
      nativeThreadId: `${threadEvent.threadId}:native-widget`,
    });
    return { now, threadId: threadEvent.threadId, providerSessionId, providerThreadId };
  });

  it.effect(
    "cancels legacy duplicate native widget questions when the latest stable widget is observed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const { now, threadId, providerSessionId, providerThreadId } = yield* nativeWidgetThread;
          const card = (
            requestId: string,
            capability: NativeWidgetCard["request"]["responseCapability"],
            state: "pending" | "resolved" | "cancelled",
          ) =>
            nativeWidgetCard({
              driver: nativeWidgetDriver,
              threadId,
              providerThreadId,
              requestId: RuntimeRequestId.make(`${threadId}:${requestId}`),
              nativeId: "widget/entry-1",
              capability,
              state,
              now,
            });
          const legacyA = card("legacy-a", { type: "message" }, "pending");
          const legacyB = card("legacy-b", { type: "message" }, "pending");
          const answered = card("answered", { type: "message" }, "resolved");
          yield* writeNativeWidgetCards(threadId, [legacyA, legacyB, answered]);

          const latest = card("latest", { type: "message", providerSessionId }, "pending");
          yield* ingestNativeWidgetCard({
            driver: nativeWidgetDriver,
            providerInstanceId: nativeWidgetInstance,
            providerSessionId,
            threadId,
            card: latest,
          });

          const projection = yield* projections.getThreadProjection(threadId);
          const request = (card: NativeWidgetCard) =>
            projection.runtimeRequests.find((entry) => entry.id === card.request.id)!;
          const node = (card: NativeWidgetCard) =>
            projection.nodes.find((entry) => entry.id === card.node.id)!;
          const item = (card: NativeWidgetCard) =>
            projection.turnItems.find((entry) => entry.id === card.item.id)!;
          for (const legacy of [legacyA, legacyB]) {
            assert.equal(request(legacy).status, "cancelled");
            assert.equal(node(legacy).status, "cancelled");
            assert.equal(item(legacy).status, "cancelled");
          }
          assert.equal(request(latest).status, "pending");
          assert.equal(request(answered).status, "resolved");
          assert.deepEqual(request(answered).answers, answered.request.answers);
          assert.equal(node(answered).status, "completed");
        }),
      ),
  );

  it.effect("keeps closed native widget cards closed when a stale pending replay arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const { now, threadId, providerSessionId, providerThreadId } = yield* nativeWidgetThread;
        const card = (
          requestId: string,
          capability: NativeWidgetCard["request"]["responseCapability"],
          state: "pending" | "resolved" | "cancelled",
        ) =>
          nativeWidgetCard({
            driver: nativeWidgetDriver,
            threadId,
            providerThreadId,
            requestId: RuntimeRequestId.make(`${threadId}:${requestId}`),
            nativeId: "widget/entry-1",
            capability,
            state,
            now,
          });
        const legacy = card("legacy", { type: "message" }, "pending");
        const answered = card("answered", { type: "message" }, "resolved");
        yield* writeNativeWidgetCards(threadId, [legacy, answered]);
        const latest = card("latest", { type: "message", providerSessionId }, "pending");
        const ingest = (target: NativeWidgetCard) =>
          ingestNativeWidgetCard({
            driver: nativeWidgetDriver,
            providerInstanceId: nativeWidgetInstance,
            providerSessionId,
            threadId,
            card: target,
          });
        yield* ingest(latest);

        // Native replays the superseded cards as still pending after the latest one is current.
        yield* ingest(card("legacy", { type: "message" }, "pending"));
        yield* ingest(card("answered", { type: "message" }, "pending"));

        const projection = yield* projections.getThreadProjection(threadId);
        const request = (target: NativeWidgetCard) =>
          projection.runtimeRequests.find((entry) => entry.id === target.request.id)!;
        const node = (target: NativeWidgetCard) =>
          projection.nodes.find((entry) => entry.id === target.node.id)!;
        assert.equal(request(legacy).status, "cancelled");
        assert.equal(node(legacy).status, "cancelled");
        assert.equal(request(answered).status, "resolved");
        assert.deepEqual(request(answered).answers, answered.request.answers);
        assert.equal(node(answered).status, "completed");
        assert.equal(request(latest).status, "pending");
      }),
    ),
  );

  it.effect(
    "retires every pending native widget duplicate when the latest stable widget is already settled",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          for (const state of ["resolved", "cancelled"] as const) {
            const { now, threadId, providerSessionId, providerThreadId } =
              yield* nativeWidgetThread;
            const card = (
              requestId: string,
              capability: NativeWidgetCard["request"]["responseCapability"],
              cardState: "pending" | "resolved" | "cancelled",
            ) =>
              nativeWidgetCard({
                driver: nativeWidgetDriver,
                threadId,
                providerThreadId,
                requestId: RuntimeRequestId.make(`${threadId}:${requestId}`),
                nativeId: "widget/entry-1",
                capability,
                state: cardState,
                now,
              });
            const legacyA = card("legacy-a", { type: "message" }, "pending");
            const legacyB = card("legacy-b", { type: "message" }, "pending");
            const answered = card("answered", { type: "message" }, "resolved");
            yield* writeNativeWidgetCards(threadId, [legacyA, legacyB, answered]);

            const latest = card("latest", { type: "message", providerSessionId }, state);
            yield* ingestNativeWidgetCard({
              driver: nativeWidgetDriver,
              providerInstanceId: nativeWidgetInstance,
              providerSessionId,
              threadId,
              card: latest,
            });
            // Native replays the chat-answered card as pending after the latest one settled.
            yield* ingestNativeWidgetCard({
              driver: nativeWidgetDriver,
              providerInstanceId: nativeWidgetInstance,
              providerSessionId,
              threadId,
              card: card("answered", { type: "message" }, "pending"),
            });

            const projection = yield* projections.getThreadProjection(threadId);
            const request = (target: NativeWidgetCard) =>
              projection.runtimeRequests.find((entry) => entry.id === target.request.id)!;
            assert.equal(request(legacyA).status, "cancelled");
            assert.equal(request(legacyB).status, "cancelled");
            // A cancelled card the projection has never seen has nothing to close, so no request is recorded.
            assert.equal(
              projection.runtimeRequests.find((entry) => entry.id === latest.request.id)?.status,
              state === "resolved" ? "resolved" : undefined,
            );
            assert.equal(request(answered).status, "resolved");
            assert.deepEqual(request(answered).answers, answered.request.answers);
            assert.deepEqual(
              projection.runtimeRequests.filter((entry) => entry.status === "pending"),
              [],
            );
          }
        }),
      ),
  );

  const activeNativeWidget = Effect.gen(function* () {
    const fixture = yield* nativeWidgetThread;
    const { now, threadId, providerThreadId, providerSessionId } = fixture;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const sink = yield* EventSink.EventSinkV2;
    const runId = RunId.make(threadId + ":active-run");
    const attemptId = RunAttemptId.make(threadId + ":active-attempt");
    const rootNodeId = NodeId.make(threadId + ":active-root");
    const providerTurnId = ProviderTurnId.make(threadId + ":active-turn");
    yield* sink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: nativeWidgetInstance,
            modelSelection: { instanceId: nativeWidgetInstance, model: "bot" },
            providerThreadId,
            userMessageId: MessageId.make(threadId + ":user"),
            rootNodeId,
            activeAttemptId: attemptId,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: providerTurnId,
            providerThreadId,
            nodeId: rootNodeId,
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
      ],
    });
    const base = nativeWidgetCard({
      driver: nativeWidgetDriver,
      threadId,
      providerThreadId,
      requestId: RuntimeRequestId.make(threadId + ":owned"),
      nativeId: "widget/latest",
      capability: { type: "message", providerSessionId },
      state: "pending",
      now,
    });
    const owned = {
      request: { ...base.request, providerTurnId },
      node: {
        ...base.node,
        runId,
        providerTurnId,
        parentNodeId: rootNodeId,
        rootNodeId,
        countsForRun: true,
      },
      item: { ...base.item, runId, providerTurnId },
    };
    return { ...fixture, owned };
  });

  it.effect("does not let an older runless replay retire a current managed widget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { threadId, now, providerThreadId, providerSessionId, owned } =
          yield* activeNativeWidget;
        yield* writeNativeWidgetCards(threadId, [owned]);
        const older = nativeWidgetCard({
          driver: nativeWidgetDriver,
          threadId,
          providerThreadId,
          requestId: RuntimeRequestId.make(threadId + ":old-replay"),
          nativeId: "widget/older",
          capability: { type: "message", providerSessionId },
          state: "pending",
          now,
        });
        yield* ingestNativeWidgetCard({
          driver: nativeWidgetDriver,
          providerInstanceId: nativeWidgetInstance,
          providerSessionId,
          threadId,
          card: older,
        });
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          threadId,
        );
        assert.equal(
          projection.runtimeRequests.find((r) => r.id === owned.request.id)?.status,
          "pending",
        );
        assert.equal(projection.turnItems.find((r) => r.id === owned.item.id)?.status, "waiting");
      }),
    ),
  );

  it.effect(
    "recovers an exact active widget after local cancellation but preserves recorded answers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { threadId, now, providerSessionId, owned } = yield* activeNativeWidget;
          const cancelled = {
            request: {
              ...owned.request,
              providerTurnId: null,
              status: "cancelled" as const,
              resolvedAt: now,
            },
            node: { ...owned.node, status: "cancelled" as const, completedAt: now },
            item: { ...owned.item, status: "cancelled" as const, completedAt: now },
          };
          yield* writeNativeWidgetCards(threadId, [cancelled]);
          const ingest = (card: NativeWidgetCard) =>
            ingestNativeWidgetCard({
              driver: nativeWidgetDriver,
              providerInstanceId: nativeWidgetInstance,
              providerSessionId,
              threadId,
              card,
            });
          const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
          yield* ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId: nativeWidgetInstance,
            threadId,
            event: { type: "node.updated", driver: nativeWidgetDriver, node: owned.node },
          });
          yield* ingest(owned);
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          let projection = yield* projections.getThreadProjection(threadId);
          assert.equal(
            projection.runtimeRequests.find((r) => r.id === owned.request.id)?.status,
            "pending",
          );
          assert.equal(projection.turnItems.find((r) => r.id === owned.item.id)?.status, "waiting");
          assert.equal(projection.nodes.find((r) => r.id === owned.node.id)?.status, "waiting");
          yield* writeNativeWidgetCards(threadId, [
            {
              ...owned,
              request: {
                ...owned.request,
                status: "resolved",
                resolvedAt: now,
                answers: { answer: "saved" },
              },
              node: { ...owned.node, status: "completed", completedAt: now },
              item: { ...owned.item, status: "completed", completedAt: now },
            },
          ]);
          yield* ingest(owned);
          projection = yield* projections.getThreadProjection(threadId);
          assert.equal(
            projection.runtimeRequests.find((r) => r.id === owned.request.id)?.status,
            "resolved",
          );
          assert.deepEqual(
            projection.runtimeRequests.find((r) => r.id === owned.request.id)?.answers,
            { answer: "saved" },
          );
        }),
      ),
  );

  it.effect("moves a pending native widget question to its newest provider session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const { now, threadId, providerSessionId, providerThreadId } = yield* nativeWidgetThread;
        const newerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: nativeWidgetInstance,
          threadId,
        });
        const latest = (sessionId: typeof providerSessionId) =>
          nativeWidgetCard({
            driver: nativeWidgetDriver,
            threadId,
            providerThreadId,
            requestId: RuntimeRequestId.make(`${threadId}:latest`),
            nativeId: "widget/entry-1",
            capability: { type: "message", providerSessionId: sessionId },
            state: "pending",
            now,
          });
        for (const sessionId of [providerSessionId, newerSessionId]) {
          yield* ingestNativeWidgetCard({
            driver: nativeWidgetDriver,
            providerInstanceId: nativeWidgetInstance,
            providerSessionId: sessionId,
            threadId,
            card: latest(sessionId),
          });
        }

        const projection = yield* projections.getThreadProjection(threadId);
        const request = projection.runtimeRequests.find(
          (entry) => entry.id === RuntimeRequestId.make(`${threadId}:latest`),
        )!;
        assert.equal(request.status, "pending");
        assert.deepEqual(request.responseCapability, {
          type: "message",
          providerSessionId: newerSessionId,
        });
      }),
    ),
  );

  it.effect("keeps ordinary unbound message questions pending against native cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const { now, threadId, providerSessionId, providerThreadId } = yield* nativeWidgetThread;
        const codexDriver = ProviderDriverKind.make("codex");
        const codexInstance = ProviderInstanceId.make("codex");
        const plain = nativeWidgetCard({
          driver: nativeWidgetDriver,
          threadId,
          providerThreadId,
          requestId: RuntimeRequestId.make(`${threadId}:plain`),
          nativeId: "question/plain",
          capability: { type: "message" },
          state: "pending",
          now,
        });
        const otherProvider = nativeWidgetCard({
          driver: codexDriver,
          threadId,
          providerThreadId,
          requestId: RuntimeRequestId.make(`${threadId}:other-provider`),
          nativeId: "widget/entry-2",
          capability: { type: "message" },
          state: "pending",
          now,
        });
        yield* writeNativeWidgetCards(threadId, [plain, otherProvider]);

        for (const [driver, providerInstanceId, target] of [
          [nativeWidgetDriver, nativeWidgetInstance, plain],
          [codexDriver, codexInstance, otherProvider],
        ] as const)
          yield* ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId,
            threadId,
            event: {
              type: "runtime_request.updated",
              driver,
              threadId,
              runtimeRequest: { ...target.request, status: "cancelled", resolvedAt: now },
            },
          });

        const projection = yield* projections.getThreadProjection(threadId);
        for (const target of [plain, otherProvider])
          assert.equal(
            projection.runtimeRequests.find((entry) => entry.id === target.request.id)!.status,
            "pending",
          );
      }),
    ),
  );

  it.effect("persists a failed provider terminal as one expected error item", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const retryStartedAt = DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 5_000);
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-thread-failed",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "native-turn-failed",
      });

      yield* eventSink.write({ events: [threadEvent] });
      const stored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId,
          providerTurnId,
          runOrdinal: 1,
          failureItemOrdinal: 102,
          status: "failed",
          failure: makeProviderFailure({
            message: "Invalid reasoning effort.",
            code: "invalid_request",
            class: "validation_error",
          }),
          retry: {
            attempt: 3,
            maxAttempts: 3,
            retryDelayMs: 2_000,
          },
          retryStartedAt,
          threadDisposition: "reusable",
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const errorItems = projection.visibleTurnItems.filter(
        (candidate) => candidate.item.type === "error",
      );

      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.event.type, "turn-item.updated");
      assert.equal(errorItems.length, 1);
      const errorItem = errorItems[0]?.item;
      assert.equal(errorItem?.type, "error");
      if (errorItem?.type !== "error") return;
      assert.equal(errorItem.failure.message, "Invalid reasoning effort.");
      assert.equal(errorItem.failure.code, "invalid_request");
      assert.deepEqual(errorItem.retry, {
        attempt: 3,
        maxAttempts: 3,
        retryDelayMs: 2_000,
      });
      const errorStartedAt = errorItem.startedAt;
      assert.ok(errorStartedAt);
      assert.equal(DateTime.toEpochMillis(errorStartedAt), DateTime.toEpochMillis(retryStartedAt));
      assert.equal(errorItem.providerThreadId, providerThreadId);
      assert.equal(errorItem.providerTurnId, providerTurnId);
    }),
  );

  it.effect("stores tool image bytes only where a tool-output-image asset serves them", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const readBase64 = Buffer.alloc(30_000, 7).toString("base64");
      const screenshotBase64 = Buffer.alloc(20_000, 9).toString("base64");
      const toolItem = (
        id: string,
        ordinal: number,
        toolName: string,
        output: unknown,
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: threadEvent.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: toolName,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool",
        toolName,
        input: {},
        output,
      });
      const read = toolItem("turn-item:read-image", 1, "Read", {
        type: "image",
        file: { base64: readBase64, type: "image/png", originalSize: 30_000 },
      });
      const screenshot = toolItem("turn-item:screenshot", 2, "mcp__t3-code__device_screenshot", {
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: screenshotBase64 },
          },
        ],
      });

      yield* eventSink.write({ events: [threadEvent] });
      for (const turnItem of [read, screenshot]) {
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
          event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem },
        });
      }

      const storedEvents = yield* eventStore
        .read({ threadId: threadEvent.threadId, eventType: "turn-item.updated" })
        .pipe(Stream.runCollect);
      const storedJson = JSON.stringify(Array.from(storedEvents, (stored) => stored.event));
      const projectedRead = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: read.id,
      });
      const projectedScreenshot = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: screenshot.id,
      });

      assert.equal(storedJson.includes(readBase64), false);
      assert.equal(storedJson.includes(screenshotBase64), true);
      assert.deepEqual(projectedRead?.type === "dynamic_tool" ? projectedRead.output : null, {
        type: "image",
        file: { type: "image/png", originalSize: 30_000, sizeBytes: 30_000 },
      });
      assert.deepEqual(
        toolOutputImages(
          projectedScreenshot?.type === "dynamic_tool" ? projectedScreenshot.output : null,
        ),
        [{ mimeType: "image/png", data: screenshotBase64 }],
      );
    }),
  );

  it.effect("stores a bounded copy of a large file-change diff in both SQLite tables", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const largeDiff = `@@ -0,0 +1 @@\n${"+generated line\n".repeat(150_000)}`;
      const fileChange = (
        id: string,
        ordinal: number,
        diffStr: string,
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: threadEvent.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "file_change",
        fileName: "src/generated.ts",
        diffStr,
      });
      const large = fileChange("turn-item:large-diff", 1, largeDiff);
      const small = fileChange("turn-item:small-diff", 2, "@@ -1 +1 @@\n-old\n+new\n");

      yield* eventSink.write({ events: [threadEvent] });
      for (const turnItem of [large, small]) {
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
          event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem },
        });
      }

      const sql = yield* SqlClient.SqlClient;
      const storedBytes = yield* sql<{ readonly events: number; readonly projection: number }>`
        SELECT
          (SELECT SUM(LENGTH(payload_json)) FROM orchestration_events
            WHERE stream_id = ${threadEvent.threadId} AND event_type = 'turn-item.updated') AS events,
          (SELECT SUM(LENGTH(payload_json)) FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadEvent.threadId}) AS projection
      `;
      const projectedLarge = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: large.id,
      });
      const projectedSmall = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: small.id,
      });

      assert.isAbove(largeDiff.length, 2_000_000);
      assert.isBelow(storedBytes[0]!.events, 100_000);
      assert.isBelow(storedBytes[0]!.projection, 100_000);
      assert.isTrue(projectedLarge?.type === "file_change");
      if (projectedLarge?.type !== "file_change") return;
      assert.equal(projectedLarge.fileName, "src/generated.ts");
      assert.isBelow(projectedLarge.diffStr?.length ?? 0, 40_000);
      assert.isTrue(largeDiff.startsWith(projectedLarge.diffStr?.split("\n…")[0] ?? "-"));
      assert.deepEqual(projectedSmall, small);
    }),
  );

  it.effect("routes provider-owned child artifacts to their child app thread", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") {
        throw new Error("Expected a thread.created fixture event");
      }
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-subagent-thread",
      });
      const childRootNodeId = NodeId.make("node:subagent-root");
      const childThread: OrchestrationV2AppThread = {
        ...rootEvent.payload,
        id: childThreadId,
        title: "inspect package",
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: rootEvent.threadId,
          relationshipToParent: "subagent",
          rootThreadId: rootEvent.threadId,
        },
        forkedFrom: {
          type: "node",
          nodeId: NodeId.make("node:parent-subagent"),
        },
      };
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });

      const threadEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "app_thread.created",
          driver: CODEX_DRIVER,
          appThread: childThread,
        },
      });
      const messageEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "message.updated",
          driver: CODEX_DRIVER,
          message: {
            createdBy: "agent",
            creationSource: "provider",
            id: MessageId.make("message:subagent-response"),
            threadId: childThreadId,
            runId: null,
            nodeId: childRootNodeId,
            role: "assistant",
            text: "Subagent result",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      assert.equal(threadEvents[0]?.type, "thread.created");
      assert.equal(threadEvents[0]?.threadId, childThreadId);
      assert.equal(messageEvents[0]?.type, "message.updated");
      assert.equal(messageEvents[0]?.threadId, childThreadId);
    }),
  );

  it.effect.each([
    { parentMoved: false, failure: null },
    { parentMoved: true, failure: null },
    { parentMoved: false, failure: "write" },
    { parentMoved: false, failure: "git" },
  ])(
    "rechecks a pending native child's branch after the rename scan: %j",
    ({ parentMoved, failure }) =>
      Effect.gen(function* () {
        const { worktreePath, command } = yield* makeSharedWorktree;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const rootEvent = yield* threadCreatedEvent(now);
        if (rootEvent.type !== "thread.created") throw new Error("Expected thread fixture");
        const parent = {
          ...rootEvent.payload,
          branch: "t3/abcd1234",
          worktreePath,
        };
        yield* eventSink.write({ events: [{ ...rootEvent, payload: parent }] });
        const childId = ids.derive.threadFromProviderThread({
          driver: CODEX_DRIVER,
          nativeThreadId: `child-created-during-rename:${parentMoved}:${failure}`,
        });
        const beforeCommit = yield* Deferred.make<
          void,
          ProviderEventIngestor.ProviderEventIngestorV2Error
        >();
        const allowCommit = yield* Deferred.make<void>();
        let correctionWrites = 0;
        const gatedSink = EventSink.EventSinkV2.of({
          ...eventSink,
          write: (input) => {
            if (
              input.events.some(
                (event) => event.type === "thread.metadata-updated" && event.threadId === childId,
              )
            ) {
              correctionWrites++;
              if (failure === "write" && correctionWrites === 1)
                return Effect.fail(new EventSink.EventSinkWriteError({ eventCount: 1 }));
            }
            return input.events.some(
              (event) => event.type === "thread.created" && event.threadId === childId,
            )
              ? Deferred.succeed(beforeCommit, undefined).pipe(
                  Effect.andThen(Deferred.await(allowCommit)),
                  Effect.andThen(eventSink.write(input)),
                )
              : eventSink.write(input);
          },
        });
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
          Effect.provide(Layer.fresh(ProviderEventIngestor.layer)),
          Effect.provideService(EventSink.EventSinkV2, gatedSink),
          Effect.provideService(GitVcsDriver.GitVcsDriver, {
            ...git,
            resolveBranchName: (cwd, refName) =>
              failure === "git"
                ? Effect.fail(
                    new GitCommandError({
                      operation: "ingestor-test",
                      cwd,
                      command: "rev-parse",
                      detail: "Read failed",
                    }),
                  )
                : git.resolveBranchName(cwd, refName),
          }),
        );
        const providerSessionId = yield* ids.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: parent.id,
        });
        const creationInput = {
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: parent.id,
          event: {
            type: "app_thread.created",
            driver: CODEX_DRIVER,
            appThread: {
              ...parent,
              id: childId,
              lineage: {
                parentThreadId: parent.id,
                rootThreadId: parent.id,
                relationshipToParent: "subagent",
              },
            },
          },
        } satisfies ProviderEventIngestor.ProviderEventIngestInput;
        const creation = yield* ingestor.ingestNormalized(creationInput).pipe(
          Effect.tapCause((cause) => Deferred.failCause(beforeCommit, cause)),
          Effect.forkScoped,
        );
        yield* Deferred.await(beforeCommit);
        yield* command(worktreePath, ["branch", "-m", "generated-branch"]);
        yield* eventSink.write({
          events: [
            {
              ...rootEvent,
              id: yield* ids.allocate.event({ threadId: parent.id }),
              type: "thread.metadata-updated",
              payload: {
                ...parent,
                branch: parentMoved ? "user/checkout" : "generated-branch",
                worktreePath: parentMoved ? `${worktreePath}-moved` : worktreePath,
              },
            },
          ],
        });
        // The rename's final scan finishes while the child is still uncommitted.
        const snapshot = yield* projections.getShellSnapshot();
        assert.isFalse(
          [...snapshot.threads, ...snapshot.archivedThreads].some(
            (thread) =>
              thread.worktreePath === parent.worktreePath && thread.branch === parent.branch,
          ),
        );
        yield* Deferred.succeed(allowCommit, undefined);
        const stored = yield* Fiber.join(creation);
        assert.equal(stored[0]?.event.type, "thread.created");
        const child = yield* projections.getThread(childId);
        assert.equal(child.branch, failure === null ? "generated-branch" : parent.branch);
        assert.equal(child.worktreePath, parent.worktreePath);
        assert.equal(correctionWrites, failure === "git" ? 0 : 1);
        assert.deepEqual(yield* ingestor.ingestNormalized(creationInput), []);
      }),
  );

  // regression: #20079 the renamed-branch correction must not rewrite a child that needs none
  it.effect.each(["explicit", "detached"])(
    "preserves a native child's branch when the checkout needs no correction: %s",
    (scenario) =>
      Effect.gen(function* () {
        const { worktreePath, command } = yield* makeSharedWorktree;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const branch = scenario === "explicit" ? "child-feature" : "t3/abcd1234";
        if (scenario === "explicit") yield* command(worktreePath, ["branch", "-m", branch]);
        if (scenario === "detached") yield* command(worktreePath, ["checkout", "--detach"]);
        const now = yield* DateTime.now;
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const root = yield* threadCreatedEvent(now);
        if (root.type !== "thread.created") throw new Error("Expected thread fixture");
        yield* sink.write({
          events: [
            { ...root, payload: { ...root.payload, branch: "parent-feature", worktreePath } },
          ],
        });
        const childId = ids.derive.threadFromProviderThread({
          driver: CODEX_DRIVER,
          nativeThreadId: `no-correction:${scenario}`,
        });
        let gitReads = 0;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
          Effect.provide(Layer.fresh(ProviderEventIngestor.layer)),
          Effect.provideService(GitVcsDriver.GitVcsDriver, {
            ...git,
            resolveBranchName: (cwd, refName) => {
              gitReads++;
              return git.resolveBranchName(cwd, refName);
            },
          }),
        );
        const stored = yield* ingestor.ingestNormalized({
          providerSessionId: yield* ids.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId: root.threadId,
          }),
          providerInstanceId: modelSelection.instanceId,
          threadId: root.threadId,
          event: {
            type: "app_thread.created",
            driver: CODEX_DRIVER,
            appThread: {
              ...root.payload,
              id: childId,
              branch,
              worktreePath,
              lineage: {
                parentThreadId: root.threadId,
                rootThreadId: root.threadId,
                relationshipToParent: "subagent",
              },
            },
          },
        });
        assert.equal((yield* projections.getThread(childId)).branch, branch);
        assert.equal(stored.length, 1);
        assert.equal(gitReads, scenario === "explicit" ? 0 : 1);
      }),
  );

  it.effect("updates provider child metadata without recreating its saved thread", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") throw new Error("Expected thread fixture");
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "workflow-member-metadata",
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });
      const offered = {
        ...rootEvent.payload,
        id: childThreadId,
        title: "Inspect checkout",
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: rootEvent.threadId,
          relationshipToParent: "subagent" as const,
          rootThreadId: rootEvent.threadId,
        },
      };
      const ingest = (appThread: OrchestrationV2AppThread) =>
        ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootEvent.threadId,
          event: { type: "app_thread.created", driver: CODEX_DRIVER, appThread },
        });
      yield* eventSink.write({ events: [rootEvent] });
      const created = yield* Effect.all([ingest(offered), ingest(offered)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(
        created.flat().map((stored) => stored.event.type),
        ["thread.created"],
      );
      const saved = {
        ...offered,
        archivedAt: now,
        deletedAt: now,
        activeProviderThreadId: rootEvent.payload.activeProviderThreadId,
        branch: "user/checkout",
      };
      yield* eventSink.write({
        events: [
          {
            ...rootEvent,
            id: yield* idAllocator.allocate.event({ threadId: childThreadId }),
            threadId: childThreadId,
            type: "thread.deleted",
            payload: saved,
          },
        ],
      });
      for (const metadata of [
        { title: "Review checkout", modelSelection },
        { title: "Review checkout", modelSelection: { ...modelSelection, model: "gpt-6.1-sol" } },
      ]) {
        const updated = yield* ingest({ ...offered, ...metadata });
        assert.deepEqual(
          updated.map((stored) => stored.event.type),
          ["thread.metadata-updated"],
        );
        const thread = yield* projectionStore.getThread(childThreadId);
        assert.deepEqual(thread, { ...saved, ...metadata, updatedAt: thread.updatedAt });
      }
      assert.deepEqual(
        yield* ingest({
          ...offered,
          title: "Review checkout",
          modelSelection: { ...modelSelection, model: "gpt-6.1-sol" },
        }),
        [],
      );
    }),
  );

  it.effect(
    "recovers a missing Claude child once and preserves saved metadata on later recovery",
    () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const rootEvent = yield* threadCreatedEvent(now);
        if (rootEvent.type !== "thread.created") throw new Error("Expected thread fixture");
        const driver = ProviderDriverKind.make("claude");
        const providerInstanceId = ProviderInstanceId.make("claude");
        const childThreadId = idAllocator.derive.threadFromProviderThread({
          driver,
          nativeThreadId: "recovered-claude-child",
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId,
          threadId: rootEvent.threadId,
        });
        const recovered: OrchestrationV2AppThread = {
          ...rootEvent.payload,
          id: childThreadId,
          title: "Recovered subagent",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet-4-6" },
          activeProviderThreadId: null,
          createdBy: "agent",
          creationSource: "provider",
          lineage: {
            parentThreadId: rootEvent.threadId,
            relationshipToParent: "subagent",
            rootThreadId: rootEvent.threadId,
          },
        };
        const ingest = (appThread: OrchestrationV2AppThread, createOnly: boolean) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId,
            threadId: rootEvent.threadId,
            event: { type: "app_thread.created", driver, appThread, createOnly },
          });
        yield* eventSink.write({ events: [rootEvent] });
        const created = yield* Effect.all([ingest(recovered, true), ingest(recovered, true)], {
          concurrency: "unbounded",
        });
        assert.deepEqual(
          created.flat().map((stored) => stored.event.type),
          ["thread.created"],
        );
        assert.deepEqual(yield* projectionStore.getThread(childThreadId), recovered);

        yield* ingest(
          {
            ...recovered,
            title: "Review authentication",
            modelSelection: { instanceId: providerInstanceId, model: "claude-opus-4-6" },
          },
          false,
        );
        const saved = yield* projectionStore.getThread(childThreadId);
        assert.equal(saved.title, "Review authentication");
        assert.equal(saved.modelSelection.model, "claude-opus-4-6");
        assert.deepEqual(yield* ingest(recovered, true), []);
        assert.deepEqual(yield* projectionStore.getThread(childThreadId), saved);
      }),
  );

  it.effect("moves a native subagent's thread to the model its provider reports later", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") {
        throw new Error("Expected a thread.created fixture event");
      }
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-late-model-subagent",
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });
      const ingest = (event: ProviderEventIngestor.ProviderEventIngestInput["event"]) =>
        ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootEvent.threadId,
          event,
        });
      yield* eventSink.write({ events: [rootEvent] });
      yield* ingest({
        type: "app_thread.created",
        driver: CODEX_DRIVER,
        appThread: {
          ...rootEvent.payload,
          id: childThreadId,
          title: "review design",
          modelSelection: {
            ...modelSelection,
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: rootEvent.threadId,
            relationshipToParent: "subagent",
            rootThreadId: rootEvent.threadId,
          },
        },
      });
      const subagentUpdated = {
        type: "subagent.updated",
        driver: CODEX_DRIVER,
        subagent: {
          id: NodeId.make("node:late-model-subagent"),
          threadId: rootEvent.threadId,
          runId: null,
          parentNodeId: NodeId.make("node:root"),
          origin: "provider_native",
          createdBy: "agent",
          driver: CODEX_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Review the design",
          title: "review design",
          model: "gpt-6.1-sol",
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      } satisfies ProviderEventIngestor.ProviderEventIngestInput["event"];

      const first = yield* ingest(subagentUpdated);
      const repeated = yield* ingest(subagentUpdated);
      const childThread = yield* projectionStore.getThread(childThreadId);

      assert.deepEqual(
        first.map((stored) => [stored.event.type, stored.event.threadId]),
        [
          ["subagent.updated", rootEvent.threadId],
          ["thread.model-selection-updated", childThreadId],
        ],
      );
      assert.deepEqual(
        repeated.map((stored) => stored.event.type),
        ["subagent.updated"],
      );
      assert.deepEqual(childThread.modelSelection, {
        instanceId: modelSelection.instanceId,
        model: "gpt-6.1-sol",
      });

      const reportedSelection = {
        instanceId: modelSelection.instanceId,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const reported = yield* ingest({
        ...subagentUpdated,
        subagent: { ...subagentUpdated.subagent, modelSelection: reportedSelection },
      });
      assert.deepEqual(
        reported.map((stored) => stored.event.type),
        ["subagent.updated", "thread.model-selection-updated"],
      );
      assert.deepEqual(
        (yield* projectionStore.getThread(childThreadId)).modelSelection,
        reportedSelection,
      );

      const recovered = yield* ingest(subagentUpdated);
      assert.deepEqual(
        recovered.map((stored) => stored.event.type),
        ["subagent.updated"],
      );
      assert.deepEqual(
        (yield* projectionStore.getThread(childThreadId)).modelSelection,
        reportedSelection,
      );
    }),
  );
});
