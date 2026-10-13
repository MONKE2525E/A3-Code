import { assert, it } from "@effect/vitest";
import { ProviderTurnId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Store from "./MuseAgentDeliveryStore.ts";
import {
  binding,
  instanceId,
  makeTurn,
  receipt,
  threadId,
} from "../orchestration-v2/Adapters/MuseAgentAdapterV2.testkit.ts";
import { makeMuseAgentProjection } from "../orchestration-v2/Adapters/MuseAgentAdapterV2Projection.ts";

const scope = { binding, sessionId: "primary", threadId, providerInstanceId: instanceId };
const request = {
  binding,
  sessionId: "primary",
  deliveryKey: "muse-attempt-test",
  text: "Synthetic task",
};
const context = Effect.map(makeTurn, (turn) => ({
  threadId: turn.threadId,
  providerInstanceId: turn.modelSelection.instanceId,
  runId: turn.runId,
  nodeId: turn.rootNodeId,
  providerThreadId: turn.providerThread.id,
  providerTurnId: ProviderTurnId.make(
    `provider-turn/muse-agent/${encodeURIComponent(turn.attemptId)}`,
  ),
  userMessageId: turn.message.messageId,
}));
const snapshot = Effect.gen(function* () {
  const projection = makeMuseAgentProjection({
    binding,
    providerInstanceId: instanceId,
    sessionId: "primary",
    threadId,
  });
  projection.begin(yield* makeTurn);
  projection.admit(receipt);
  const events = projection.project({
    event: "message.assistant",
    payload: {
      session_id: "primary",
      message_id: "owned-answer",
      reply_to_message_id: receipt.messageId,
      display_text: "Synthetic answer",
    },
    meta: { seq: 1, ts_ms: 1_000 },
  });
  const message = events.find((event) => event.type === "message.updated");
  const item = events.find((event) => event.type === "turn_item.updated");
  assert.ok(message && item);
  return { message: message.message, turnItem: item.turnItem };
});

const withDatabase = <A, E>(test: (db: NodeSqlite.DatabaseSync) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(":memory:")),
    test,
    (db) => Effect.sync(() => db.close()),
  );

it.effect(
  "restores exact managed receipt and assistant ownership only inside their original scope",
  () =>
    withDatabase((db) =>
      Effect.gen(function* () {
        const owned = yield* context;
        const output = yield* snapshot;
        const store = Store.makeMuseAgentDeliveryStore(db);
        yield* store.begin({ ...request, context: owned });
        yield* store.accept(request.deliveryKey, receipt);
        yield* store.recordManagedMessage({
          ...request,
          nativeMessageId: "owned-answer",
          snapshot: output,
        });
        yield* store.recordManagedMessage({
          ...request,
          nativeMessageId: "owned-answer",
          snapshot: output,
        });
        const reopened = Store.makeMuseAgentDeliveryStore(db);
        assert.deepStrictEqual(yield* reopened.historyOwnership(scope), {
          receipts: [
            {
              messageId: receipt.messageId,
              replyToMessageId: receipt.replyToMessageId,
              context: owned,
            },
          ],
          messages: [
            {
              nativeMessageId: "owned-answer",
              deliveryKey: request.deliveryKey,
              context: owned,
              snapshot: output,
              frozen: false,
            },
          ],
        });
        assert.deepStrictEqual(
          yield* reopened.historyOwnership({ ...scope, sessionId: "foreign" }),
          { receipts: [], messages: [] },
        );
        assert.deepStrictEqual(
          yield* reopened.historyOwnership({ ...scope, binding: "b".repeat(64) }),
          { receipts: [], messages: [] },
        );
        assert.deepStrictEqual(
          yield* reopened.historyOwnership({ ...scope, threadId: ThreadId.make("foreign-thread") }),
          { receipts: [], messages: [] },
        );
        assert.deepStrictEqual(
          yield* reopened.historyOwnership({
            ...scope,
            providerInstanceId: ProviderInstanceId.make("foreign-provider"),
          }),
          { receipts: [], messages: [] },
        );
      }),
    ),
);

it.effect(
  "preserves a final coherent owned snapshot against late partials and recycled native IDs",
  () =>
    withDatabase((db) =>
      Effect.gen(function* () {
        const store = Store.makeMuseAgentDeliveryStore(db);
        const output = yield* snapshot;
        assert.ok(output.turnItem.type === "assistant_message");
        yield* store.begin({ ...request, context: yield* context });
        yield* store.accept(request.deliveryKey, receipt);
        yield* store.recordManagedMessage({
          ...request,
          nativeMessageId: "owned-answer",
          snapshot: output,
        });
        yield* store.recordManagedMessage({
          ...request,
          nativeMessageId: "owned-answer",
          snapshot: {
            message: { ...output.message, text: "Late partial", streaming: true },
            turnItem: {
              ...output.turnItem,
              text: "Late partial",
              streaming: true,
              status: "running",
            },
          },
        });
        assert.strictEqual(
          (yield* store.historyOwnership(scope)).messages[0]?.snapshot.message.text,
          "Synthetic answer",
        );
        yield* store.settle(request.deliveryKey);
        yield* store.recordManagedMessage({
          ...request,
          nativeMessageId: "owned-answer",
          snapshot: {
            message: { ...output.message, text: "Foreign replacement" },
            turnItem: { ...output.turnItem, text: "Foreign replacement" },
          },
        });
        const restored = (yield* store.historyOwnership(scope)).messages[0];
        assert.strictEqual(restored?.snapshot.message.text, "Synthetic answer");
        assert.strictEqual(restored?.frozen, true);
      }),
    ),
);

it.effect("rejects foreign delivery scopes and incoherent assistant snapshots", () =>
  withDatabase((db) =>
    Effect.gen(function* () {
      const store = Store.makeMuseAgentDeliveryStore(db);
      const output = yield* snapshot;
      yield* store.begin({ ...request, context: yield* context });
      yield* store.accept(request.deliveryKey, receipt);
      assert.strictEqual(
        (yield* Effect.flip(
          store.recordManagedMessage({
            ...request,
            binding: "b".repeat(64),
            nativeMessageId: "owned-answer",
            deliveryKey: request.deliveryKey,
            snapshot: output,
          }),
        )).kind,
        "conflict",
      );
      assert.strictEqual(
        (yield* Effect.flip(
          store.recordManagedMessage({
            ...request,
            nativeMessageId: "owned-answer",
            snapshot: { ...output, message: { ...output.message, text: "Mismatched text" } },
          }),
        )).kind,
        "conflict",
      );
      assert.strictEqual(
        (yield* Effect.flip(store.releaseLocalOwnership({ ...request, sessionId: "foreign" })))
          .kind,
        "conflict",
      );
      assert.strictEqual((yield* store.pendingDeliveries(request)).length, 1);
    }),
  ),
);

it.effect("migrates legacy receipts without inventing historical T3 ownership", () =>
  withDatabase((db) =>
    Effect.gen(function* () {
      db.exec(
        "CREATE TABLE muse_deliveries (delivery_key TEXT PRIMARY KEY,binding TEXT NOT NULL,session_id TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,receipt_json TEXT)",
      );
      db.prepare("INSERT INTO muse_deliveries VALUES(?,?,?,'legacy-hash','accepted',?)").run(
        request.deliveryKey,
        binding,
        request.sessionId,
        JSON.stringify(receipt),
      );
      const store = Store.makeMuseAgentDeliveryStore(db);
      assert.deepStrictEqual(yield* store.historyOwnership(scope), { receipts: [], messages: [] });
      assert.deepStrictEqual(yield* store.pendingDeliveries(request), [
        { deliveryKey: request.deliveryKey, status: "accepted", context: null },
      ]);
    }),
  ),
);

it.effect(
  "releases local ownership without allowing the old delivery to admit or replay again",
  () =>
    withDatabase((db) =>
      Effect.gen(function* () {
        const store = Store.makeMuseAgentDeliveryStore(db);
        yield* store.begin({ ...request, context: yield* context });
        yield* store.accept(request.deliveryKey, receipt);
        yield* store.releaseLocalOwnership(request);
        yield* store.releaseLocalOwnership(request);
        assert.strictEqual((yield* Effect.flip(store.begin(request))).kind, "uncertain");
        yield* store.accept(request.deliveryKey, receipt);
        yield* store.settle(request.deliveryKey);
        assert.deepStrictEqual(yield* store.pendingDeliveries(request), []);
        assert.strictEqual((yield* Effect.flip(store.begin(request))).kind, "uncertain");
        assert.strictEqual(yield* store.begin({ ...request, deliveryKey: "new-attempt" }), null);
        assert.strictEqual(
          db
            .prepare("SELECT status FROM muse_deliveries WHERE delivery_key=?")
            .get(request.deliveryKey)?.status,
          "released",
        );
      }),
    ),
);

it.effect(
  "retains an ambiguous intent tombstone even when a native acknowledgement arrives after release",
  () =>
    withDatabase((db) =>
      Effect.gen(function* () {
        const store = Store.makeMuseAgentDeliveryStore(db);
        yield* store.begin({ ...request, context: yield* context });
        yield* store.releaseLocalOwnership(request);
        yield* store.accept(request.deliveryKey, receipt);
        assert.strictEqual((yield* Effect.flip(store.begin(request))).kind, "uncertain");
        assert.strictEqual(yield* store.begin({ ...request, deliveryKey: "new-attempt" }), null);
        assert.strictEqual(
          db
            .prepare("SELECT status FROM muse_deliveries WHERE delivery_key=?")
            .get(request.deliveryKey)?.status,
          "released",
        );
      }),
    ),
);
