import {
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
  nativeAgentSourceForDriver,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
    readonly advanceNativePosition?: boolean;
    readonly nativeSequence?: number;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly reconcile: (
    threadId: ThreadId,
    itemIds: ReadonlyArray<TurnItemId>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly turnItemId: TurnItemId; readonly ordinal: number }>,
    TurnItemPositionStoreError
  >;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    runOrdinal?: number,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("t3/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const allocate: TurnItemPositionStoreV2Shape["allocate"] = ({
      threadId,
      turnItemId,
      runId,
      runOrdinal: suppliedRunOrdinal,
      advanceNativePosition = false,
      nativeSequence,
    }) =>
      Effect.gen(function* () {
        const runRows =
          runId === null
            ? []
            : yield* sql<{ readonly ordinal: number }>`
                SELECT ordinal
                FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND run_id = ${runId}
                LIMIT 1
              `;
        const runOrdinal = suppliedRunOrdinal ?? runRows[0]?.ordinal ?? null;
        const lowerBound = runOrdinal === null ? 0 : runOrdinal * 1_000_000;
        const upperBound = runOrdinal === null ? 999_999 : lowerBound + 999_999;
        const existing = yield* sql<{
          readonly ordinal: number;
          readonly native_sequence: number | null;
        }>`
          SELECT ordinal, native_sequence FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
        `;
        const saved = existing[0];
        if (
          saved &&
          (saved.ordinal > upperBound ||
            (saved.ordinal < lowerBound && !advanceNativePosition) ||
            (saved.ordinal >= lowerBound && saved.native_sequence === (nativeSequence ?? null)))
        ) {
          return saved.ordinal;
        }
        if (
          nativeSequence === undefined &&
          (saved === undefined || saved.native_sequence === null)
        ) {
          const maximum = yield* sql<{
            readonly ordinal: number | null;
          }>`SELECT MAX(ordinal) AS ordinal
            FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${threadId} AND ordinal BETWEEN ${lowerBound} AND ${upperBound}`;
          const ordinal = (maximum[0]?.ordinal ?? lowerBound) + 1;
          if (ordinal > upperBound)
            return yield* new TurnItemPositionStoreError({
              threadId,
              turnItemId,
              cause: "Turn item position block is full.",
            });
          yield* sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES (${threadId}, ${turnItemId}, ${ordinal})
            ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = excluded.ordinal`;
          return ordinal;
        }
        const block = yield* sql<{
          readonly turn_item_id: TurnItemId;
          readonly ordinal: number;
          readonly native_sequence: number | null;
        }>`
          SELECT turn_item_id, ordinal, native_sequence
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND ordinal BETWEEN ${lowerBound} AND ${upperBound}
            AND turn_item_id <> ${turnItemId}
          ORDER BY ordinal
        `;
        const fixed = block.filter((row) => row.native_sequence === null);
        const natives = block.flatMap((row) =>
          row.native_sequence === null
            ? []
            : [
                {
                  turnItemId: row.turn_item_id,
                  sequence: row.native_sequence,
                },
              ],
        );
        const assigned = [];
        if (nativeSequence === undefined) {
          const ordinal =
            saved && saved.ordinal >= lowerBound
              ? saved.ordinal
              : block.reduce((max, row) => Math.max(max, row.ordinal), lowerBound) + 1;
          fixed.push({ turn_item_id: turnItemId, ordinal, native_sequence: null });
          assigned.push({ turnItemId, ordinal, nativeSequence: null });
        } else {
          natives.push({ turnItemId, sequence: nativeSequence });
        }
        fixed.sort((a, b) => a.ordinal - b.ordinal);
        natives.sort((a, b) => a.sequence - b.sequence || a.turnItemId.localeCompare(b.turnItemId));
        // Native sequence s uses the s-th slot excluding managed positions. Pages
        // can arrive backwards; managed rows stay fixed, including between pages.
        let fixedIndex = 0;
        let previous = lowerBound;
        for (const native of natives) {
          let ordinal = Math.max(previous + 1, lowerBound + native.sequence + 1 + fixedIndex);
          while (fixedIndex < fixed.length) {
            const obstacle = fixed[fixedIndex];
            if (obstacle === undefined || obstacle.ordinal > ordinal) break;
            fixedIndex++;
            ordinal++;
          }
          assigned.push({
            turnItemId: native.turnItemId,
            ordinal,
            nativeSequence: native.sequence,
          });
          previous = ordinal;
        }
        if (assigned.some((row) => row.ordinal > upperBound)) {
          return yield* new TurnItemPositionStoreError({
            threadId,
            turnItemId,
            cause: "Turn item position block is full.",
          });
        }
        const previousPositions = new Map(block.map((row) => [row.turn_item_id, row]));
        const changed = assigned.filter((row) => {
          const previous = previousPositions.get(row.turnItemId);
          return (
            previous?.ordinal !== row.ordinal || previous.native_sequence !== row.nativeSequence
          );
        });
        // Sequence corrections can swap rows; delete the changed set first so
        // SQLite never observes a transient duplicate ordinal.
        if (changed.length > 0) {
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${threadId} AND ${sql.in(
              "turn_item_id",
              changed.map((row) => row.turnItemId),
            )}`;
          yield* sql`INSERT INTO orchestration_v2_turn_item_positions ${sql.insert(
            changed.map((row) => ({
              thread_id: threadId,
              turn_item_id: row.turnItemId,
              ordinal: row.ordinal,
              native_sequence: row.nativeSequence,
            })),
          )}`;
        }
        const rows = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
        const ordinal = rows[0]?.ordinal;
        if (ordinal === undefined) {
          return yield* new TurnItemPositionStoreError({
            threadId,
            turnItemId,
            cause: "Position allocation returned no row.",
          });
        }
        return ordinal;
      }).pipe(
        sql.withTransaction,
        Effect.mapError((cause) =>
          isTurnItemPositionStoreError(cause)
            ? cause
            : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
        ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      reconcile: (threadId, itemIds) =>
        sql<{ readonly turnItemId: TurnItemId; readonly ordinal: number }>`
        SELECT p.turn_item_id AS turnItemId, p.ordinal
        FROM orchestration_v2_turn_item_positions p
        LEFT JOIN orchestration_v2_projection_turn_items item
          ON item.thread_id = p.thread_id AND item.turn_item_id = p.turn_item_id
        WHERE p.thread_id = ${threadId}
          AND (item.ordinal <> p.ordinal OR ${sql.in("p.turn_item_id", itemIds)})
      `.pipe(
          Effect.mapError(
            (cause) =>
              new TurnItemPositionStoreError({
                threadId,
                turnItemId: itemIds[0] ?? TurnItemId.make("position-reconciliation"),
                cause,
              }),
          ),
        ),
      normalize: (item, runOrdinal) =>
        Effect.gen(function* () {
          const nativeMessage =
            item.nativeItemRef?.driver !== undefined &&
            nativeAgentSourceForDriver(item.nativeItemRef.driver) !== undefined &&
            (item.type === "user_message" || item.type === "assistant_message");
          const callParents =
            item.runId === null && item.type === "assistant_message" && item.nodeId !== null
              ? yield* sql<{ readonly kind: string }>`
                  SELECT kind FROM orchestration_v2_projection_nodes
                  WHERE thread_id = ${item.threadId} AND node_id = ${item.nodeId}
                    AND kind = 'call_parent'
                  LIMIT 1
                `
              : [];
          const runlessChatMessage =
            (nativeMessage && item.runId === null) || callParents.length > 0;
          // Native phone/Teach and call-posted messages have no T3 run. Put them
          // after the preceding managed run, including when replaying old positions.
          const precedingRuns =
            runlessChatMessage && item.startedAt !== null
              ? yield* sql<{ readonly ordinal: number }>`
                  SELECT ordinal FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${item.threadId}
                    AND requested_at <= ${DateTime.formatIso(item.startedAt)}
                  ORDER BY ordinal DESC LIMIT 1
                `
              : [];
          const nativeRunOrdinal = runOrdinal ?? precedingRuns[0]?.ordinal;
          const nativeSequence =
            item.runId === null &&
            item.nativeItemRef?.driver === "muse-agent" &&
            nativeMessage &&
            item.canonicalNativeSequence !== undefined &&
            Number.isSafeInteger(item.canonicalNativeSequence) &&
            item.canonicalNativeSequence >= 0 &&
            item.canonicalNativeSequence < 999_999
              ? item.canonicalNativeSequence
              : undefined;
          const ordinal = yield* allocate({
            threadId: item.threadId,
            turnItemId: item.id,
            runId: item.runId,
            ...(nativeRunOrdinal === undefined ? {} : { runOrdinal: nativeRunOrdinal }),
            ...(nativeSequence === undefined ? {} : { nativeSequence }),
            ...(runlessChatMessage || (nativeMessage && item.nativeItemRef?.strength === "strong")
              ? { advanceNativePosition: true }
              : {}),
          });
          return item.ordinal === ordinal ? item : { ...item, ordinal };
        }).pipe(
          Effect.mapError((cause) =>
            isTurnItemPositionStoreError(cause)
              ? cause
              : new TurnItemPositionStoreError({
                  threadId: item.threadId,
                  turnItemId: item.id,
                  cause,
                }),
          ),
        ),
    });
  }),
);
