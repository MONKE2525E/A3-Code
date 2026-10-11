import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  EventId,
  NodeId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Validator from "../mcp/McpRemoteRunValidator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  grokBotTurnIdentity,
  type GrokBotTurnIdentity,
} from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";
import {
  GROK_BOT_MANAGED_SKILL_BODY,
  GROK_BOT_MANAGED_SKILL_NAME,
  GROK_BOT_MANAGED_WORKFLOW_PATH,
} from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import {
  makeNative,
  makeTurn,
  nativeSession,
} from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import migration from "../persistence/Migrations/062_GrokBotManagedRuntime.ts";
import completionMigration from "../persistence/Migrations/063_GrokBotManagedCompletion.ts";
import * as Authority from "./GrokBotMcpAuthority.ts";
import * as Native from "./GrokBotNativeRuntimeService.ts";
import * as Store from "./GrokBotManagedStateStore.ts";
import * as Completion from "./GrokBotTurnCompletion.ts";

const database = Layer.effectDiscard(migration.pipe(Effect.andThen(completionMigration))).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const storeLayer = Store.layer.pipe(Layer.provideMerge(database));
const makeHarness = (receipt?: NonNullable<GrokBotTurnIdentity["managedSkill"]>) =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const identity = {
      ...grokBotTurnIdentity(turn),
      ...(receipt === undefined ? {} : { managedSkill: receipt }),
    };
    const store = yield* Store.GrokBotManagedStateStore;
    yield* store.acquire(nativeSession);
    yield* store.prepareTurn(identity);
    const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.provide(ProjectionStore.layerMemory),
    );
    const at = turn.input.appThread.createdAt;
    yield* projections.apply({
      id: EventId.make("completion:thread"),
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
      id: EventId.make("completion:run"),
      type: "run.updated",
      threadId: identity.native.threadId,
      occurredAt: at,
      payload: run,
    });
    const state = { binding: nativeSession.binding };
    const authority = Authority.layer.pipe(
      Layer.provide([
        Layer.succeed(
          Native.GrokBotNativeRuntimeService,
          makeNative({ accountBinding: Effect.sync(() => state.binding) }),
        ),
        Layer.succeed(Store.GrokBotManagedStateStore, store),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
      ]),
    );
    const layer = Completion.layer.pipe(
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(authority),
      Layer.provide(Layer.succeed(Store.GrokBotManagedStateStore, store)),
    );
    const service = yield* Completion.GrokBotTurnCompletion.pipe(Effect.provide(layer));
    const validator = yield* Validator.McpRemoteRunValidator.pipe(Effect.provide(authority));
    const scope: Invocation.McpThreadInvocationScope = {
      environmentId: EnvironmentId.make("fixture"),
      issuedAt: 0,
      capabilities: new Set(["orchestration"]),
      requestNamespace: "owned-attempt",
      client: undefined,
      thread: {
        threadId: nativeSession.threadId,
        providerInstanceId: nativeSession.providerInstanceId,
        providerSessionId: "remote-credential",
        remoteRun: { runId: identity.runId, attemptId: identity.attemptId },
      },
    };
    const complete = (
      finalText = "Final answer",
      caller: Invocation.McpInvocationScope = scope,
      managedSkillHash?: string,
    ) =>
      service
        .complete({ finalText, ...(managedSkillHash === undefined ? {} : { managedSkillHash }) })
        .pipe(Effect.provideService(Invocation.McpInvocationContext, caller));
    return {
      store,
      identity,
      projections,
      run,
      at,
      scope,
      state,
      service,
      validator,
      complete,
      appThread: turn.input.appThread,
    };
  });
const harness = makeHarness();
const currentHash = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return Buffer.from(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(GROK_BOT_MANAGED_SKILL_BODY)),
  ).toString("hex");
}).pipe(Effect.provide(NodeCrypto.layer));

it.effect(
  "persists authenticated workflow acknowledgements only after a matching successful completion and survives restart",
  () =>
    Effect.gen(function* () {
      const hash = yield* currentHash;
      const receipt = {
        skillId: GROK_BOT_MANAGED_SKILL_NAME,
        hash,
        changed: true,
        workflowPath: GROK_BOT_MANAGED_WORKFLOW_PATH,
      };
      const h = yield* makeHarness(receipt);
      const query = { native: nativeSession, hash, workflowPath: GROK_BOT_MANAGED_WORKFLOW_PATH };
      assert.equal(yield* h.store.hasConfirmedWorkflowSkill(query), false);
      yield* h.complete("Final answer", h.scope, hash);
      assert.equal((yield* h.store.lookupTurn(h.identity))?.identity.managedSkill?.confirmed, true);
      yield* h.complete("Final answer", h.scope, "wrong");
      assert.equal((yield* h.store.lookupTurn(h.identity))?.identity.managedSkill?.confirmed, true);
      assert.equal(yield* h.store.hasConfirmedWorkflowSkill(query), false);
      yield* h.store.commitSettlement({ identity: h.identity, outcome: "success", settledAtMs: 1 });
      const reopened = yield* Store.GrokBotManagedStateStore.pipe(Effect.provide(Store.layer));
      assert.equal(yield* reopened.hasConfirmedWorkflowSkill(query), true);
      assert.equal(
        yield* reopened.hasConfirmedWorkflowSkill({ ...query, hash: "a".repeat(64) }),
        false,
      );
      assert.equal(
        yield* reopened.hasConfirmedWorkflowSkill({ ...query, workflowPath: "/other/SKILL.md" }),
        false,
      );
      const other = {
        ...nativeSession,
        botId: "other-bot",
        threadId: ThreadId.make("other-thread"),
      };
      yield* reopened.acquire(other);
      assert.equal(yield* reopened.hasConfirmedWorkflowSkill({ ...query, native: other }), false);
      const otherAccount = {
        ...other,
        binding: "b".repeat(64),
        threadId: ThreadId.make("other-account-thread"),
      };
      yield* reopened.acquire(otherAccount);
      assert.equal(
        yield* reopened.hasConfirmedWorkflowSkill({ ...query, native: otherAccount }),
        false,
      );
    }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "ignores absent or wrong workflow hashes and cannot upgrade an unacknowledged duplicate callback",
  () =>
    Effect.gen(function* () {
      const hash = yield* currentHash;
      const h = yield* makeHarness({
        skillId: GROK_BOT_MANAGED_SKILL_NAME,
        hash,
        changed: true,
        workflowPath: GROK_BOT_MANAGED_WORKFLOW_PATH,
      });
      yield* h.complete("Final answer", h.scope, "wrong");
      yield* h.complete("Final answer", h.scope, hash);
      assert.equal(
        (yield* h.store.lookupTurn(h.identity))?.identity.managedSkill?.confirmed,
        undefined,
      );
      yield* h.store.commitSettlement({ identity: h.identity, outcome: "success", settledAtMs: 1 });
      assert.equal(
        yield* h.store.hasConfirmedWorkflowSkill({
          native: nativeSession,
          hash,
          workflowPath: GROK_BOT_MANAGED_WORKFLOW_PATH,
        }),
        false,
      );
    }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "rejects account changes before saving a skill acknowledgement and ignores stale protocol versions",
  () =>
    Effect.gen(function* () {
      const hash = yield* currentHash;
      const h = yield* makeHarness({
        skillId: GROK_BOT_MANAGED_SKILL_NAME,
        hash: "a".repeat(64),
        changed: true,
        workflowPath: GROK_BOT_MANAGED_WORKFLOW_PATH,
      });
      h.state.binding = "b".repeat(64);
      assert.equal(
        (yield* h.complete("Final answer", h.scope, hash).pipe(Effect.flip)).reason,
        "authority_changed",
      );
      assert.equal(yield* h.store.lookupCompletion(h.identity), undefined);
      h.state.binding = nativeSession.binding;
      yield* h.complete("Final answer", h.scope, "a".repeat(64));
      assert.equal(
        (yield* h.store.lookupTurn(h.identity))?.identity.managedSkill?.confirmed,
        undefined,
      );
    }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "accepts only an immutable exact-attempt declaration while leaving finalization to the adapter",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const watcher = yield* h.store.openCompletionWatch(nativeSession);
      const first = yield* h.complete();
      assert.equal(first.declarationAccepted, true);
      assert.equal(first.source, "agent_declaration");
      assert.equal(first.nativeWorkflowStatus, "unknown");
      assert.equal(first.runId, h.identity.runId);
      assert.deepStrictEqual(yield* h.complete(), first);
      assert.equal(
        (yield* h.complete("Different answer").pipe(Effect.flip)).reason,
        "conflicting_declaration",
      );
      const events = yield* watcher.pipe(Stream.take(2), Stream.runCollect);
      assert.deepStrictEqual(events[0], events[1]);
      assert.equal((yield* h.store.lookupTurn(h.identity))?.state, "prepared");
      assert.equal(
        (yield* h.projections.getThreadRecords(nativeSession.threadId, ["runs"])).runs[0]?.status,
        "running",
      );
      assert.equal(yield* h.validator.validate(h.scope), true);
      yield* h.store.commitSettlement({
        identity: h.identity,
        outcome: "success",
        settledAtMs: 500,
      });
      assert.equal(yield* h.validator.validate(h.scope), false);
      assert.equal((yield* h.complete().pipe(Effect.flip)).reason, "authority_changed");
    }).pipe(Effect.scoped, Effect.provide(storeLayer)),
);

it.effect(
  "refuses external clients, local sessions, wrong grants, and switched native accounts",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const callers: Invocation.McpInvocationScope[] = [
        {
          ...h.scope,
          thread: undefined,
          client: { sessionId: "external", label: "external", access: "full-access" },
        },
        { ...h.scope, capabilities: new Set() },
        {
          ...h.scope,
          thread: {
            threadId: h.scope.thread.threadId,
            providerSessionId: h.scope.thread.providerSessionId,
            providerInstanceId: h.scope.thread.providerInstanceId,
          },
        },
        { ...h.scope, thread: { ...h.scope.thread, threadId: ThreadId.make("foreign") } },
        {
          ...h.scope,
          thread: { ...h.scope.thread, providerInstanceId: ProviderInstanceId.make("foreign") },
        },
        {
          ...h.scope,
          thread: {
            ...h.scope.thread,
            remoteRun: { runId: RunId.make("foreign"), attemptId: h.identity.attemptId },
          },
        },
        {
          ...h.scope,
          thread: {
            ...h.scope.thread,
            remoteRun: { runId: h.identity.runId, attemptId: RunAttemptId.make("foreign") },
          },
        },
      ];
      for (const caller of callers)
        assert.equal(
          (yield* h.complete("Foreign answer", caller).pipe(Effect.flip)).reason,
          "authority_changed",
        );
      h.state.binding = "b".repeat(64);
      assert.equal((yield* h.complete().pipe(Effect.flip)).reason, "authority_changed");
      h.state.binding = nativeSession.binding;
      assert.equal((yield* h.store.lookupTurn(h.identity))?.state, "prepared");
      assert.equal(yield* h.validator.validate(h.scope), true);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect.each(["attempt", "root", "provider", "terminal", "archive"] as const)(
  "refuses a completion after committed authority changes: %s",
  (replacement) =>
    Effect.gen(function* () {
      const h = yield* harness;
      if (replacement === "archive") {
        yield* h.projections.apply({
          id: EventId.make("completion:archive"),
          type: "thread.archived",
          threadId: nativeSession.threadId,
          occurredAt: h.at,
          payload: { ...h.appThread, archivedAt: h.at, updatedAt: h.at },
        });
      } else {
        const changed =
          replacement === "attempt"
            ? { activeAttemptId: RunAttemptId.make("replacement") }
            : replacement === "root"
              ? { rootNodeId: NodeId.make("replacement") }
              : replacement === "provider"
                ? { providerInstanceId: ProviderInstanceId.make("replacement") }
                : { status: "completed" as const, completedAt: h.at };
        yield* h.projections.apply({
          id: EventId.make("completion:replacement"),
          type: "run.updated",
          threadId: nativeSession.threadId,
          occurredAt: h.at,
          payload: { ...h.run, ...changed },
        });
      }
      assert.equal((yield* h.complete().pipe(Effect.flip)).reason, "authority_changed");
    }).pipe(Effect.provide(storeLayer)),
);
