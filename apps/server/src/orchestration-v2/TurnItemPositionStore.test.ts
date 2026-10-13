import { assert, it } from "@effect/vitest";
import {
  MessageId,
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
  "prepends paginated Muse history without moving managed rows and replays normalized positions",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const positions = yield* Positions.TurnItemPositionStoreV2;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run:pagination', ${threadId}, 1, 'muse-agent', 'completed', '2026-10-11T06:00:00.000Z', '{}')`;
      const native = (id: string, seq: number, time: string) => ({
        ...item(id, time),
        canonicalNativeSequence: seq,
        nativeItemRef: {
          driver: ProviderDriverKind.make("muse-agent"),
          nativeId: id,
          strength: "strong" as const,
        },
      });
      const recent = yield* positions.normalize(native("recent", 100, "2026-10-11T05:00:00.000Z"));
      const managed = yield* positions.normalize({
        ...native("managed", 101, "2026-10-11T06:00:01.000Z"),
        runId: RunId.make("run:pagination"),
      });
      const foreignAfter = yield* positions.normalize(
        native("foreign-after", 110, "2026-10-11T06:00:02.000Z"),
      );
      const older = yield* positions.normalize(native("older", 0, "2026-10-11T04:00:00.000Z"));
      assert.isBelow(older.ordinal, recent.ordinal);
      assert.isBelow(recent.ordinal, managed.ordinal);
      assert.isBelow(managed.ordinal, foreignAfter.ordinal);
      assert.strictEqual((yield* positions.normalize(older)).ordinal, older.ordinal);
      assert.strictEqual((yield* positions.normalize(recent)).ordinal, recent.ordinal);
      assert.strictEqual((yield* positions.normalize(managed)).ordinal, managed.ordinal);
      assert.strictEqual((yield* positions.normalize(foreignAfter)).ordinal, foreignAfter.ordinal);
      const managedAfterForeign = yield* positions.normalize({
        ...native("managed-after-foreign", 111, "2026-10-11T06:00:03.000Z"),
        runId: RunId.make("run:pagination"),
      });
      assert.isAbove(managedAfterForeign.ordinal, foreignAfter.ordinal);
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
  "places Muse native messages after their preceding managed run and promotes proven owned replies",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const positions = yield* Positions.TurnItemPositionStoreV2;
      const native = {
        ...item("muse:native-answer", "2026-10-11T08:01:00.000Z"),
        nativeItemRef: {
          driver: ProviderDriverKind.make("muse-agent"),
          nativeId: "answer",
          strength: "strong" as const,
        },
        type: "assistant_message" as const,
        streaming: false,
      };
      const beforeRunExists = yield* positions.normalize(native);
      assert.isBelow(beforeRunExists.ordinal, 1_000_000);
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run:muse-six', ${threadId}, 6, 'muse-agent', 'completed', '2026-10-11T08:00:00.000Z', '{}')`;
      const ownUser = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("muse:own-user"),
        runId: RunId.make("run:muse-six"),
      });
      const replayed = yield* positions.normalize(beforeRunExists);
      assert.isAbove(replayed.ordinal, ownUser);
      assert.isBelow(replayed.ordinal, 7_000_000);
      const other = yield* positions.normalize({
        ...native,
        id: TurnItemId.make("muse:early-associated"),
      });
      const owned = yield* positions.normalize({ ...other, runId: RunId.make("run:muse-six") });
      assert.strictEqual(owned.id, other.id);
      assert.strictEqual((yield* positions.normalize(owned)).ordinal, owned.ordinal);

      const early = item("muse:promoted-reply", "2026-10-11T07:00:00.000Z");
      const old = yield* positions.normalize({ ...early, nativeItemRef: native.nativeItemRef });
      assert.isBelow(old.ordinal, 1_000_000);
      const promoted = yield* positions.normalize({ ...old, runId: RunId.make("run:muse-six") });
      assert.isAbove(promoted.ordinal, ownUser);
      assert.strictEqual(promoted.id, old.id);
      assert.strictEqual((yield* positions.normalize(promoted)).ordinal, promoted.ordinal);
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
