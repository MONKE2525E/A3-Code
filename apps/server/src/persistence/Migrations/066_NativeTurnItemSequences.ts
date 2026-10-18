import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_turn_item_positions ADD COLUMN native_sequence INTEGER`;
  yield* sql`UPDATE orchestration_v2_turn_item_positions SET native_sequence = (
    SELECT json_extract(item.payload_json, '$.canonicalNativeSequence')
    FROM orchestration_v2_projection_turn_items item
    WHERE item.thread_id = orchestration_v2_turn_item_positions.thread_id
      AND item.turn_item_id = orchestration_v2_turn_item_positions.turn_item_id
      AND item.run_id IS NULL
      AND json_extract(item.payload_json, '$.nativeItemRef.driver') = 'muse-agent'
  )`;
});
