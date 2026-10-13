import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Completion and attention routing needs only the latest sender, even in long chats.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_sender_idx
    ON orchestration_v2_projection_messages(thread_id, created_at DESC, message_id DESC)
    WHERE role = 'user' AND json_extract(payload_json, '$.senderThreadId') IS NOT NULL`;
});
