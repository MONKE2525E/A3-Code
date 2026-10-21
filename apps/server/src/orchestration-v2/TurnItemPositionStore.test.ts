import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Positions from "./TurnItemPositionStore.ts";

const layer = Positions.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const threadId = ThreadId.make("thread:native-position");
const item = (id: string, timestamp: string) =>
  ({
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: {
      driver: ProviderDriverKind.make("grok-bot"),
      nativeId: id,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: DateTime.makeUnsafe(timestamp),
    completedAt: DateTime.makeUnsafe(timestamp),
    updatedAt: DateTime.makeUnsafe(timestamp),
    type: "user_message",
    messageId: MessageId.make(id),
    createdBy: "user",
    creationSource: "provider",
    inputIntent: "turn_start",
    text: "Native Teach handoff",
    attachments: [],
  }) satisfies OrchestrationV2TurnItem;

it.effect(
  "positions call-posted chat after preceding runs and repairs an old history position",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const positions = yield* Positions.TurnItemPositionStoreV2;
      const nodeId = NodeId.make("call-parent:position-test");
      yield* sql`INSERT INTO orchestration_v2_projection_nodes
      (node_id, thread_id, root_node_id, kind, status, payload_json)
      VALUES (${nodeId}, ${threadId}, ${nodeId}, 'call_parent', 'running', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run:recent', ${threadId}, 11, 'grok-bot', 'completed', '2026-10-11T06:00:00.000Z', '{}')`;
      const callMessage = {
        ...item("call:written-message", "2026-10-11T06:30:00.000Z"),
        type: "assistant_message" as const,
        nodeId,
        nativeItemRef: null,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        streaming: false,
      };
      const old = yield* positions.allocate({ threadId, turnItemId: callMessage.id, runId: null });
      const managed = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("managed:latest"),
        runId: RunId.make("run:recent"),
      });
      const repaired = yield* positions.normalize(callMessage);
      assert.isBelow(old, 1_000_000);
      assert.isAbove(repaired.ordinal, managed);
      assert.strictEqual((yield* positions.normalize(repaired)).ordinal, repaired.ordinal);
      const unrelated = yield* positions.normalize({
        ...callMessage,
        id: TurnItemId.make("ordinary:assistant"),
        nodeId: null,
      });
      assert.isBelow(unrelated.ordinal, 1_000_000);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps native history before the first run but positions new Teach handoffs after the preceding managed run",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const positions = yield* Positions.TurnItemPositionStoreV2;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run:one', ${threadId}, 1, 'grok-bot', 'completed', '2026-10-11T06:00:00.000Z', '{}'),
             ('run:two', ${threadId}, 2, 'grok-bot', 'completed', '2026-10-11T07:00:00.000Z', '{}')`;
      const before = yield* positions.normalize(item("native:history", "2026-10-11T05:00:00.000Z"));
      const managed = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("managed:one"),
        runId: RunId.make("run:one"),
      });
      const teach = yield* positions.normalize(item("native:teach", "2026-10-11T06:30:00.000Z"));
      const reply = yield* positions.normalize({
        ...item("native:reply", "2026-10-11T06:30:05.000Z"),
        type: "assistant_message",
        streaming: false,
      });
      assert.isBelow(before.ordinal, managed);
      assert.isAbove(teach.ordinal, managed);
      assert.isAbove(reply.ordinal, teach.ordinal);
      assert.isBelow(reply.ordinal, 2_000_000);
      assert.strictEqual((yield* positions.normalize(teach)).ordinal, teach.ordinal);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "repairs an already persisted pre-run native position on replay without changing its identity",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const positions = yield* Positions.TurnItemPositionStoreV2;
      const native = item("native:previously-hidden", "2026-10-11T06:32:00.000Z");
      const old = yield* positions.allocate({ threadId, turnItemId: native.id, runId: null });
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run:twentytwo', ${threadId}, 22, 'grok-bot', 'completed', '2026-10-11T06:31:00.000Z', '{}')`;
      const repaired = yield* positions.normalize(native);
      assert.isBelow(old, 1_000_000);
      assert.isAbove(repaired.ordinal, 22_000_000);
      assert.strictEqual(repaired.id, native.id);
      assert.strictEqual((yield* positions.normalize(repaired)).ordinal, repaired.ordinal);
      const ordinary = yield* positions.normalize({
        ...item("ordinary:runless", "2026-10-11T06:33:00.000Z"),
        nativeItemRef: null,
      });
      assert.isBelow(ordinary.ordinal, 1_000_000);
    }).pipe(Effect.provide(layer)),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);
