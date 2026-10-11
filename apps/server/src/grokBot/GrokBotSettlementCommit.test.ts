import { assert, it } from "@effect/vitest";
import { EventId, NodeId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { makeTurn } from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import {
  grokBotCompletionMessage,
  grokBotCompletionTurnItem,
  grokBotTurnIdentity,
} from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";
import * as Store from "./GrokBotManagedStateStore.ts";

const layer = Layer.mergeAll(RuntimeLayer.layerEventSink, Store.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect(
  "retains a declared answer in the normal timeline when terminal ingestion wins the race",
  () =>
    Effect.gen(function* () {
      const managed = yield* makeTurn;
      const identity = grokBotTurnIdentity(managed);
      const store = yield* Store.GrokBotManagedStateStore;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const at = DateTime.makeUnsafe(2000);
      yield* sink.write({
        events: [
          {
            id: EventId.make("fixture:thread"),
            type: "thread.created",
            threadId: identity.native.threadId,
            occurredAt: at,
            payload: managed.input.appThread,
          },
        ],
      });
      yield* store.acquire(identity.native);
      yield* store.prepareTurn(identity);
      const declaration = yield* store.declareCompletion({
        identity,
        finalText: "**Verified** final answer",
        declaredAtMs: 1900,
      });
      const message = grokBotCompletionMessage(declaration).message;
      // An older observer committed the answer without its timeline item.
      yield* sink.write({
        events: [
          {
            id: EventId.make("fixture:answer-message"),
            type: "message.updated",
            threadId: identity.native.threadId,
            runId: identity.runId,
            nodeId: identity.rootNodeId,
            occurredAt: message.updatedAt,
            payload: message,
          },
        ],
      });
      const terminal: OrchestrationV2DomainEvent = {
        id: EventId.make("fixture:provider-terminal"),
        type: "provider-turn.updated",
        threadId: identity.native.threadId,
        runId: identity.runId,
        occurredAt: at,
        payload: {
          id: identity.providerTurnId,
          providerThreadId: identity.providerThreadId,
          nodeId: identity.rootNodeId,
          runAttemptId: identity.attemptId,
          nativeTurnRef: null,
          ordinal: identity.providerTurnOrdinal,
          status: "completed",
          startedAt: at,
          completedAt: at,
        },
      };
      yield* sink.write({ events: [terminal] });
      const records = yield* projections.getThreadRecords(identity.native.threadId, [
        "messages",
        "turnItems",
      ]);
      assert.equal(records.messages.length, 1);
      assert.equal(records.turnItems.length, 1);
      const item = records.turnItems[0];
      assert.equal(item?.id, grokBotCompletionTurnItem(declaration).turnItem.id);
      assert.equal(item?.type, "assistant_message");
      if (item?.type !== "assistant_message") return yield* Effect.die("missing final answer item");
      assert.equal(item.text, declaration.finalText);
      assert.equal(item.messageId, message.id);
      assert.equal(item.runId, identity.runId);
      assert.equal(item.providerTurnId, identity.providerTurnId);
      yield* sink.write({
        events: [{ ...terminal, id: EventId.make("fixture:provider-terminal-replay") }],
      });
      const replay = yield* projections.getThreadRecords(identity.native.threadId, [
        "messages",
        "turnItems",
      ]);
      assert.equal(replay.messages.length, 1);
      assert.equal(replay.turnItems.length, 1);
      assert.equal(replay.turnItems[0]?.ordinal, item.ordinal);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "commits native settlement with the V2 projection and rolls both back on ownership conflict",
  () =>
    Effect.gen(function* () {
      const managed = yield* makeTurn;
      const turn = grokBotTurnIdentity(managed);
      const store = yield* Store.GrokBotManagedStateStore;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const at = DateTime.makeUnsafe(2000);
      yield* store.acquire(turn.native);
      yield* store.prepareTurn(turn);
      const event: OrchestrationV2DomainEvent = {
        id: EventId.make("native:settlement"),
        threadId: turn.native.threadId,
        occurredAt: at,
        type: "provider-turn.updated",
        payload: {
          id: turn.providerTurnId,
          providerThreadId: turn.providerThreadId,
          nodeId: turn.rootNodeId,
          runAttemptId: turn.attemptId,
          nativeTurnRef: null,
          ordinal: turn.providerTurnOrdinal,
          status: "completed",
          startedAt: null,
          completedAt: at,
        },
      };
      yield* sink.write({ events: [event] });
      // A crash here must retain the nonce so reconnection can replay the root terminal.
      assert.equal((yield* store.lookupTurn(turn))?.state, "prepared");
      assert.equal((yield* store.restoreTurns(turn.native)).length, 1);
      const runEvent: OrchestrationV2DomainEvent = {
        id: EventId.make("native:root-settlement"),
        threadId: turn.native.threadId,
        occurredAt: at,
        type: "run.updated",
        payload: {
          id: turn.runId,
          threadId: turn.native.threadId,
          ordinal: turn.runOrdinal,
          providerInstanceId: turn.native.providerInstanceId,
          modelSelection: managed.input.modelSelection,
          providerThreadId: turn.providerThreadId,
          userMessageId: managed.input.message.messageId,
          rootNodeId: turn.rootNodeId,
          activeAttemptId: turn.attemptId,
          status: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      };
      yield* Effect.flip(
        sink.write({
          events: [
            {
              ...runEvent,
              payload: { ...runEvent.payload, rootNodeId: NodeId.make("other-root") },
            },
          ],
        }),
      );
      assert.equal((yield* store.lookupTurn(turn))?.state, "prepared");
      const before = yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs`;
      assert.equal(before[0]?.count, 0);
      yield* sink.write({ events: [runEvent] });
      const committed = yield* store.lookupTurn(turn);
      assert.equal(committed?.state, "settled");
      assert.equal(committed?.outcome, "success");
      assert.equal(committed?.settledAtMs, 2000);
      const after = yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs`;
      assert.equal(after[0]?.count, 1);
      assert.deepStrictEqual(yield* store.restoreTurns(turn.native), []);
    }).pipe(Effect.provide(layer)),
);
