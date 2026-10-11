import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Store from "../grokBot/GrokBotManagedStateStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { GrokBotTurnIdentity } from "./Adapters/GrokBotSettlementProjection.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";

const threadId = ThreadId.make("mixed-runtime-thread");
const remoteInstance = ProviderInstanceId.make("grok-bot");
const localInstance = ProviderInstanceId.make("codex");
const identity: GrokBotTurnIdentity = {
  native: {
    binding: "a".repeat(64),
    botId: "owned-bot",
    sessionId: "",
    generation: 0,
    afterUpdatedSeq: "0",
    threadId,
    providerInstanceId: remoteInstance,
  },
  runId: RunId.make("remote-run"),
  attemptId: RunAttemptId.make("remote-attempt"),
  rootNodeId: NodeId.make("remote-root"),
  providerThreadId: ProviderThreadId.make("remote-thread"),
  providerTurnId: ProviderTurnId.make("remote-turn"),
  runOrdinal: 2,
  providerTurnOrdinal: 1,
  messageId: "persisted-nonce",
  sentAtMs: 1000,
};
const receipt: Store.StoredGrokBotTurn = {
  identity,
  state: "accepted",
  delivery: "accepted",
  workflowId: "workflow",
  echoEntryId: "echo",
  outcome: null,
  settledAtMs: null,
};
const localRun = RunId.make("local-run");
const localAttempt = RunAttemptId.make("local-attempt");
const localThread = ProviderThreadId.make("local-thread");
const localRoot = NodeId.make("local-root");
const remoteSession = ProviderSessionId.make("remote-session");
const localSession = ProviderSessionId.make("local-session");

const projection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project"),
    providerInstanceId: remoteInstance,
    archivedAt: null,
    deletedAt: null,
  },
  runs: [
    {
      id: identity.runId,
      threadId,
      status: "running",
      providerInstanceId: remoteInstance,
      providerThreadId: identity.providerThreadId,
      activeAttemptId: identity.attemptId,
      rootNodeId: identity.rootNodeId,
      ordinal: 2,
    },
    {
      id: localRun,
      threadId,
      status: "running",
      providerInstanceId: localInstance,
      providerThreadId: localThread,
      activeAttemptId: localAttempt,
      rootNodeId: localRoot,
      ordinal: 1,
    },
  ],
  attempts: [
    {
      id: identity.attemptId,
      runId: identity.runId,
      status: "running",
      rootNodeId: identity.rootNodeId,
    },
    { id: localAttempt, runId: localRun, status: "running", rootNodeId: localRoot },
  ],
  providerThreads: [
    {
      id: identity.providerThreadId,
      driver: ProviderDriverKind.make("grok-bot"),
      appThreadId: threadId,
      providerInstanceId: remoteInstance,
      providerSessionId: remoteSession,
      ownerNodeId: null,
      status: "active",
      nativeThreadRef: {
        driver: "grok-bot",
        nativeId: `${identity.native.binding}/owned-bot/`,
        strength: "strong",
      },
      pendingBackgroundTasks: [],
    },
    {
      id: localThread,
      driver: ProviderDriverKind.make("codex"),
      appThreadId: threadId,
      providerInstanceId: localInstance,
      providerSessionId: localSession,
      ownerNodeId: null,
      status: "active",
      nativeThreadRef: { driver: "codex", nativeId: "local-native", strength: "strong" },
      pendingBackgroundTasks: [],
    },
  ],
  providerSessions: [
    { id: remoteSession, driver: "grok-bot", providerInstanceId: remoteInstance, status: "ready" },
    { id: localSession, driver: "codex", providerInstanceId: localInstance, status: "ready" },
  ],
  providerTurns: [
    {
      id: identity.providerTurnId,
      providerThreadId: identity.providerThreadId,
      runAttemptId: identity.attemptId,
      nodeId: identity.rootNodeId,
      status: "running",
    },
    {
      id: ProviderTurnId.make("local-turn"),
      providerThreadId: localThread,
      runAttemptId: localAttempt,
      nodeId: localRoot,
      status: "running",
    },
  ],
  nodes: [
    {
      id: identity.rootNodeId,
      rootNodeId: identity.rootNodeId,
      runId: identity.runId,
      kind: "root_turn",
      status: "running",
    },
    { id: localRoot, rootNodeId: localRoot, runId: localRun, kind: "root_turn", status: "running" },
    {
      id: NodeId.make("remote-approval-node"),
      rootNodeId: NodeId.make("remote-approval-node"),
      runId: null,
      kind: "approval_request",
      status: "waiting",
    },
  ],
  turnItems: [
    {
      id: "remote-item",
      runId: identity.runId,
      nodeId: identity.rootNodeId,
      providerThreadId: identity.providerThreadId,
      type: "assistant_message",
      status: "running",
    },
    {
      id: "local-item",
      runId: localRun,
      nodeId: localRoot,
      providerThreadId: localThread,
      type: "assistant_message",
      status: "running",
    },
    {
      id: "remote-approval-item",
      runId: null,
      nodeId: NodeId.make("remote-approval-node"),
      type: "approval_request",
      status: "waiting",
      requestId: "remote-runless-approval",
    },
  ],
  messages: [
    { id: "remote-message", runId: identity.runId, streaming: true },
    { id: "local-message", runId: localRun, streaming: true },
  ],
  subagents: [],
  runtimeRequests: [
    {
      id: "remote-request",
      nodeId: identity.rootNodeId,
      providerTurnId: identity.providerTurnId,
      status: "pending",
      responseCapability: { type: "live", providerSessionId: remoteSession },
    },
    {
      id: "remote-runless-approval",
      nodeId: NodeId.make("remote-approval-node"),
      providerTurnId: null,
      nativeRequestRef: {
        driver: ProviderDriverKind.make("grok-bot"),
        nativeId: "auto_review_approval/native-pending",
        strength: "strong",
      },
      status: "pending",
      responseCapability: { type: "live", providerSessionId: remoteSession },
    },
    {
      id: "local-request",
      nodeId: localRoot,
      status: "pending",
      responseCapability: { type: "live", providerSessionId: localSession },
    },
  ],
} as unknown as OrchestrationV2ThreadProjection;

function fixture(record: Store.StoredGrokBotTurn | undefined, includeLocal = true) {
  const commands: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
  const prepared: Array<Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0]> = [];
  const selected = includeLocal
    ? projection
    : {
        ...projection,
        runs: projection.runs.slice(0, 1),
        attempts: projection.attempts.slice(0, 1),
        providerThreads: projection.providerThreads.slice(0, 1),
        providerSessions: projection.providerSessions.slice(0, 1),
        providerTurns: projection.providerTurns.slice(0, 1),
        nodes: projection.nodes.slice(0, 1),
        messages: projection.messages.slice(0, 1),
        turnItems: projection.turnItems.slice(0, 1),
        runtimeRequests: projection.runtimeRequests.slice(0, 1),
      };
  const layer = Recovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        IdAllocator.layer,
        Layer.mock(Store.GrokBotManagedStateStore)({ lookupTurn: () => Effect.succeed(record) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(selected),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            commands.push(input);
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
          writeWithEffects: (input) => {
            prepared.push(input);
            return Effect.succeed(undefined as never);
          },
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          listByCommandId: () => Effect.succeed([]),
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
        }),
      ),
    ),
  );
  return { layer, commands, prepared };
}

it.effect(
  "preserves exact cloud run authority while cancelling local work in the same thread",
  () => {
    const { layer, commands } = fixture(receipt);
    return Effect.gen(function* () {
      const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
      const summary = yield* recovery.recover;
      assert.equal(summary.terminalizedRuns, 1);
      assert.equal(summary.stoppedSessions, 1);
      assert.equal(summary.closedRequests, 2);
      const command = commands[0];
      assert.isDefined(command);
      assert.deepStrictEqual(
        command?.effects?.map((effect) => effect.request),
        [{ type: "provider-runtime.reconnect", runId: identity.runId }],
      );
      assert.isTrue(
        command?.events.some(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === localRun &&
            event.payload.status === "cancelled",
        ),
      );
      assert.isFalse(command?.events.some((event) => event.runId === identity.runId));
      assert.isFalse(
        command?.events.some(
          (event) =>
            event.type === "provider-session.updated" && event.payload.id === remoteSession,
        ),
      );
      assert.isFalse(
        command?.events.some(
          (event) =>
            event.type === "runtime-request.updated" && event.payload.id === "remote-request",
        ),
      );
      assert.isTrue(
        command?.events.some(
          (event) =>
            event.type === "runtime-request.updated" &&
            event.payload.id === "remote-runless-approval" &&
            event.payload.status === "expired" &&
            event.payload.responseCapability.type === "not_resumable",
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("persists reconnect even when no cancellation events are needed", () => {
  const { layer, commands, prepared } = fixture(receipt, false);
  return Effect.gen(function* () {
    const summary = yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
    assert.equal(summary.terminalizedRuns, 0);
    assert.equal(summary.stoppedSessions, 0);
    assert.equal(summary.closedRequests, 0);
    assert.deepStrictEqual(commands, []);
    assert.deepStrictEqual(prepared[0]?.events, []);
    assert.deepStrictEqual(
      prepared[0]?.effects?.map((effect) => effect.request),
      [{ type: "provider-runtime.reconnect", runId: identity.runId }],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "does not create a continuation prompt or cancel remote authority during shutdown",
  () => {
    const { layer, commands, prepared } = fixture(receipt, false);
    return Effect.gen(function* () {
      const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
      yield* recovery.prepareForShutdown;
      const summary = yield* recovery.reconcile("shutdown");
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.stoppedSessions, 0);
      assert.equal(summary.closedRequests, 0);
      assert.deepStrictEqual(prepared, []);
      assert.deepStrictEqual(commands, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("requires the durable identity to match the current attempt and native binding", () =>
  Effect.gen(function* () {
    for (const record of [
      undefined,
      { ...receipt, identity: { ...identity, attemptId: RunAttemptId.make("stale-attempt") } },
      {
        ...receipt,
        identity: { ...identity, native: { ...identity.native, botId: "different-bot" } },
      },
      { ...receipt, state: "settled" as const, outcome: "success" as const, settledAtMs: 2000 },
    ]) {
      const { layer, commands } = fixture(record, false);
      const summary = yield* Effect.gen(function* () {
        return yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
      }).pipe(Effect.provide(layer));
      assert.equal(summary.terminalizedRuns, 1);
      assert.isFalse(
        commands[0]?.effects?.some(
          (effect) => effect.request.type === "provider-runtime.reconnect",
        ),
      );
    }
  }),
);
