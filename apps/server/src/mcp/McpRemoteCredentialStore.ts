import {
  EnvironmentId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

export interface RemoteCredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpThreadInvocationScope;
  readonly lastAliveAt: number;
}

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Capabilities = Schema.Array(
  Schema.Literals(["preview", "orchestration", "worktree", "device", "pull-requests"]),
);
const Row = Schema.Struct({
  tokenHash: Hash,
  environmentId: EnvironmentId,
  requestNamespace: Schema.String,
  threadId: ThreadId,
  providerSessionId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  runId: RunId,
  attemptId: RunAttemptId,
  capabilities: Schema.fromJsonString(Capabilities),
  issuedAt: Schema.Int,
  lastAliveAt: Schema.Int,
});
type StoreError = PersistenceSqlError | PersistenceDecodeError;
const isDecodeError = Schema.is(PersistenceDecodeError);
const decodeClient = Schema.decodeUnknownEffect(Schema.Undefined);

/** Only attempt-bound cloud credentials survive process shutdown. The bearer never enters this port. */
export class McpRemoteCredentialStore extends Context.Service<
  McpRemoteCredentialStore,
  {
    readonly save: (record: RemoteCredentialRecord) => Effect.Effect<void, StoreError>;
    readonly lookup: (
      tokenHash: string,
    ) => Effect.Effect<RemoteCredentialRecord | undefined, StoreError>;
    readonly touch: (tokenHash: string, timestamp: number) => Effect.Effect<void, StoreError>;
    readonly touchThread: (
      threadId: ThreadId,
      timestamp: number,
    ) => Effect.Effect<void, StoreError>;
    readonly revokeSession: (providerSessionId: string) => Effect.Effect<void, StoreError>;
    readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void, StoreError>;
    readonly pruneDead: (lastAliveBefore: number) => Effect.Effect<void, StoreError>;
    readonly revokeAll: Effect.Effect<void, StoreError>;
  }
>()("t3/mcp/McpRemoteCredentialStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = Schema.decodeUnknownEffect(Row);
  const hash = Schema.decodeUnknownEffect(Hash);
  const encodeCapabilities = Schema.encodeEffect(Schema.fromJsonString(Capabilities));
  const queryError = (operation: string) => (cause: unknown) =>
    isDecodeError(cause) ? cause : new PersistenceSqlError({ operation, cause });
  const decodeError = (cause: Schema.SchemaError) =>
    PersistenceDecodeError.fromSchemaError("McpRemoteCredentialStore.decode", cause);
  const lookup = Effect.fn("McpRemoteCredentialStore.lookup")(function* (tokenHash: string) {
    yield* hash(tokenHash).pipe(Effect.mapError(decodeError));
    const rows = yield* sql`
      SELECT token_hash AS "tokenHash", environment_id AS "environmentId",
        request_namespace AS "requestNamespace", thread_id AS "threadId",
        provider_session_id AS "providerSessionId", provider_instance_id AS "providerInstanceId",
        run_id AS "runId", attempt_id AS "attemptId", capabilities_json AS "capabilities",
        issued_at AS "issuedAt", last_alive_at AS "lastAliveAt"
      FROM mcp_remote_credentials WHERE token_hash = ${tokenHash}
    `.pipe(Effect.mapError(queryError("McpRemoteCredentialStore.lookup")));
    if (rows[0] === undefined) return undefined;
    const row = yield* decode(rows[0]).pipe(Effect.mapError(decodeError));
    return {
      tokenHash: row.tokenHash,
      lastAliveAt: row.lastAliveAt,
      scope: {
        environmentId: row.environmentId,
        requestNamespace: row.requestNamespace,
        capabilities: new Set(row.capabilities),
        issuedAt: row.issuedAt,
        client: undefined,
        thread: {
          threadId: row.threadId,
          providerSessionId: row.providerSessionId,
          providerInstanceId: row.providerInstanceId,
          remoteRun: { runId: row.runId, attemptId: row.attemptId },
        },
      },
    } satisfies RemoteCredentialRecord;
  });
  return McpRemoteCredentialStore.of({
    lookup,
    save: Effect.fn("McpRemoteCredentialStore.save")(function* (record) {
      yield* decodeClient(record.scope.client).pipe(Effect.mapError(decodeError));
      const remote = record.scope.thread.remoteRun;
      const capabilities = yield* encodeCapabilities([...record.scope.capabilities]).pipe(
        Effect.mapError(decodeError),
      );
      // A local scope must not become a durable cloud credential by accident.
      const row = yield* decode({
        tokenHash: record.tokenHash,
        environmentId: record.scope.environmentId,
        requestNamespace: record.scope.requestNamespace,
        threadId: record.scope.thread.threadId,
        providerSessionId: record.scope.thread.providerSessionId,
        providerInstanceId: record.scope.thread.providerInstanceId,
        runId: remote?.runId,
        attemptId: remote?.attemptId,
        capabilities,
        issuedAt: record.scope.issuedAt,
        lastAliveAt: record.lastAliveAt,
      }).pipe(Effect.mapError(decodeError));
      yield* sql`
        INSERT INTO mcp_remote_credentials(token_hash, environment_id, request_namespace,
          thread_id, provider_session_id, provider_instance_id, run_id, attempt_id,
          capabilities_json, issued_at, last_alive_at)
        VALUES(${row.tokenHash}, ${row.environmentId}, ${row.requestNamespace}, ${row.threadId},
          ${row.providerSessionId}, ${row.providerInstanceId}, ${row.runId}, ${row.attemptId},
          ${capabilities}, ${row.issuedAt}, ${row.lastAliveAt})
        ON CONFLICT(token_hash) DO UPDATE SET last_alive_at = MAX(last_alive_at, excluded.last_alive_at)
      `.pipe(Effect.asVoid, Effect.mapError(queryError("McpRemoteCredentialStore.save")));
    }),
    touch: (tokenHash, timestamp) =>
      hash(tokenHash).pipe(
        Effect.mapError(decodeError),
        Effect.flatMap(
          () =>
            sql`UPDATE mcp_remote_credentials SET last_alive_at = MAX(last_alive_at, ${timestamp}) WHERE token_hash = ${tokenHash}`,
        ),
        Effect.asVoid,
        Effect.mapError(queryError("McpRemoteCredentialStore.touch")),
      ),
    touchThread: (threadId, timestamp) =>
      sql`UPDATE mcp_remote_credentials SET last_alive_at = MAX(last_alive_at, ${timestamp}) WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(queryError("McpRemoteCredentialStore.touchThread")),
      ),
    revokeSession: (id) =>
      sql`DELETE FROM mcp_remote_credentials WHERE provider_session_id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(queryError("McpRemoteCredentialStore.revokeSession")),
      ),
    revokeThread: (id) =>
      sql`DELETE FROM mcp_remote_credentials WHERE thread_id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(queryError("McpRemoteCredentialStore.revokeThread")),
      ),
    pruneDead: (cutoff) =>
      sql`DELETE FROM mcp_remote_credentials WHERE last_alive_at < ${cutoff}`.pipe(
        Effect.asVoid,
        Effect.mapError(queryError("McpRemoteCredentialStore.pruneDead")),
      ),
    revokeAll: sql`DELETE FROM mcp_remote_credentials`.pipe(
      Effect.asVoid,
      Effect.mapError(queryError("McpRemoteCredentialStore.revokeAll")),
    ),
  });
});

export const layer = Layer.effect(McpRemoteCredentialStore, make);
