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
import * as ProjectionStore from "./ProjectionStore.ts";

const sqlLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const createdAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const completedAt = DateTime.makeUnsafe("2026-10-02T00:00:00.000Z");
const importedAt = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
const encodeThreadShell = Schema.encodeEffect(OrchestrationV2ThreadShellJson);
const instanceId = ProviderInstanceId.make("grok-bot");
const modelSelection = { instanceId, model: "grok" };

const notificationMarkers = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const nativeId = ThreadId.make("grok-bot:notifications");
  const ordinaryId = ThreadId.make("ordinary:notifications");
  let sequence = 0;
  for (const threadId of [nativeId, ordinaryId]) {
    yield* store.apply({
      id: EventId.make(`event:${sequence++}`),
      type: "thread.created",
      threadId,
      occurredAt: createdAt,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:notifications"),
        title: "Notifications",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  }
  const message = (input: Partial<OrchestrationV2ConversationMessage> & { id: MessageId }) =>
    store.apply({
      id: EventId.make(`event:${sequence++}`),
      type: "message.updated",
      threadId: input.threadId ?? nativeId,
      occurredAt: input.updatedAt ?? completedAt,
      payload: {
        createdBy: "agent",
        creationSource: "provider",
        threadId: nativeId,
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
  const assertMarker = (expectedId: MessageId | null) =>
    Effect.gen(function* () {
      const shell = yield* store.getThreadShell(nativeId);
      assert.strictEqual(shell?.latestVisibleMessage?.id ?? null, expectedId);
      const snapshot = yield* store.getShellSnapshot();
      assert.deepStrictEqual(
        snapshot.threads.find((thread) => thread.id === nativeId)?.latestVisibleMessage,
        shell?.latestVisibleMessage,
      );
      const captured = yield* store.readShellSnapshot();
      assert.deepStrictEqual(
        (yield* captured).threads.find((thread) => thread.id === nativeId)?.latestVisibleMessage,
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
        assert.strictEqual(
          encoded.latestVisibleMessage?.createdAt,
          DateTime.formatIso(completedAt),
        );
        assert.isBelow(JSON.stringify(encoded.latestVisibleMessage).length, 250);
      }
    });
  const completeId = MessageId.make("message:completed");
  const streamingId = MessageId.make("message:streaming");
  yield* message({ id: streamingId, streaming: true });
  yield* assertMarker(null);
  yield* message({ id: completeId });
  yield* assertMarker(completeId);
  // Gateway history imports use a fresh updatedAt, but keep the native createdAt.
  yield* message({ id: MessageId.make("message:backfill"), createdAt, updatedAt: importedAt });
  yield* message({ id: MessageId.make("message:user"), role: "user", createdAt: importedAt });
  yield* message({ id: streamingId, streaming: true, createdAt: importedAt });
  yield* assertMarker(completeId);
  yield* message({ id: MessageId.make("message:ordinary"), threadId: ordinaryId });
  assert.strictEqual((yield* store.getThreadShell(ordinaryId))?.latestVisibleMessage, null);
  const runId = RunId.make("run:rolled-back");
  yield* store.apply({
    id: EventId.make(`event:${sequence++}`),
    type: "run.created",
    threadId: nativeId,
    occurredAt: importedAt,
    payload: {
      id: runId,
      threadId: nativeId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message:run-user"),
      rootNodeId: NodeId.make("node:rolled-back"),
      activeAttemptId: null,
      status: "rolled_back",
      requestedAt: importedAt,
      startedAt: importedAt,
      completedAt: importedAt,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* message({ id: MessageId.make("message:rolled-back"), runId, createdAt: importedAt });
  yield* assertMarker(completeId);
  // A streaming record becomes eligible only when its completed update lands.
  yield* message({ id: streamingId, streaming: false });
  yield* assertMarker(streamingId);
});

it.effect("SQL shell publishes bounded completed native GrokBot notification markers", () =>
  notificationMarkers.pipe(Effect.provide(sqlLayer)),
);
it.effect("memory shell matches completed native GrokBot notification markers", () =>
  notificationMarkers.pipe(Effect.provide(ProjectionStore.layerMemory)),
);
