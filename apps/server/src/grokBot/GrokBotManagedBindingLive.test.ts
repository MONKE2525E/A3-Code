import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadShell,
  type ServerSettings as Settings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Endpoint from "../cloud/ManagedEndpointAddress.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  GrokBotManagedBinding,
  grokBotManagedPrompt,
  GROK_BOT_MANAGED_SKILL_BODY,
  GROK_BOT_MANAGED_WORKFLOW_PATH,
} from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import { grokBotTurnIdentity } from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";
import {
  makeNative,
  makeTurn,
  nativeSession,
  providerSessionId,
} from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import migration from "../persistence/Migrations/062_GrokBotManagedRuntime.ts";
import completionMigration from "../persistence/Migrations/063_GrokBotManagedCompletion.ts";
import * as Live from "./GrokBotManagedBindingLive.ts";
import * as Native from "./GrokBotNativeRuntimeService.ts";
import * as Store from "./GrokBotManagedStateStore.ts";

const database = Layer.effectDiscard(migration.pipe(Effect.andThen(completionMigration))).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const storeLayer = Store.layer.pipe(Layer.provideMerge(database));

const harness = Effect.gen(function* () {
  const fixture = yield* makeTurn;
  const store = yield* Store.GrokBotManagedStateStore;
  const input = fixture.input;
  const state = {
    account: nativeSession.binding,
    owner: true as boolean | undefined,
    canManage: false,
    endpoint: true,
    settings: DEFAULT_SERVER_SETTINGS as Settings,
    settingsFail: false,
    restoreFail: false,
    switchOnIssue: false,
    replaceAttemptOnIssue: false,
    pauseAfterIssue: false,
    skill: undefined as { skillId: string; changed: boolean } | undefined,
    switchOnSkill: false,
    shell: { ...input.appThread, activeRunId: input.runId } as OrchestrationV2ThreadShell,
    run: {
      id: input.runId,
      threadId: input.threadId,
      ordinal: input.runOrdinal,
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      providerThreadId: input.providerThread.id,
      userMessageId: input.message.messageId,
      rootNodeId: input.rootNodeId,
      activeAttemptId: input.attemptId,
      status: "running",
      requestedAt: input.appThread.createdAt,
      startedAt: input.appThread.createdAt,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    } as OrchestrationV2Run,
    attempt: {
      id: input.attemptId,
      runId: input.runId,
      attemptOrdinal: 1,
      rootNodeId: input.rootNodeId,
      providerInstanceId: input.modelSelection.instanceId,
      providerThreadId: input.providerThread.id,
      providerTurnId: fixture.providerTurnId,
      reason: "initial",
      status: "running",
      startedAt: input.appThread.createdAt,
      completedAt: null,
    } as OrchestrationV2RunAttempt,
  };
  const issued: Registry.McpCredentialRequest[] = [];
  const skillRequests: Parameters<
    Native.GrokBotNativeRuntimeService["Service"]["ensureSkill"]
  >[0][] = [];
  const active = new Set<string>();
  const revoked: string[] = [];
  const postIssueRead = yield* Deferred.make<void>();
  const registry = Layer.mock(Registry.McpSessionRegistry)({
    issue: (request) =>
      Effect.sync(() => {
        issued.push(request);
        const id = `remote-${issued.length}`;
        active.add(id);
        if (state.switchOnIssue) state.account = "b".repeat(64);
        if (state.replaceAttemptOnIssue)
          state.run = { ...state.run, activeAttemptId: RunAttemptId.make("replacement") };
        return {
          config: {
            environmentId: EnvironmentId.make("fixture"),
            threadId: request.threadId,
            providerInstanceId: request.providerInstanceId,
            providerSessionId: id,
            endpoint: "http://127.0.0.1/mcp",
            authorizationHeader: `Bearer fixture-${id}`,
            browserToolsAvailable: request.browserToolsAvailable ?? true,
          },
        };
      }),
    revokeProviderSession: (id) =>
      Effect.sync(() => {
        revoked.push(id);
        active.delete(id);
      }),
  });
  const make = () =>
    GrokBotManagedBinding.pipe(
      Effect.provide(
        Live.layer.pipe(
          Layer.provide([
            Layer.succeed(Store.GrokBotManagedStateStore, {
              ...store,
              restoreTurns: (owned) =>
                state.restoreFail
                  ? Effect.fail(new PersistenceSqlError({ operation: "fixture-read" }))
                  : store.restoreTurns(owned),
            }),
            Layer.succeed(
              Native.GrokBotNativeRuntimeService,
              makeNative({
                accountBinding: Effect.sync(() => state.account),
                ensureSkill: (request) =>
                  Effect.gen(function* () {
                    skillRequests.push(request);
                    if (state.switchOnSkill) state.account = "b".repeat(64);
                    if (state.skill === undefined)
                      return yield* new Native.NativeRuntimeError({ kind: "refused" });
                    return state.skill;
                  }),
                sessionContext: () =>
                  Effect.sync(() => ({
                    bot: {
                      agentId: nativeSession.botId,
                      viewerCanManage: state.canManage,
                      ...(state.owner === undefined ? {} : { viewerIsOwner: state.owner }),
                    },
                    sessions: [],
                  })),
              }),
            ),
            Layer.mock(Projection.ProjectionStoreV2)({
              getThreadShell: () =>
                Effect.gen(function* () {
                  if (state.pauseAfterIssue && active.size > 0) {
                    yield* Deferred.succeed(postIssueRead, undefined);
                    yield* Effect.never;
                  }
                  return state.shell;
                }),
              getThreadRecords: (() =>
                Effect.sync(() => ({
                  runs: [state.run],
                  attempts: [state.attempt],
                }))) as Projection.ProjectionStoreV2["Service"]["getThreadRecords"],
            }),
            registry,
            Layer.mock(Endpoint.ManagedEndpointAddress)({
              read: Effect.sync(() =>
                state.endpoint
                  ? {
                      httpBaseUrl: "https://confirmed.example/",
                      wsBaseUrl: "wss://confirmed.example/",
                      providerKind: "cloudflare_tunnel" as const,
                    }
                  : null,
              ),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.suspend(() =>
                state.settingsFail
                  ? Effect.fail(
                      new ServerSettingsError({ settingsPath: "fixture", operation: "read-file" }),
                    )
                  : Effect.succeed(state.settings),
              ),
            }),
            NodeCrypto.layer,
          ]),
        ),
      ),
    );
  const binding = yield* make();
  const resolve = () =>
    binding.resolve({
      threadId: input.threadId,
      providerInstanceId: nativeSession.providerInstanceId,
      accountBinding: nativeSession.binding,
      botId: nativeSession.botId,
    });
  const prepare = (service = binding) =>
    service.prepareTurn({
      native: nativeSession,
      turn: input,
      providerTurnId: fixture.providerTurnId,
      providerSessionId,
    });
  const release = () => binding.release({ native: nativeSession, providerSessionId });
  return {
    state,
    store,
    binding,
    make,
    resolve,
    prepare,
    release,
    issued,
    active,
    revoked,
    input,
    fixture,
    skillRequests,
    postIssueRead,
  };
});

it.effect("revokes an issued credential if preparation is interrupted before handoff", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.resolve();
    h.state.pauseAfterIssue = true;
    const fiber = yield* Effect.forkChild(h.prepare());
    yield* Deferred.await(h.postIssueRead);
    assert.equal(h.active.size, 1);
    yield* Fiber.interrupt(fiber);
    assert.deepStrictEqual(h.revoked, ["remote-1"]);
    assert.equal(h.active.size, 0);
    h.state.pauseAfterIssue = false;
    const retried = yield* h.prepare();
    assert.equal(h.active.size, 1);
    assert.equal(retried.messageId, (yield* h.store.restoreTurns(nativeSession))[0]?.messageId);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "sends user text first without installing a skill and keeps retries compact after restart",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.resolve();
      const first = yield* h.prepare();
      assert.isTrue(first.nativePrompt.startsWith(h.input.message.text + "\n\n"));
      assert.include(first.nativePrompt, "Use skill t3-code-managed-turn-v1");
      assert.notInclude(first.nativePrompt, GROK_BOT_MANAGED_WORKFLOW_PATH);
      assert.notInclude(first.nativePrompt, GROK_BOT_MANAGED_SKILL_BODY);
      assert.notInclude(first.nativePrompt, "UpdateSkill");
      assert.equal(first.nativePrompt, grokBotManagedPrompt(h.input.message.text));
      assert.isBelow(first.nativePrompt.length - h.input.message.text.length, 100);
      assert.isUndefined(first.mcpConfig.mcpServers["t3-code-managed"]?.enabledTools);
      assert.equal(h.skillRequests.length, 0);
      yield* h.binding.uncertain({ turn: first });
      const replay = yield* h.prepare(yield* h.make());
      assert.equal(replay.nativePrompt, first.nativePrompt);
      assert.equal(replay.messageId, first.messageId);
      assert.equal(replay.sentAtMs, first.sentAtMs);
      assert.equal(h.skillRequests.length, 0);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect("refuses an account switch before issuing a managed credential", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.resolve();
    h.state.account = "b".repeat(64);
    yield* h.prepare().pipe(Effect.flip);
    assert.equal(h.issued.length, 0);
    assert.equal(h.skillRequests.length, 0);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("keeps subsequent messages compact even when skill readback was not acknowledged", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.resolve();
    const first = yield* h.prepare();
    yield* h.store.declareCompletion({
      identity: grokBotTurnIdentity(first),
      finalText: "Skill missing; setup needed",
      declaredAtMs: 1,
    });
    yield* h.store.commitSettlement({
      identity: grokBotTurnIdentity(first),
      outcome: "success",
      settledAtMs: 2,
    });
    const turn = {
      ...h.input,
      runId: RunId.make("next-run"),
      attemptId: RunAttemptId.make("next-attempt"),
      runOrdinal: 2,
      providerTurnOrdinal: 2,
    };
    const providerTurnId = ProviderTurnId.make("next-provider-turn");
    h.state.shell = { ...h.state.shell, activeRunId: turn.runId };
    h.state.run = { ...h.state.run, id: turn.runId, activeAttemptId: turn.attemptId, ordinal: 2 };
    h.state.attempt = { ...h.state.attempt, id: turn.attemptId, runId: turn.runId, providerTurnId };
    const next = yield* (yield* h.make()).prepareTurn({
      native: nativeSession,
      turn,
      providerTurnId,
      providerSessionId,
    });
    assert.include(next.nativePrompt, "Use skill t3-code-managed-turn-v1");
    assert.notInclude(next.nativePrompt, GROK_BOT_MANAGED_SKILL_BODY);
    assert.equal(h.skillRequests.length, 0);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("requires direct owner authority and exclusively binds the verified main session", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    for (const owner of [false, undefined]) {
      h.state.owner = owner;
      yield* h.resolve().pipe(Effect.flip);
      assert.equal(yield* h.store.get(nativeSession), undefined);
    }
    h.state.owner = true;
    assert.deepStrictEqual(yield* h.resolve(), nativeSession);
    const otherThread = ThreadId.make("other-thread");
    h.state.shell = { ...h.state.shell, id: otherThread };
    yield* h.binding
      .resolve({
        threadId: otherThread,
        providerInstanceId: nativeSession.providerInstanceId,
        accountBinding: nativeSession.binding,
        botId: nativeSession.botId,
      })
      .pipe(Effect.flip);
    h.state.account = "b".repeat(64);
    yield* h.resolve().pipe(Effect.flip);
    assert.equal(h.issued.length, 0);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "rotates exact-attempt credentials while preserving persisted delivery identity after service reconstruction",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.resolve();
      const first = yield* h.prepare();
      yield* h.binding.uncertain({ turn: first });
      yield* TestClock.adjust("1 minute");
      const reopened = yield* h.make();
      const replay = yield* h.prepare(reopened);
      assert.equal(replay.messageId, first.messageId);
      assert.equal(replay.sentAtMs, first.sentAtMs);
      assert.notEqual(
        replay.mcpConfig.mcpServers["t3-code-managed"]?.headers?.Authorization,
        first.mcpConfig.mcpServers["t3-code-managed"]?.headers?.Authorization,
      );
      assert.deepStrictEqual(
        h.issued.map((request) => request.remoteRun),
        [
          { runId: h.input.runId, attemptId: h.input.attemptId },
          { runId: h.input.runId, attemptId: h.input.attemptId },
        ],
      );
      assert.equal(
        first.mcpConfig.mcpServers["t3-code-managed"]?.url,
        "https://confirmed.example/mcp?t3-managed-protocol=2",
      );
      assert.equal(
        replay.mcpConfig.mcpServers["t3-code-managed"]?.url,
        first.mcpConfig.mcpServers["t3-code-managed"]?.url,
      );
      assert.equal(first.mcpConfig.mcpServers["t3-code-managed"]?.placement, "server");
      assert.deepStrictEqual(Object.keys(first.mcpConfig.mcpServers), ["t3-code-managed"]);
      assert.include(first.nativePrompt, "Use skill t3-code-managed-turn-v1");
      assert.notInclude(first.nativePrompt, "waitTimedOut");
      assert.include(first.nativePrompt, h.input.message.text);
      assert.equal(first.input.message.text, h.input.message.text);
      assert.equal(first.nativePrompt, replay.nativePrompt);
      yield* h.binding.accepted({ turn: first, delivery: "accepted" });
      assert.equal((yield* h.store.lookupTurn(grokBotTurnIdentity(first)))?.state, "accepted");
      assert.equal((yield* reopened.restoreTurns(nativeSession)).length, 1);
      yield* h.binding.verifyInterrupt({
        native: nativeSession,
        providerThreadId: h.input.providerThread.id,
        providerTurnId: first.providerTurnId,
      });
    }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "rejects endpoint loss and replaced run/attempt/root/provider authority before minting",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.resolve();
      h.state.endpoint = false;
      assert.equal((yield* h.binding.availability).ready, false);
      yield* h.prepare().pipe(Effect.flip);
      h.state.endpoint = true;
      const run = h.state.run;
      for (const replacement of [
        { ...run, activeAttemptId: RunAttemptId.make("replacement") },
        { ...run, rootNodeId: NodeId.make("replacement") },
        { ...run, providerInstanceId: ProviderInstanceId.make("replacement") },
        { ...run, status: "completed" as const },
      ]) {
        h.state.run = replacement;
        yield* h.prepare().pipe(Effect.flip);
      }
      assert.equal(h.issued.length, 0);
      h.state.run = run;
      const turn = yield* h.prepare();
      h.state.attempt = { ...h.state.attempt, status: "superseded" };
      assert.deepStrictEqual(yield* h.binding.restoreTurns(nativeSession), []);
      assert.deepStrictEqual(yield* h.binding.restoreManagedMessageIds(nativeSession), [
        turn.messageId,
      ]);
      assert.equal((yield* h.store.lookupTurn(grokBotTurnIdentity(turn)))?.state, "prepared");
      yield* h.store.commitSettlement({
        identity: grokBotTurnIdentity(turn),
        outcome: "success",
        settledAtMs: 200,
      });
      const reopened = yield* h.make();
      assert.deepStrictEqual(yield* reopened.restoreManagedMessageIds(nativeSession), [
        turn.messageId,
      ]);
      assert.deepStrictEqual(yield* reopened.restoreTranscriptTurns(nativeSession), [
        grokBotTurnIdentity(turn),
      ]);
      assert.deepStrictEqual(
        yield* reopened.lookupTranscriptTurn!(nativeSession, turn.messageId),
        grokBotTurnIdentity(turn),
      );
      assert.equal(
        yield* reopened.lookupTranscriptTurn!(nativeSession, "unknown-nonce"),
        undefined,
      );
      assert.deepStrictEqual(yield* reopened.restoreTurns(nativeSession), []);
      h.state.account = "b".repeat(64);
      yield* reopened.restoreManagedMessageIds(nativeSession).pipe(Effect.flip);
      yield* reopened.restoreTranscriptTurns(nativeSession).pipe(Effect.flip);
      yield* reopened.lookupTranscriptTurn!(nativeSession, turn.messageId).pipe(Effect.flip);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "applies project browser/device ceilings and fails closed when settings cannot load",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.resolve();
      h.state.settings = {
        ...DEFAULT_SERVER_SETTINGS,
        enableAgentBrowserAccess: true,
        enableAgentDeviceAccess: true,
        projectSettingsOverrides: {
          [h.input.appThread.projectId!]: {
            enableAgentBrowserAccess: false,
            enableAgentDeviceAccess: true,
          },
        },
      };
      yield* h.prepare();
      assert.equal(h.issued[0]?.browserToolsAvailable, false);
      assert.deepStrictEqual([...h.issued[0]!.capabilities!].sort(), [
        "device",
        "orchestration",
        "pull-requests",
        "worktree",
      ]);
      h.state.settingsFail = true;
      yield* h.prepare();
      assert.equal(h.issued[1]?.browserToolsAvailable, false);
      assert.deepStrictEqual([...h.issued[1]!.capabilities!].sort(), [
        "orchestration",
        "pull-requests",
        "worktree",
      ]);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect("preserves an active grant on release but retains its terminal revocation handle", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.resolve();
    const turn = yield* h.prepare();
    yield* h.release();
    assert.equal(h.active.size, 1);
    yield* h.store.commitSettlement({
      identity: grokBotTurnIdentity(turn),
      outcome: "success",
      settledAtMs: 200,
    });
    yield* h.release();
    assert.equal(h.active.size, 0);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect.each(["account", "store"] as const)(
  "revokes known handles when release authority fails: $0",
  (failure) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.resolve();
      yield* h.prepare();
      if (failure === "account") h.state.account = "b".repeat(64);
      else h.state.restoreFail = true;
      yield* h.release();
      assert.equal(h.active.size, 0);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect("revokes a newly minted grant if the selected account changes during issue", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.resolve();
    h.state.switchOnIssue = true;
    yield* h.prepare().pipe(Effect.flip);
    assert.equal(h.issued.length, 1);
    assert.equal(h.active.size, 0);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("does not dispatch a prepared native turn when its attempt changes during issue", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.resolve();
    h.state.replaceAttemptOnIssue = true;
    const error = yield* h.prepare().pipe(Effect.flip);
    assert.equal(error.reason, "This provider no longer owns the active run attempt.");
    assert.equal(h.issued.length, 1);
    assert.equal(h.active.size, 0);
    assert.equal(h.revoked.length, 1);
    assert.deepStrictEqual(yield* h.binding.restoreTurns(nativeSession), []);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "reads only the exact durable accepted final answer under the current native account",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.resolve();
      const turn = yield* h.prepare();
      const identity = grokBotTurnIdentity(turn);
      assert.isUndefined(yield* h.binding.lookupCompletion(identity));
      const declaration = yield* h.store.declareCompletion({
        identity,
        finalText: "Durable final",
        declaredAtMs: 200,
      });
      assert.deepStrictEqual(yield* h.binding.lookupCompletion(identity), declaration);
      const reopened = yield* h.make();
      assert.deepStrictEqual(yield* reopened.lookupCompletion(identity), declaration);
      yield* reopened
        .lookupCompletion({ ...identity, attemptId: RunAttemptId.make("foreign") })
        .pipe(Effect.flip);
      h.state.account = "b".repeat(64);
      yield* reopened.lookupCompletion(identity).pipe(Effect.flip);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "scopes native interruption to the durable bot session and rejects replaced authority",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.resolve();
      const turn = yield* h.prepare();
      const input = {
        native: nativeSession,
        providerThreadId: h.input.providerThread.id,
        providerTurnId: turn.providerTurnId,
      };
      yield* h.binding.verifyInterrupt(input);
      yield* h.binding
        .verifyInterrupt({ ...input, providerTurnId: ProviderTurnId.make("foreign-turn") })
        .pipe(Effect.flip);
      h.state.owner = false;
      yield* h.binding.verifyInterrupt(input).pipe(Effect.flip);
      h.state.owner = true;
      h.state.account = "b".repeat(64);
      yield* h.binding.verifyInterrupt(input).pipe(Effect.flip);
      h.state.account = nativeSession.binding;
      const original = h.state.shell;
      h.state.shell = { ...original, activeRunId: RunId.make("replacement") };
      yield* h.binding.verifyInterrupt(input).pipe(Effect.flip);
      h.state.shell = {
        ...original,
        modelSelection: { ...original.modelSelection, model: "foreign-bot" },
      };
      yield* h.binding.verifyInterrupt(input).pipe(Effect.flip);
      h.state.shell = original;
      yield* h.binding
        .verifyInterrupt({ ...input, native: { ...nativeSession, sessionId: "foreign-session" } })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(storeLayer)),
);

it.effect("restores exact managed authority while its latest run waits for a native question", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.resolve();
    const turn = yield* h.prepare();
    h.state.run = { ...h.state.run, status: "waiting" };
    h.state.shell = {
      ...h.state.shell,
      activeRunId: null,
      latestRunId: turn.input.runId,
      status: "waiting",
    };
    assert.strictEqual((yield* h.binding.restoreTurns(turn.native)).length, 1);
    h.state.shell = { ...h.state.shell, latestRunId: RunId.make("replacement") };
    assert.strictEqual((yield* h.binding.restoreTurns(turn.native)).length, 0);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("keeps the durable protocol receipt when a retry sees a newer skill", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.resolve();
    const oldHash = "b".repeat(64);
    const identity = {
      ...grokBotTurnIdentity(h.fixture),
      managedSkill: {
        skillId: "t3-code-managed-turn-v1",
        hash: oldHash,
        changed: false,
        workflowPath: GROK_BOT_MANAGED_WORKFLOW_PATH,
      },
    };
    yield* h.store.prepareTurn(identity);
    const retry = yield* h.prepare();
    assert.equal(retry.managedSkill?.hash, oldHash);
    assert.equal(retry.nativePrompt, grokBotManagedPrompt(h.input.message.text));
  }).pipe(Effect.provide(storeLayer)),
);

it("keeps behavior in the shared skill and invokes it with a compact prompt", () => {
  assert.equal(
    grokBotManagedPrompt("hello"),
    "hello\n\n[From T3 Code: Use skill t3-code-managed-turn-v1.]",
  );
  assert.include(
    GROK_BOT_MANAGED_SKILL_BODY,
    "grok_bot_complete_turn(finalText, managedSkillHash)",
  );
  assert.include(
    GROK_BOT_MANAGED_SKILL_BODY,
    "Do not complete while waiting for required input or children",
  );
  assert.include(GROK_BOT_MANAGED_SKILL_BODY, "send no duplicate native final message");
  assert.include(GROK_BOT_MANAGED_SKILL_BODY, "call grok_bots_list");
});
