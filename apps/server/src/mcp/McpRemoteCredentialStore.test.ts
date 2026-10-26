import {
  EnvironmentId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "../persistence/Migrations/068_GrokBotManagedRuntime.ts";
import subagentMigration from "../persistence/Migrations/075_McpRemoteCredentialSubagent.ts";
import * as Store from "./McpRemoteCredentialStore.ts";

const database = Layer.effectDiscard(Effect.andThen(migration, subagentMigration)).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const layer = Store.layer.pipe(Layer.provideMerge(database));
const record = (hash = "a".repeat(64)): Store.RemoteCredentialRecord => ({
  tokenHash: hash,
  lastAliveAt: 100,
  scope: {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "remote-run:stable",
    capabilities: new Set(["orchestration", "worktree"]),
    issuedAt: 90,
    client: undefined,
    thread: {
      threadId: ThreadId.make("thread"),
      providerSessionId: "provider-session",
      providerInstanceId: ProviderInstanceId.make("grok-bot"),
      remoteRun: { runId: RunId.make("run"), attemptId: RunAttemptId.make("attempt") },
    },
  },
});

describe("McpRemoteCredentialStore", () => {
  it.effect(
    "restores exact authority through a new service instance, with hash-only SQL storage",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.McpRemoteCredentialStore;
        const sql = yield* SqlClient.SqlClient;
        const expected = record();
        yield* store.save(expected);
        const restored = yield* Effect.gen(function* () {
          const reopened = yield* Store.McpRemoteCredentialStore;
          return yield* reopened.lookup(expected.tokenHash);
        }).pipe(Effect.provide(Store.layer));
        assert.deepStrictEqual(restored, expected);
        const columns = yield* sql`PRAGMA table_info(mcp_remote_credentials)`;
        assert.isFalse(
          columns.some((column) => /token$|bearer|authorization|prompt/.test(String(column.name))),
        );
        const rows = yield* sql`SELECT token_hash FROM mcp_remote_credentials`;
        assert.deepStrictEqual(rows, [{ token_hash: expected.tokenHash }]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses raw bearer material and unbound local sessions before writing", () =>
    Effect.gen(function* () {
      const store = yield* Store.McpRemoteCredentialStore;
      const expected = record();
      const invalid = yield* Effect.flip(
        store.save({ ...expected, tokenHash: "Bearer raw-secret-sentinel" }),
      );
      assert.notInclude(invalid.message, "raw-secret-sentinel");
      yield* Effect.flip(
        store.save({
          ...expected,
          scope: {
            ...expected.scope,
            thread: {
              threadId: expected.scope.thread.threadId,
              providerSessionId: expected.scope.thread.providerSessionId,
              providerInstanceId: expected.scope.thread.providerInstanceId,
            },
          },
        }),
      );
      yield* Effect.flip(
        store.save({
          ...expected,
          scope: {
            ...expected.scope,
            client: { sessionId: "external-oauth-client", label: "external", access: "read-only" },
          },
        }),
      );
      assert.isUndefined(yield* store.lookup(expected.tokenHash));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("touches monotonically, prunes only stale remote records, and revokes by owner", () =>
    Effect.gen(function* () {
      const store = yield* Store.McpRemoteCredentialStore;
      const first = record();
      const second = {
        ...record("b".repeat(64)),
        scope: {
          ...first.scope,
          thread: { ...first.scope.thread, providerSessionId: "another-session" },
        },
      };
      yield* store.save(first);
      yield* store.save(second);
      yield* store.touch(first.tokenHash, 200);
      yield* store.touch(first.tokenHash, 110);
      yield* store.pruneDead(150);
      assert.equal((yield* store.lookup(first.tokenHash))?.lastAliveAt, 200);
      assert.isUndefined(yield* store.lookup(second.tokenHash));
      yield* store.save(second);
      yield* store.touchThread(first.scope.thread.threadId, 300);
      yield* store.revokeSession("provider-session");
      assert.isUndefined(yield* store.lookup(first.tokenHash));
      assert.equal((yield* store.lookup(second.tokenHash))?.lastAliveAt, 300);
      yield* store.revokeThread(first.scope.thread.threadId);
      assert.isUndefined(yield* store.lookup(second.tokenHash));
    }).pipe(Effect.provide(layer)),
  );
});
