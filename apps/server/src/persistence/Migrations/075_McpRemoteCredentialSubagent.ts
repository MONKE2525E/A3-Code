import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE mcp_remote_credentials
    ADD COLUMN subagent INTEGER NOT NULL DEFAULT 0 CHECK (subagent IN (0, 1))
  `;
});
