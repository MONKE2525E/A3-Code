import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  OrchestrationV2ThreadShellJson,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { museThreadIdForSession } from "../museAgent/MuseAgentThreadIds.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const sqlLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const createdAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const completedAt = DateTime.makeUnsafe("2026-10-02T00:00:00.000Z");
const visitedAt = DateTime.makeUnsafe("2026-10-02T12:00:00.000Z");
const importedAt = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
const repliedAt = DateTime.makeUnsafe("2026-10-04T00:00:00.000Z");
const encodeThreadShell = Schema.encodeEffect(OrchestrationV2ThreadShellJson);
const museIdentity = "e95e6ca23067134c5f3a6110b701f50bb658347838651b8a2954ba1fc3dcabd8";
const museInstanceId = ProviderInstanceId.make("muse-agent");

type ThreadSpec = {
  readonly label: string;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
};

const grokThread: ThreadSpec = {
  label: "grok",
  threadId: ThreadId.make("grok-bot:notifications"),
  instanceId: ProviderInstanceId.make("grok-bot"),
  model: "grok",
};
const museMainThread: ThreadSpec = {
  label: "muse-main",
  threadId: ThreadId.make(museThreadIdForSession(museIdentity)),
  instanceId: museInstanceId,
  model: "muse",
};
const museSideThread: ThreadSpec = {
  label: "muse-side",
  threadId: ThreadId.make(museThreadIdForSession(museIdentity, "side chat")),
  instanceId: museInstanceId,
  model: "muse",
};
const ordinaryThread: ThreadSpec = {
  label: "ordinary",
  threadId: ThreadId.make("ordinary:notifications"),
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt",
};
const nativeThreads = [grokThread, museMainThread, museSideThread];
const museThreads = [museMainThread, museSideThread];

type Store = ProjectionStore.ProjectionStoreV2Shape;
type MessageInput = Partial<OrchestrationV2ConversationMessage> & { readonly id: MessageId };

const sequencedEventIds = () => {
  let sequence = 0;
  return () => EventId.make(`event:${sequence++}`);
};

/** A thread row as the orchestrator creates it; a visit only changes `lastVisitedAt`. */
const threadRecord = (spec: ThreadSpec) =>
  ({
    createdBy: "user",
    creationSource: "web",
    id: spec.threadId,
    projectId: ProjectId.make("project:notifications"),
    title: "Notifications",
    providerInstanceId: spec.instanceId,
    modelSelection: { instanceId: spec.instanceId, model: spec.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: spec.threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  }) as const;

const createThread = (store: Store, nextEventId: () => EventId, spec: ThreadSpec) =>
  store.apply({
    id: nextEventId(),
    type: "thread.created",
    threadId: spec.threadId,
    occurredAt: createdAt,
    payload: threadRecord(spec),
  });

const createRun = (
  store: Store,
  nextEventId: () => EventId,
  spec: ThreadSpec,
  input: {
    readonly id: RunId;
    readonly status: "completed" | "rolled_back";
    readonly at: DateTime.Utc;
    readonly userMessageId: MessageId;
    readonly rootNodeId: NodeId;
  },
) =>
  store.apply({
    id: nextEventId(),
    type: "run.created",
    threadId: spec.threadId,
    occurredAt: input.at,
    payload: {
      id: input.id,
      threadId: spec.threadId,
      ordinal: 1,
      providerInstanceId: spec.instanceId,
      modelSelection: { instanceId: spec.instanceId, model: spec.model },
      providerThreadId: null,
      userMessageId: input.userMessageId,
      rootNodeId: input.rootNodeId,
      activeAttemptId: null,
      status: input.status,
      requestedAt: input.at,
      startedAt: input.at,
      completedAt: input.at,
      checkpointId: null,
      contextHandoffId: null,
    },
  });

const appendMessage = (
  store: Store,
  nextEventId: () => EventId,
  threadId: ThreadId,
  input: MessageInput,
) =>
  store.apply({
    id: nextEventId(),
    type: "message.updated",
    threadId,
    occurredAt: input.updatedAt ?? completedAt,
    payload: {
      createdBy: "agent",
      creationSource: "provider",
      threadId,
      runId: null,
      nodeId: null,
      role: "assistant",
      text: "private transcript body".repeat(1000),
      attachments: [],
      streaming: false,
      createdAt: completedAt,
      updatedAt: completedAt,
      ...input,
    },
  });

const assertMarker = (store: Store, threadId: ThreadId, expectedId: MessageId | null) =>
  Effect.gen(function* () {
    const shell = yield* store.getThreadShell(threadId);
    assert.strictEqual(shell?.latestVisibleMessage?.id ?? null, expectedId);
    const snapshot = yield* store.getShellSnapshot();
    assert.deepStrictEqual(
      snapshot.threads.find((thread) => thread.id === threadId)?.latestVisibleMessage,
      shell?.latestVisibleMessage,
    );
    const captured = yield* store.readShellSnapshot();
    assert.deepStrictEqual(
      (yield* captured).threads.find((thread) => thread.id === threadId)?.latestVisibleMessage,
      shell?.latestVisibleMessage,
    );
    if (expectedId !== null) {
      assert.strictEqual(shell?.latestVisibleMessage?.text, "");
      assert.strictEqual(shell?.latestVisibleMessage?.role, "assistant");
      assert.strictEqual(
        DateTime.formatIso(shell!.latestVisibleMessage!.createdAt!),
        DateTime.formatIso(completedAt),
      );
      const encoded = yield* encodeThreadShell(shell!);
      assert.strictEqual(encoded.latestVisibleMessage?.createdAt, DateTime.formatIso(completedAt));
      assert.isBelow(JSON.stringify(encoded.latestVisibleMessage).length, 250);
    }
  });

const notificationMarkers = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const nextEventId = sequencedEventIds();
  for (const spec of [...nativeThreads, ordinaryThread]) {
    yield* createThread(store, nextEventId, spec);
  }
  for (const spec of nativeThreads) {
    const id = (name: string) => MessageId.make(`message:${spec.label}:${name}`);
    const streamingId = id("streaming");
    const completeId = id("completed");
    yield* appendMessage(store, nextEventId, spec.threadId, { id: streamingId, streaming: true });
    yield* assertMarker(store, spec.threadId, null);
    yield* appendMessage(store, nextEventId, spec.threadId, { id: completeId });
    yield* assertMarker(store, spec.threadId, completeId);
    // Gateway history imports use a fresh updatedAt, but keep the native createdAt.
    yield* appendMessage(store, nextEventId, spec.threadId, {
      id: id("backfill"),
      createdAt,
      updatedAt: importedAt,
    });
    yield* appendMessage(store, nextEventId, spec.threadId, {
      id: id("user"),
      role: "user",
      createdAt: importedAt,
    });
    yield* appendMessage(store, nextEventId, spec.threadId, {
      id: streamingId,
      streaming: true,
      createdAt: importedAt,
    });
    yield* assertMarker(store, spec.threadId, completeId);
    const runId = RunId.make(`run:${spec.label}:rolled-back`);
    yield* createRun(store, nextEventId, spec, {
      id: runId,
      status: "rolled_back",
      at: importedAt,
      userMessageId: id("run-user"),
      rootNodeId: NodeId.make(`node:${spec.label}:rolled-back`),
    });
    yield* appendMessage(store, nextEventId, spec.threadId, {
      id: id("rolled-back"),
      runId,
      createdAt: importedAt,
    });
    yield* assertMarker(store, spec.threadId, completeId);
    // A streaming record becomes eligible only when its completed update lands.
    yield* appendMessage(store, nextEventId, spec.threadId, { id: streamingId, streaming: false });
    yield* assertMarker(store, spec.threadId, streamingId);
  }
  yield* appendMessage(store, nextEventId, ordinaryThread.threadId, {
    id: MessageId.make("message:ordinary"),
  });
  assert.strictEqual(
    (yield* store.getThreadShell(ordinaryThread.threadId))?.latestVisibleMessage,
    null,
  );
});

/** Visits the thread, then completes a run whose reply lands after the visit. */
const replyAfterVisit = (store: Store, nextEventId: () => EventId, spec: ThreadSpec) =>
  Effect.gen(function* () {
    yield* createThread(store, nextEventId, spec);
    yield* store.apply({
      id: nextEventId(),
      type: "thread.visited",
      threadId: spec.threadId,
      occurredAt: visitedAt,
      payload: { ...threadRecord(spec), lastVisitedAt: visitedAt },
    });
    const runId = RunId.make(`run:${spec.label}:completed`);
    yield* createRun(store, nextEventId, spec, {
      id: runId,
      status: "completed",
      at: repliedAt,
      userMessageId: MessageId.make(`message:${spec.label}:prompt`),
      rootNodeId: NodeId.make(`node:${spec.label}:completed`),
    });
    const reply = MessageId.make(`message:${spec.label}:reply`);
    yield* appendMessage(store, nextEventId, spec.threadId, {
      id: reply,
      runId,
      createdAt: repliedAt,
      updatedAt: repliedAt,
    });
    return reply;
  });

/**
 * A visited Muse thread must expose a reply that follows its completed run, so the sidebar can show
 * it unread against `lastVisitedAt`.
 */
const replyAfterVisitMarkers = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const nextEventId = sequencedEventIds();
  for (const spec of museThreads) {
    const reply = yield* replyAfterVisit(store, nextEventId, spec);
    const shell = yield* store.getThreadShell(spec.threadId);
    assert.strictEqual(shell?.latestVisibleMessage?.id, reply);
    assert.strictEqual(
      DateTime.formatIso(shell!.latestVisibleMessage!.createdAt!),
      DateTime.formatIso(repliedAt),
    );
    assert.strictEqual(DateTime.formatIso(shell!.lastVisitedAt!), DateTime.formatIso(visitedAt));
    const snapshot = yield* store.getShellSnapshot();
    assert.strictEqual(
      snapshot.threads.find((thread) => thread.id === spec.threadId)?.latestVisibleMessage?.id,
      reply,
    );
  }
  // Ordinary coding threads never publish a marker, even after a completed run replies.
  yield* replyAfterVisit(store, nextEventId, ordinaryThread);
  assert.strictEqual(
    (yield* store.getThreadShell(ordinaryThread.threadId))?.latestVisibleMessage,
    null,
  );
});

it.effect("SQL shell publishes bounded completed native notification markers", () =>
  notificationMarkers.pipe(Effect.provide(sqlLayer)),
);
it.effect("memory shell matches completed native notification markers", () =>
  notificationMarkers.pipe(Effect.provide(ProjectionStore.layerMemory)),
);
it.effect("SQL shell publishes a Muse reply that lands after a visit as its marker", () =>
  replyAfterVisitMarkers.pipe(Effect.provide(sqlLayer)),
);
it.effect("memory shell publishes a Muse reply that lands after a visit as its marker", () =>
  replyAfterVisitMarkers.pipe(Effect.provide(ProjectionStore.layerMemory)),
);
