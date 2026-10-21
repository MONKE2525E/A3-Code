import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "../persistence/Migrations/068_GrokBotManagedRuntime.ts";
import completionMigration from "../persistence/Migrations/069_GrokBotManagedCompletion.ts";
import type { GrokBotTurnIdentity } from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";
import * as Store from "./GrokBotManagedStateStore.ts";

const database = Layer.effectDiscard(migration.pipe(Effect.andThen(completionMigration))).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const layer = Store.layer.pipe(Layer.provideMerge(database));
const turn: GrokBotTurnIdentity = {
  native: {
    binding: "a".repeat(64),
    botId: "owned-bot",
    sessionId: "",
    generation: 0,
    afterUpdatedSeq: "0",
    threadId: ThreadId.make("thread"),
    providerInstanceId: ProviderInstanceId.make("grok-bot"),
  },
  messageId: "durable-nonce",
  sentAtMs: 100,
  runId: RunId.make("run"),
  attemptId: RunAttemptId.make("attempt"),
  rootNodeId: NodeId.make("root"),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  providerTurnId: ProviderTurnId.make("provider-turn"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
};

describe("GrokBotManagedStateStore", () => {
  it.effect(
    "replays an immutable completion declaration after reconstruction without claiming native success",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.GrokBotManagedStateStore;
        yield* store.acquire(turn.native);
        yield* store.prepareTurn(turn);
        const original = yield* store.declareCompletion({
          identity: turn,
          finalText: "Final answer",
          declaredAtMs: 200,
        });
        const duplicate = yield* store.declareCompletion({
          identity: turn,
          finalText: "Final answer",
          declaredAtMs: 999,
        });
        assert.deepStrictEqual(duplicate, original);
        assert.equal(original.source, "agent_declaration");
        assert.deepStrictEqual(yield* store.lookupCompletion(turn), original);
        assert.equal(
          (yield* store
            .lookupCompletion({ ...turn, attemptId: RunAttemptId.make("foreign") })
            .pipe(Effect.flip))._tag,
          "GrokBotManagedStateConflict",
        );
        const held = yield* store.lookupTurn(turn);
        assert.equal(held?.state, "prepared");
        assert.equal(held?.outcome, null);
        const replay = yield* Effect.gen(function* () {
          const reopened = yield* Store.GrokBotManagedStateStore;
          const events = yield* reopened.openCompletionWatch(turn.native);
          return yield* events.pipe(Stream.take(1), Stream.runCollect);
        }).pipe(Effect.provide(Store.layer));
        assert.deepStrictEqual(replay, [original]);
        const conflict = yield* store
          .declareCompletion({ identity: turn, finalText: "Changed answer", declaredAtMs: 300 })
          .pipe(Effect.flip);
        assert.instanceOf(conflict, Store.ManagedStateConflict);
        assert.equal(conflict.stage, "completion");
        yield* store.commitSettlement({ identity: turn, outcome: "success", settledAtMs: 400 });
        assert.deepStrictEqual(yield* store.lookupCompletion(turn), original);
        yield* store
          .declareCompletion({ identity: turn, finalText: "Final answer", declaredAtMs: 500 })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "delivers new declarations to an already-open watcher and rolls back rejected declarations",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.GrokBotManagedStateStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.acquire(turn.native);
        yield* store.prepareTurn(turn);
        const watcher = yield* store.openCompletionWatch(turn.native);
        yield* store
          .declareCompletion({
            identity: { ...turn, attemptId: RunAttemptId.make("foreign") },
            finalText: "Foreign answer",
            declaredAtMs: 200,
          })
          .pipe(Effect.flip);
        assert.equal((yield* sql`SELECT * FROM grok_bot_managed_completions`).length, 0);
        const declaration = yield* store.declareCompletion({
          identity: turn,
          finalText: "Live answer",
          declaredAtMs: 200,
        });
        assert.deepStrictEqual(yield* watcher.pipe(Stream.take(1), Stream.runCollect), [
          declaration,
        ]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "owns the exact native session exclusively and begins with an uncommitted zero cursor",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.GrokBotManagedStateStore;
        const binding = yield* store.acquire({
          ...turn.native,
          generation: 7,
          afterUpdatedSeq: "42",
        });
        assert.equal(binding.generation, 0);
        assert.equal(binding.afterUpdatedSeq, "0");
        const conflict = yield* Effect.flip(
          store.acquire({ ...turn.native, threadId: ThreadId.make("other-thread") }),
        );
        assert.instanceOf(conflict, Store.ManagedStateConflict);
        assert.deepStrictEqual(yield* store.get(turn.native), turn.native);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "reuses durable delivery identity after uncertain acceptance and service reconstruction",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.GrokBotManagedStateStore;
        yield* store.acquire(turn.native);
        yield* store.prepareTurn(turn);
        yield* store.uncertain(turn);
        const replay = yield* Effect.gen(function* () {
          const reopened = yield* Store.GrokBotManagedStateStore;
          return yield* reopened.prepareTurn({
            ...turn,
            messageId: "new-nonce-must-not-send",
            sentAtMs: 999,
          });
        }).pipe(Effect.provide(Store.layer));
        assert.deepStrictEqual(replay, turn);
        assert.deepStrictEqual(yield* store.restoreTurns(turn.native), [turn]);
        assert.equal(
          (yield* store.lookupTurn({ runId: turn.runId, attemptId: turn.attemptId }))?.state,
          "uncertain",
        );
        yield* store.accepted({
          identity: turn,
          delivery: "duplicate",
          workflowId: "workflow",
          echoEntryId: "echo",
        });
        yield* store.uncertain(turn);
        const receipt = yield* store.lookupTurn(turn);
        assert.equal(receipt?.state, "accepted");
        assert.equal(receipt?.delivery, "duplicate");
        assert.equal(receipt?.echoEntryId, "echo");
        const conflict = yield* Effect.flip(
          store.accepted({ identity: turn, delivery: "accepted", echoEntryId: "other-echo" }),
        );
        assert.instanceOf(conflict, Store.ManagedStateConflict);
        assert.equal(conflict.stage, "receipt");
        yield* Effect.flip(
          store.accepted({ identity: { ...turn, messageId: "wrong-nonce" }, delivery: "accepted" }),
        );
        yield* Effect.flip(store.prepareTurn({ ...turn, rootNodeId: NodeId.make("wrong-root") }));
      }).pipe(Effect.provide(layer)),
  );

  it.effect("rolls back cursor and terminal state with a failed projection transaction", () =>
    Effect.gen(function* () {
      const store = yield* Store.GrokBotManagedStateStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.acquire(turn.native);
      yield* store.prepareTurn(turn);
      const cursor = { ...turn.native, generation: 1, afterUpdatedSeq: "18446744073709551615" };
      yield* Effect.flip(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* store.commitCursor(cursor);
            yield* store.commitSettlement({ identity: turn, outcome: "success", settledAtMs: 200 });
            return yield* Effect.fail("projection-commit-failed");
          }),
        ),
      );
      assert.deepStrictEqual(yield* store.get(turn.native), turn.native);
      assert.equal((yield* store.lookupTurn(turn))?.state, "prepared");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* store.commitCursor(cursor);
          yield* store.commitSettlement({ identity: turn, outcome: "success", settledAtMs: 200 });
        }),
      );
      assert.deepStrictEqual(yield* store.restoreTurns(turn.native), []);
      assert.deepStrictEqual(yield* store.restoreManagedMessageIds(turn.native), [turn.messageId]);
      assert.equal((yield* store.get(turn.native))?.afterUpdatedSeq, cursor.afterUpdatedSeq);
      yield* Effect.flip(store.commitCursor({ ...cursor, afterUpdatedSeq: "3" }));
      yield* Effect.flip(
        store.commitSettlement({ identity: turn, outcome: "error", settledAtMs: 200 }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("restores settled and unsettled nonces only for their exact owned native session", () =>
    Effect.gen(function* () {
      const store = yield* Store.GrokBotManagedStateStore;
      yield* store.acquire(turn.native);
      yield* store.prepareTurn(turn);
      yield* store.commitSettlement({ identity: turn, outcome: "success", settledAtMs: 200 });
      const other = {
        ...turn,
        native: {
          ...turn.native,
          sessionId: "other-session",
          threadId: ThreadId.make("other-thread"),
        },
        messageId: "other-nonce",
        runId: RunId.make("other-run"),
        attemptId: RunAttemptId.make("other-attempt"),
        providerTurnId: ProviderTurnId.make("other-turn"),
      };
      yield* store.acquire(other.native);
      yield* store.prepareTurn(other);
      assert.deepStrictEqual(yield* store.restoreManagedMessageIds(turn.native), [turn.messageId]);
      assert.deepStrictEqual(yield* store.restoreManagedMessageIds(other.native), [
        other.messageId,
      ]);
      assert.deepStrictEqual(yield* store.restoreTranscriptTurns(turn.native), [turn]);
      assert.deepStrictEqual(yield* store.restoreTurns(turn.native), []);
      assert.deepStrictEqual(yield* store.restoreTranscriptTurns(other.native), [other]);
      assert.deepStrictEqual(yield* store.lookupTranscriptTurn(turn.native, turn.messageId), turn);
      assert.deepStrictEqual(
        yield* store.lookupTranscriptTurn(other.native, other.messageId),
        other,
      );
      assert.equal(yield* store.lookupTranscriptTurn(turn.native, other.messageId), undefined);
      assert.equal(yield* store.lookupTranscriptTurn(turn.native, "missing-nonce"), undefined);
      yield* store
        .lookupTranscriptTurn(
          { ...turn.native, threadId: ThreadId.make("wrong-owner") },
          turn.messageId,
        )
        .pipe(Effect.flip);
      yield* store
        .restoreTranscriptTurns({ ...turn.native, threadId: ThreadId.make("wrong-owner") })
        .pipe(Effect.flip);
      yield* store
        .restoreTranscriptTurns({ ...turn.native, binding: "b".repeat(64) })
        .pipe(Effect.flip);
      yield* store
        .restoreManagedMessageIds({ ...turn.native, threadId: ThreadId.make("wrong-owner") })
        .pipe(Effect.flip);
      yield* store
        .restoreManagedMessageIds({ ...turn.native, binding: "b".repeat(64) })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds a managed delivery prepared after another transcript observer opened", () =>
    Effect.gen(function* () {
      const store = yield* Store.GrokBotManagedStateStore;
      yield* store.acquire(turn.native);
      assert.deepStrictEqual(yield* store.restoreTranscriptTurns(turn.native), []);
      assert.equal(yield* store.lookupTranscriptTurn(turn.native, turn.messageId), undefined);
      yield* store.prepareTurn(turn);
      assert.deepStrictEqual(yield* store.lookupTranscriptTurn(turn.native, turn.messageId), turn);
      yield* store.commitSettlement({ identity: turn, outcome: "success", settledAtMs: 200 });
      assert.deepStrictEqual(yield* store.lookupTranscriptTurn(turn.native, turn.messageId), turn);
    }).pipe(Effect.provide(layer)),
  );
});
