import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import migration from "../persistence/Migrations/068_GrokBotManagedRuntime.ts";
import subagentMigration from "../persistence/Migrations/075_McpRemoteCredentialSubagent.ts";
import * as Store from "./McpRemoteCredentialStore.ts";
import * as Validator from "./McpRemoteRunValidator.ts";
import * as Registry from "./McpSessionRegistry.ts";

const database = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* migration;
    yield* subagentMigration;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const layer = Store.layer.pipe(Layer.provideMerge(database));
const request: Registry.McpCredentialRequest = {
  threadId: ThreadId.make("owned-cloud-thread"),
  providerInstanceId: ProviderInstanceId.make("grok-bot"),
  remoteRun: { runId: RunId.make("owned-run"), attemptId: RunAttemptId.make("owned-attempt") },
  browserToolsAvailable: false,
};
const token = (credential: Registry.McpIssuedCredential) =>
  credential.config.authorizationHeader.replace(/^Bearer\s+/, "");
const makeRegistry = (now: () => number, validate?: () => boolean) => {
  const make = Registry.__testing.make({ now, livenessWindowMs: 100 }).pipe(
    Effect.provideService(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
      getDescriptor: Effect.die("unused"),
    }),
    Effect.provide(NodeServices.layer),
  );
  return validate === undefined
    ? make
    : make.pipe(
        Effect.provideService(Validator.McpRemoteRunValidator, {
          validate: () => Effect.sync(validate),
        }),
      );
};

describe("durable remote MCP credentials", () => {
  it.effect(
    "rebuilds registry authority from real SQL hashes while local sessions stay ephemeral",
    () =>
      Effect.gen(function* () {
        const first = yield* makeRegistry(
          () => 1000,
          () => true,
        );
        const remote = yield* first.issue(request);
        const local = yield* first.issue({
          threadId: ThreadId.make("local"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        const expected = yield* first.resolve(token(remote));
        const second = yield* makeRegistry(
          () => 1010,
          () => true,
        );
        assert.deepStrictEqual(yield* second.resolve(token(remote)), expected);
        assert.isUndefined(yield* second.resolve(token(local)));
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT token_hash, provider_session_id FROM mcp_remote_credentials`;
        assert.lengthOf(rows, 1);
        assert.match(String(rows[0]?.token_hash), /^[0-9a-f]{64}$/);
        assert.notEqual(rows[0]?.token_hash, token(remote));
        assert.equal(rows[0]?.provider_session_id, remote.config.providerSessionId);
        yield* second.revokeThread(request.threadId);
        assert.isUndefined(yield* second.resolve(token(remote)));
        const third = yield* makeRegistry(
          () => 1020,
          () => true,
        );
        assert.isUndefined(yield* third.resolve(token(remote)));
        assert.lengthOf(yield* sql`SELECT token_hash FROM mcp_remote_credentials`, 0);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves delegated-child authority across registry reconstruction", () =>
    Effect.gen(function* () {
      const first = yield* makeRegistry(
        () => 1000,
        () => true,
      );
      const remote = yield* first.issue({ ...request, subagent: true });
      const expected = yield* first.resolve(token(remote));
      assert.isTrue(expected?.thread?.subagent);

      const second = yield* makeRegistry(
        () => 1010,
        () => true,
      );
      assert.deepStrictEqual(yield* second.resolve(token(remote)), expected);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "checks current ownership on every restored and cached request and refuses missing validators",
    () =>
      Effect.gen(function* () {
        let selectedAccountMatches = true;
        const first = yield* makeRegistry(
          () => 1000,
          () => true,
        );
        const remote = yield* first.issue(request);
        const second = yield* makeRegistry(
          () => 1010,
          () => selectedAccountMatches,
        );
        assert.isDefined(yield* second.resolve(token(remote)));
        selectedAccountMatches = false;
        assert.isUndefined(yield* second.resolve(token(remote)));
        const changedAccount = yield* makeRegistry(
          () => 1020,
          () => false,
        );
        assert.isUndefined(yield* changedAccount.resolve(token(remote)));
        const absentValidator = yield* makeRegistry(() => 1020);
        assert.isUndefined(yield* absentValidator.resolve(token(remote)));
      }).pipe(Effect.provide(layer)),
  );

  it.effect("cannot revive expired credentials after registry reconstruction", () =>
    Effect.gen(function* () {
      const first = yield* makeRegistry(
        () => 1000,
        () => true,
      );
      const remote = yield* first.issue(request);
      const expired = yield* makeRegistry(
        () => 1101,
        () => true,
      );
      assert.isUndefined(yield* expired.resolve(token(remote)));
      const store = yield* Store.McpRemoteCredentialStore;
      yield* store.pruneDead(1001);
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(yield* sql`SELECT token_hash FROM mcp_remote_credentials`, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps delegation idempotency namespace across rotations and restart but separates retries",
    () =>
      Effect.gen(function* () {
        const first = yield* makeRegistry(
          () => 1000,
          () => true,
        );
        const original = yield* first.issue(request);
        const namespace = (yield* first.resolve(token(original)))?.requestNamespace;
        const second = yield* makeRegistry(
          () => 1010,
          () => true,
        );
        assert.equal((yield* second.resolve(token(original)))?.requestNamespace, namespace);
        yield* second.revokeProviderSession(original.config.providerSessionId);
        const rotated = yield* second.issue(request);
        assert.notEqual(token(rotated), token(original));
        assert.equal((yield* second.resolve(token(rotated)))?.requestNamespace, namespace);
        assert.isUndefined(yield* second.resolve(token(original)));
        const retry = yield* second.issue({
          ...request,
          remoteRun: {
            runId: RunId.make("owned-run"),
            attemptId: RunAttemptId.make("retry-attempt"),
          },
        });
        assert.notEqual((yield* second.resolve(token(retry)))?.requestNamespace, namespace);
      }).pipe(Effect.provide(layer)),
  );
});
