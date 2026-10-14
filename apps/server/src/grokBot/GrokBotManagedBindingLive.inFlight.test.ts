import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Endpoint from "../cloud/ManagedEndpointAddress.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import type { GrokBotTurnIdentity } from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";
import { GrokBotManagedBinding } from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import { makeGrokBotTranscriptProjection } from "../orchestration-v2/Adapters/GrokBotAdapterV2.ts";
import { nativeSession } from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Live from "./GrokBotManagedBindingLive.ts";
import * as Native from "./GrokBotNativeRuntimeService.ts";
import * as Store from "./GrokBotManagedStateStore.ts";

// A real projection store: the in-flight query runs against actual SQL rows, not a stubbed hook.
const projectionLayer = Projection.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const bindingLayer = Live.layer.pipe(
  Layer.provide([
    Layer.mock(Store.GrokBotManagedStateStore)({}),
    Layer.mock(Native.GrokBotNativeRuntimeService)({
      accountBinding: Effect.succeed(nativeSession.binding),
    }),
    Layer.mock(Registry.McpSessionRegistry)({}),
    Layer.mock(Endpoint.ManagedEndpointAddress)({}),
    Layer.mock(ServerSettings.ServerSettingsService)({}),
    NodeCrypto.layer,
  ]),
  Layer.provideMerge(projectionLayer),
);

const at = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const instanceId = ProviderInstanceId.make("grok-bot");
const root = NodeId.make("node:root");

let sequence = 0;
const eventId = () => EventId.make(`event:${sequence++}`);

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* Projection.ProjectionStoreV2;
    yield* store.apply({
      id: eventId(),
      type: "thread.created",
      threadId,
      occurredAt: at,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:in-flight"),
        title: "In flight",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "bot" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  });

const tool = (
  id: string,
  threadId: ThreadId,
  runId: RunId,
  status: "running" | "completed" | "failed",
  nodeId = root,
) =>
  Effect.gen(function* () {
    const store = yield* Projection.ProjectionStoreV2;
    yield* store.apply({
      id: eventId(),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: {
        id: TurnItemId.make(id),
        type: "dynamic_tool",
        threadId,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status,
        title: "tool",
        toolName: "tool",
        input: {},
        startedAt: at,
        completedAt: status === "running" ? null : at,
        updatedAt: at,
      },
    } as never);
  });

const child = (
  id: string,
  threadId: ThreadId,
  runId: RunId,
  parentNodeId: NodeId,
  status: "pending" | "running" | "waiting" | "completed" | "failed",
) =>
  Effect.gen(function* () {
    const store = yield* Projection.ProjectionStoreV2;
    yield* store.apply({
      id: eventId(),
      type: "subagent.updated",
      threadId,
      occurredAt: at,
      payload: {
        id: id,
        threadId,
        runId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("grok-bot"),
        providerInstanceId: instanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "work",
        title: null,
        model: null,
        status,
        result: null,
        startedAt: null,
        completedAt: null,
        updatedAt: at,
      },
    } as never);
  });

const identity = (threadId: ThreadId, runId: RunId) =>
  ({ native: { threadId }, runId, rootNodeId: root }) as unknown as GrokBotTurnIdentity;

const inFlight = (threadId: ThreadId, runId: RunId) =>
  GrokBotManagedBinding.pipe(
    Effect.flatMap((binding) => binding.inFlightWork!(identity(threadId, runId))),
  );

it.effect("one live batch preserves timestamp-free assistant replies after reconnect", () =>
  Effect.gen(function* () {
    const home = ThreadId.make("grok-bot:replay-lookup");
    yield* seedThread(home);
    const native = { ...nativeSession, threadId: home };
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* Projection.ProjectionStoreV2;
    const binding = yield* GrokBotManagedBinding;
    const frame = {
      _tag: "Rows",
      generation: 0,
      replay: true,
      deletes: [],
      entries: ["First reply.", "Second reply.", "Third reply."].map((content, index) => ({
        seq: String(index + 1),
        updatedSeq: "1",
        value: {
          id: `earlier-reply-${index}`,
          kind: "send-message",
          message: { type: "text", content },
        },
      })),
    } as const;
    yield* TestClock.setTime(DateTime.toEpochMillis(at));
    const first = yield* makeGrokBotTranscriptProjection({ native, idAllocator }).project(frame);
    const originals = first
      .filter((event) => event.type === "message.updated")
      .map((event) => event.message);
    for (const original of originals)
      yield* projections.apply({
        id: eventId(),
        type: "message.updated",
        threadId: home,
        occurredAt: at,
        payload: original,
      });
    yield* TestClock.adjust("2 minutes");
    let reads = 0;
    const projector = makeGrokBotTranscriptProjection({
      native,
      idAllocator,
      existingMessages: (ids) => {
        reads++;
        assert.deepEqual(
          ids,
          originals.map((message) => message.id),
        );
        return binding.existingMessages!(native, ids);
      },
    });
    const replay = yield* projector.project(frame);
    assert.deepEqual(
      replay
        .filter((event) => event.type === "message.updated")
        .map((event) => ({ text: event.message.text, createdAt: event.message.createdAt })),
      originals.map((message) => ({ text: message.text, createdAt: message.createdAt })),
    );
    assert.deepEqual(yield* projector.project(frame), []);
    assert.equal(reads, 1);
  }).pipe(Effect.provide(Layer.merge(bindingLayer, IdAllocator.layer))),
);

it.effect("inFlightWork holds live tools without holding the native turn for async children", () =>
  Effect.gen(function* () {
    const home = ThreadId.make("grok-bot:home");
    const other = ThreadId.make("grok-bot:other");
    const run = RunId.make("run:home");
    const foreignRun = RunId.make("run:foreign");
    yield* seedThread(home);
    yield* seedThread(other);

    assert.isFalse(yield* inFlight(home, run), "empty projection");

    // Terminal work never holds a turn.
    yield* tool("tool:done", home, run, "completed");
    yield* tool("tool:failed", home, run, "failed");
    yield* child("child:done", home, run, root, "completed");
    yield* child("child:failed", home, run, root, "failed");
    assert.isFalse(yield* inFlight(home, run), "completed/failed only");

    // Foreign run, other node, and other thread (environment/account scope) never hold it.
    yield* tool("tool:foreign-run", home, foreignRun, "running");
    yield* tool("tool:other-node", home, run, "running", NodeId.make("node:other"));
    yield* tool("tool:other-thread", other, run, "running");
    yield* child("child:foreign", home, foreignRun, NodeId.make("node:foreign"), "running");
    yield* child("child:other-thread", other, run, root, "running");
    assert.isFalse(yield* inFlight(home, run), "foreign scope");

    // A blocking MCP tool holds the turn; async children do not.
    yield* tool("tool:live", home, run, "running");
    assert.isTrue(yield* inFlight(home, run), "running root dynamic_tool");
    yield* tool("tool:live", home, run, "completed");
    assert.isFalse(yield* inFlight(home, run), "tool closed releases");

    for (const status of ["pending", "running", "waiting"] as const) {
      yield* child("child:live", home, run, root, status);
      assert.isFalse(yield* inFlight(home, run), `async child ${status}`);
    }
    yield* child("child:live", home, run, root, "completed");
    assert.isFalse(yield* inFlight(home, run), "child closed releases");

    // Nested async work has its own lifecycle.
    yield* child("child:run-scoped", home, run, NodeId.make("node:nested"), "running");
    assert.isFalse(yield* inFlight(home, run), "async run-scoped child");
    // Root-parented async work likewise leaves native completion free to settle.
    yield* child("child:run-scoped", home, run, NodeId.make("node:nested"), "completed");
    yield* child("child:parented", home, foreignRun, root, "waiting");
    assert.isFalse(yield* inFlight(home, run), "async root-parented child");
  }).pipe(Effect.provide(bindingLayer)),
);

it.effect("inFlightWork treats an unreadable projection as in flight", () =>
  Effect.gen(function* () {
    const binding = yield* GrokBotManagedBinding;
    const held = yield* binding.inFlightWork!(
      identity(ThreadId.make("grok-bot:x"), RunId.make("r")),
    );
    assert.isTrue(held);
  }).pipe(
    Effect.provide(
      Live.layer.pipe(
        Layer.provide([
          Layer.mock(Store.GrokBotManagedStateStore)({}),
          Layer.mock(Native.GrokBotNativeRuntimeService)({}),
          Layer.mock(Registry.McpSessionRegistry)({}),
          Layer.mock(Endpoint.ManagedEndpointAddress)({}),
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(Projection.ProjectionStoreV2)({
            getThreadRecords: (() => Effect.die("read failure")) as never,
          }),
          NodeCrypto.layer,
        ]),
      ),
    ),
  ),
);
