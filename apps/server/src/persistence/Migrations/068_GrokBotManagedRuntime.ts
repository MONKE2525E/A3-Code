import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mcp_remote_credentials (
      token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash) = 64),
      environment_id TEXT NOT NULL,
      request_namespace TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      last_alive_at INTEGER NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_remote_credentials_thread ON mcp_remote_credentials(thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_remote_credentials_session ON mcp_remote_credentials(provider_session_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_remote_credentials_liveness ON mcp_remote_credentials(last_alive_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS grok_bot_managed_bindings (
      account_binding TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 0),
      after_updated_seq TEXT NOT NULL,
      PRIMARY KEY(account_binding, bot_id, session_id),
      UNIQUE(thread_id, provider_instance_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS grok_bot_managed_turns (
      account_binding TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      identity_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared', 'uncertain', 'accepted', 'settled')),
      delivery TEXT CHECK(delivery IN ('accepted', 'duplicate')),
      workflow_id TEXT,
      echo_entry_id TEXT,
      outcome TEXT CHECK(outcome IN ('success', 'error', 'cancelled')),
      settled_at_ms INTEGER,
      PRIMARY KEY(account_binding, bot_id, session_id, message_id),
      UNIQUE(run_id, attempt_id, provider_turn_id),
      FOREIGN KEY(account_binding, bot_id, session_id)
        REFERENCES grok_bot_managed_bindings(account_binding, bot_id, session_id)
        ON DELETE CASCADE
    )
  `;
});
