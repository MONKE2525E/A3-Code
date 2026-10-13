import { assert, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Store from "./MuseAgentDeliveryStore.ts";

const request = {
  binding: "a".repeat(64),
  sessionId: "primary",
  deliveryKey: "attempt-1",
  text: "Synthetic task",
};
const receipt = { sessionId: "primary", messageId: "user-1", replyToMessageId: "carrier-1" };
const withStore = <A, E>(
  test: (store: Store.MuseAgentDeliveryStore["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(":memory:")),
    (db) => test(Store.makeMuseAgentDeliveryStore(db)),
    (db) => Effect.sync(() => db.close()),
  );

it.effect(
  "persists admission once, returns its receipt on retry, and releases the session only after settlement",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* store.begin(request), null);
        yield* store.accept(request.deliveryKey, receipt);
        assert.deepStrictEqual(yield* store.begin(request), receipt);
        assert.strictEqual(
          (yield* Effect.flip(store.begin({ ...request, deliveryKey: "attempt-2" }))).kind,
          "busy",
        );
        yield* store.settle(request.deliveryKey);
        assert.deepStrictEqual(yield* store.begin(request), receipt);
        assert.strictEqual(yield* store.begin({ ...request, deliveryKey: "attempt-2" }), null);
      }),
    ),
);

it.effect(
  "never retries uncertain admission or permits a different request to reuse its identity",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.begin(request);
        assert.strictEqual((yield* Effect.flip(store.begin(request))).kind, "uncertain");
        assert.strictEqual(
          (yield* Effect.flip(store.begin({ ...request, text: "Different" }))).kind,
          "conflict",
        );
        assert.strictEqual(
          (yield* Effect.flip(store.begin({ ...request, binding: "b".repeat(64) }))).kind,
          "conflict",
        );
        assert.strictEqual(
          (yield* Effect.flip(store.settle(request.deliveryKey))).kind,
          "uncertain",
        );
        assert.strictEqual(
          (yield* Effect.flip(store.begin({ ...request, deliveryKey: "next" }))).kind,
          "busy",
        );
      }),
    ),
);

it.effect("rejects a receipt from another session or a replacement admission", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.begin(request);
      assert.strictEqual(
        (yield* Effect.flip(store.accept(request.deliveryKey, { ...receipt, sessionId: "side" })))
          .kind,
        "conflict",
      );
      yield* store.accept(request.deliveryKey, receipt);
      assert.strictEqual(
        (yield* Effect.flip(
          store.accept(request.deliveryKey, { ...receipt, messageId: "replacement" }),
        )).kind,
        "conflict",
      );
    }),
  ),
);

it.effect("refuses changed attachment content under an existing delivery identity", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const attached = { ...request, attachmentIdentity: "first-content-hash" };
      yield* store.begin(attached);
      yield* store.accept(request.deliveryKey, receipt);
      assert.deepStrictEqual(yield* store.begin(attached), receipt);
      assert.strictEqual(
        (yield* Effect.flip(
          store.begin({ ...attached, attachmentIdentity: "replacement-content-hash" }),
        )).kind,
        "conflict",
      );
    }),
  ),
);

it.effect("abandons only unaccepted pre-prompt intents and preserves every admitted receipt", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.begin(request);
      yield* store.abandonBeforePrompt(request.deliveryKey);
      yield* store.abandonBeforePrompt(request.deliveryKey);
      assert.strictEqual(yield* store.begin(request), null);
      yield* store.accept(request.deliveryKey, receipt);
      yield* store.abandonBeforePrompt(request.deliveryKey);
      assert.deepStrictEqual(yield* store.begin(request), receipt);
      yield* store.settle(request.deliveryKey);
      yield* store.abandonBeforePrompt(request.deliveryKey);
      assert.deepStrictEqual(yield* store.begin(request), receipt);
      assert.strictEqual(yield* store.begin({ ...request, deliveryKey: "next" }), null);
    }),
  ),
);
