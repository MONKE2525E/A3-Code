import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Validator from "../mcp/McpRemoteRunValidator.ts";
import { grokBotTurnIdentity } from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";
import {
  makeNative,
  makeTurn,
  nativeSession,
} from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import migration from "../persistence/Migrations/068_GrokBotManagedRuntime.ts";
import * as Authority from "./GrokBotMcpAuthority.ts";
import * as Native from "./GrokBotNativeRuntimeService.ts";
import { NativeSignedOutError } from "./GrokBotNativeService.ts";
import * as Store from "./GrokBotManagedStateStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const database = Layer.effectDiscard(migration).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const storeLayer = Store.layer.pipe(Layer.provideMerge(database));
const harness = Effect.gen(function* () {
  const turn = yield* makeTurn;
  const identity = grokBotTurnIdentity(turn);
  const store = yield* Store.GrokBotManagedStateStore;
  yield* store.acquire(nativeSession);
  yield* store.prepareTurn(identity);
  const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
    Effect.provide(ProjectionStore.layerMemory),
  );
  const at = turn.input.appThread.createdAt;
  yield* projections.apply({
    id: EventId.make("authority:thread"),
    type: "thread.created",
    threadId: identity.native.threadId,
    occurredAt: at,
    payload: turn.input.appThread,
  });
  const run = {
    id: identity.runId,
    threadId: identity.native.threadId,
    ordinal: identity.runOrdinal,
    providerInstanceId: identity.native.providerInstanceId,
    modelSelection: turn.input.modelSelection,
    providerThreadId: identity.providerThreadId,
    userMessageId: turn.input.message.messageId,
    rootNodeId: identity.rootNodeId,
    activeAttemptId: identity.attemptId,
    status: "running" as const,
    requestedAt: at,
    startedAt: at,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* projections.apply({
    id: EventId.make("authority:run"),
    type: "run.updated",
    threadId: identity.native.threadId,
    occurredAt: at,
    payload: run,
  });
  const selection = { binding: nativeSession.binding, signedOut: false };
  const native = Layer.succeed(
    Native.GrokBotNativeRuntimeService,
    makeNative({
      accountBinding: Effect.suspend(() =>
        selection.signedOut
          ? Effect.fail(new NativeSignedOutError({}))
          : Effect.succeed(selection.binding),
      ),
    }),
  );
  const make = () =>
    Validator.McpRemoteRunValidator.pipe(
      Effect.provide(
        Authority.layer.pipe(
          Layer.provide(native),
          Layer.provide(Layer.succeed(Store.GrokBotManagedStateStore, store)),
          Layer.provide(Layer.succeed(ProjectionStore.ProjectionStoreV2, projections)),
        ),
      ),
    );
  const scope: McpThreadInvocationScope = {
    environmentId: EnvironmentId.make("fixture"),
    issuedAt: 0,
    capabilities: new Set(["orchestration"]),
    requestNamespace: "same-durable-attempt",
    thread: {
      threadId: nativeSession.threadId,
      providerInstanceId: nativeSession.providerInstanceId,
      providerSessionId: "first-host-session",
      remoteRun: { runId: identity.runId, attemptId: identity.attemptId },
    },
    client: undefined,
  };
  return {
    store,
    identity,
    selection,
    make,
    scope,
    projections,
    run,
    at,
    validator: yield* make(),
  };
});

it.effect(
  "revalidates account ownership for prepared, uncertain and accepted grants after host reconstruction",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      assert.equal(yield* h.validator.validate(h.scope), true);
      yield* h.store.uncertain(h.identity);
      assert.equal(yield* h.validator.validate(h.scope), true);
      yield* h.store.accepted({ identity: h.identity, delivery: "accepted" });
      const reopened = yield* h.make();
      const rotated = {
        ...h.scope,
        thread: { ...h.scope.thread, providerSessionId: "next-host-session" },
      };
      assert.equal(yield* reopened.validate(rotated), true);
      h.selection.binding = "b".repeat(64);
      assert.equal(yield* reopened.validate(rotated), false);
      h.selection.binding = nativeSession.binding;
      h.selection.signedOut = true;
      assert.equal(yield* reopened.validate(rotated), false);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "rejects thread/provider/attempt substitution and grants without managed delivery records",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      for (const thread of [
        { ...h.scope.thread, threadId: ThreadId.make("foreign-thread") },
        { ...h.scope.thread, providerInstanceId: ProviderInstanceId.make("foreign-provider") },
        {
          ...h.scope.thread,
          remoteRun: { runId: h.identity.runId, attemptId: RunAttemptId.make("retry") },
        },
        {
          threadId: h.scope.thread.threadId,
          providerInstanceId: h.scope.thread.providerInstanceId,
          providerSessionId: h.scope.thread.providerSessionId,
        },
      ])
        assert.equal(yield* h.validator.validate({ ...h.scope, thread }), false);
      assert.equal(yield* h.validator.validate(h.scope), true);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect("stops accepting all rotated credentials after an authoritative settlement commits", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const reopened = yield* h.make();
    assert.equal(yield* reopened.validate(h.scope), true);
    yield* h.store.commitSettlement({ identity: h.identity, outcome: "error", settledAtMs: 200 });
    assert.equal(yield* h.validator.validate(h.scope), false);
    assert.equal(
      yield* reopened.validate({
        ...h.scope,
        thread: { ...h.scope.thread, providerSessionId: "rotated-before-terminal" },
      }),
      false,
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("fails closed when managed authority storage is unavailable", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const denied = yield* Validator.McpRemoteRunValidator.pipe(
      Effect.provide(
        Authority.layer.pipe(
          Layer.provide(ProjectionStore.layerMemory),
          Layer.provide(Layer.succeed(Native.GrokBotNativeRuntimeService, makeNative())),
          Layer.provide(
            Layer.mock(Store.GrokBotManagedStateStore)({
              lookupTurn: () => Effect.fail(new Store.ManagedStateConflict({ stage: "turn" })),
            }),
          ),
        ),
      ),
    );
    assert.equal(yield* denied.validate(h.scope), false);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "denies even ordinary reads after the committed run attempt changes without a native settlement",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.store.accepted({ identity: h.identity, delivery: "accepted" });
      assert.equal(yield* h.validator.validate(h.scope), true);
      yield* h.projections.apply({
        id: EventId.make("authority:retry"),
        type: "run.updated",
        threadId: h.identity.native.threadId,
        occurredAt: h.at,
        payload: { ...h.run, activeAttemptId: RunAttemptId.make("replacement-attempt") },
      });
      assert.equal(yield* h.validator.validate(h.scope), false);
      assert.equal((yield* h.store.lookupTurn(h.identity))?.state, "accepted");
    }).pipe(Effect.provide(storeLayer)),
);
