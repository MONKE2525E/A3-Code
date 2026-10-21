import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import GrokBotManagedRuntime from "./068_GrokBotManagedRuntime.ts";
import GrokBotManagedCompletion from "./069_GrokBotManagedCompletion.ts";
import Compatibility from "./070_GrokBotMigrationCompatibility.ts";

const assertTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepStrictEqual(
    yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'pull_request_review_guides', 'mcp_remote_credentials',
        'grok_bot_managed_bindings', 'grok_bot_managed_turns', 'grok_bot_managed_completions'
      ) ORDER BY name
    `,
    [
      { name: "grok_bot_managed_bindings" },
      { name: "grok_bot_managed_completions" },
      { name: "grok_bot_managed_turns" },
      { name: "mcp_remote_credentials" },
      { name: "pull_request_review_guides" },
    ],
  );
  yield* sql`
    INSERT INTO pull_request_review_guides (host, repository, number, guide_json)
    VALUES ('github.com', 'owner/repo', 1, '{}')
  `;
});

describe("GrokBot migration compatibility", () => {
  it.effect("creates the complete schema on a fresh database and reruns safely", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      yield* assertTables;
      yield* Compatibility;
      assert.deepStrictEqual(yield* sql`SELECT * FROM pull_request_review_guides`, [
        { host: "github.com", repository: "owner/repo", number: 1, guide_json: "{}" },
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades old local history with completion migration %s while preserving records",
    (withCompletion) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* runMigrations({ toMigrationInclusive: 60 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "61_GrokBotManagedRuntime": GrokBotManagedRuntime,
            ...(withCompletion ? { "62_GrokBotManagedCompletion": GrokBotManagedCompletion } : {}),
          }),
        });
        yield* sql`
          INSERT INTO grok_bot_managed_bindings
            (account_binding, bot_id, session_id, thread_id, provider_instance_id, generation, after_updated_seq)
          VALUES ('account', 'bot', 'session', 'thread', 'provider', 2, '42')
        `;
        yield* sql`
          INSERT INTO grok_bot_managed_turns
            (account_binding, bot_id, session_id, message_id, run_id, attempt_id,
             provider_turn_id, identity_json, state, delivery, outcome, settled_at_ms)
          VALUES ('account', 'bot', 'session', 'message', 'run', 'attempt',
                  'turn', '{"original":true}', 'settled', 'accepted', 'success', 100)
        `;
        yield* sql`
          INSERT INTO mcp_remote_credentials
            (token_hash, environment_id, request_namespace, thread_id, provider_session_id,
             provider_instance_id, run_id, attempt_id, capabilities_json, issued_at, last_alive_at)
          VALUES (${"a".repeat(64)}, 'environment', 'namespace', 'thread', 'session',
                  'provider', 'run', 'attempt', '[]', 10, 20)
        `;
        if (withCompletion) {
          yield* sql`
            INSERT INTO grok_bot_managed_completions
              (provider_turn_id, source, final_text, declared_at_ms)
            VALUES ('turn', 'agent_declaration', 'Preserved answer', 90)
          `;
        }
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const bindings = yield* sql`SELECT * FROM grok_bot_managed_bindings`;
        const turns = yield* sql`SELECT * FROM grok_bot_managed_turns`;
        const credentials = yield* sql`SELECT * FROM mcp_remote_credentials`;
        const completions = withCompletion
          ? yield* sql`SELECT * FROM grok_bot_managed_completions`
          : [];

        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id > 60),
        );
        yield* assertTables;
        yield* Compatibility;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(
          (yield* sql<{
            readonly migration_id: number;
            readonly name: string;
          }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`).map(
            (row) => [row.migration_id, row.name] as const,
          ),
          migrationManifest,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM grok_bot_managed_bindings`, bindings);
        assert.deepStrictEqual(yield* sql`SELECT * FROM grok_bot_managed_turns`, turns);
        assert.deepStrictEqual(yield* sql`SELECT * FROM mcp_remote_credentials`, credentials);
        assert.deepStrictEqual(yield* sql`SELECT * FROM grok_bot_managed_completions`, completions);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
