import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
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
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
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
        yield* sql`
          INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
          SELECT
            ${threadId},
            ${turnItemId},
            COALESCE(MAX(ordinal), ${lowerBound}) + 1
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId}
            AND ordinal >= ${lowerBound}
            AND ordinal <= ${upperBound}
          ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = excluded.ordinal
          WHERE ${advanceNativePosition ? 1 : 0} = 1
            AND orchestration_v2_turn_item_positions.ordinal < ${lowerBound}
        `;
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
        Effect.mapError((cause) =>
          isTurnItemPositionStoreError(cause)
            ? cause
            : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
        ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      normalize: (item, runOrdinal) =>
        Effect.gen(function* () {
          const nativeGrokMessage =
            item.runId === null &&
            item.nativeItemRef?.driver === "grok-bot" &&
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
          const runlessChatMessage = nativeGrokMessage || callParents.length > 0;
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
          const ordinal = yield* allocate({
            threadId: item.threadId,
            turnItemId: item.id,
            runId: item.runId,
            ...(nativeRunOrdinal === undefined ? {} : { runOrdinal: nativeRunOrdinal }),
            ...(runlessChatMessage ? { advanceNativePosition: true } : {}),
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
