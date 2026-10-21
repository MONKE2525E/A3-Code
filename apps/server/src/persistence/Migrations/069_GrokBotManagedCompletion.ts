import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // These declarations finish T3's managed turn. They do not record native workflow outcomes.
  yield* sql`
    CREATE TABLE IF NOT EXISTS grok_bot_managed_completions (
      provider_turn_id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL CHECK(source = 'agent_declaration'),
      final_text TEXT NOT NULL,
      declared_at_ms INTEGER NOT NULL CHECK(declared_at_ms >= 0)
    )
  `;
});
