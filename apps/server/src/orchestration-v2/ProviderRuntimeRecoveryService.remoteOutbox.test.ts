import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
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
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Store from "../grokBot/GrokBotManagedStateStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { GrokBotTurnIdentity } from "./Adapters/GrokBotSettlementProjection.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";

const identity: GrokBotTurnIdentity = {
  native: {
    binding: "a".repeat(64),
    botId: "owned-bot",
    sessionId: "",
    generation: 0,
    afterUpdatedSeq: "0",
    threadId: ThreadId.make("remote-thread"),
    providerInstanceId: ProviderInstanceId.make("grok-bot"),
  },
  runId: RunId.make("remote-run"),
  attemptId: RunAttemptId.make("remote-attempt"),
  rootNodeId: NodeId.make("remote-root"),
  providerThreadId: ProviderThreadId.make("remote-provider-thread"),
  providerTurnId: ProviderTurnId.make("remote-turn"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  messageId: "original-send-nonce",
  sentAtMs: 1000,
};

function fixture(status: "starting" | "running") {
  const projection = {
    thread: {
      id: identity.native.threadId,
      projectId: ProjectId.make("project"),
      providerInstanceId: identity.native.providerInstanceId,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: identity.runId,
        threadId: identity.native.threadId,
        status,
        providerInstanceId: identity.native.providerInstanceId,
        providerThreadId: identity.providerThreadId,
        activeAttemptId: identity.attemptId,
        rootNodeId: identity.rootNodeId,
        ordinal: 1,
      },
    ],
    attempts: [
      { id: identity.attemptId, runId: identity.runId, status, rootNodeId: identity.rootNodeId },
    ],
    providerThreads: [
      {
        id: identity.providerThreadId,
        driver: ProviderDriverKind.make("grok-bot"),
        appThreadId: identity.native.threadId,
        providerInstanceId: identity.native.providerInstanceId,
        providerSessionId: ProviderSessionId.make("remote-session"),
        ownerNodeId: null,
        status: "active",
        nativeThreadRef: {
          driver: "grok-bot",
          nativeId: `${identity.native.binding}/owned-bot/`,
          strength: "strong",
        },
        pendingBackgroundTasks: [],
      },
    ],
    providerSessions: [],
    providerTurns: [],
    nodes: [],
    turnItems: [],
    messages: [],
    subagents: [],
    runtimeRequests: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const stores = Layer.mergeAll(
    Store.layer,
    EventStore.layer,
    EffectOutbox.layer,
    IdAllocator.layer,
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getRecoveryThreadIds: () => Effect.succeed([identity.native.threadId]),
      getRuntimeRecoveryProjection: () => Effect.succeed(projection),
    }),
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  return Recovery.layer.pipe(
    Layer.provideMerge(EventSink.layer.pipe(Layer.provideMerge(stores))),
    Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
  );
}

describe("durable remote recovery outbox", () => {
  it.effect.each([
    { status: "starting", state: "prepared" },
    { status: "starting", state: "uncertain" },
    { status: "starting", state: "accepted" },
    { status: "running", state: "prepared" },
    { status: "running", state: "uncertain" },
    { status: "running", state: "accepted" },
  ] as const)(
    "preserves $status/$state delivery for reconciliation across process loss",
    ({ status, state }) =>
      Effect.gen(function* () {
        const store = yield* Store.GrokBotManagedStateStore;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
        yield* store.acquire(identity.native);
        yield* store.prepareTurn(identity);
        if (state === "uncertain") yield* store.uncertain(identity);
        if (state === "accepted") yield* store.accepted({ identity, delivery: "accepted" });

        yield* outbox.enqueue([
          {
            id: "start:0:remote",
            commandId: CommandId.make("original-remote-command"),
            threadId: identity.native.threadId,
            request: { type: "provider-turn.start", runId: identity.runId },
          },
          {
            id: "start:1:local",
            commandId: CommandId.make("original-local-command"),
            threadId: ThreadId.make("local-thread"),
            request: { type: "provider-turn.start", runId: RunId.make("local-run") },
          },
        ]);
        // The process died inside the original start after saving its identity.
        const original = yield* outbox.claimNext({
          workerId: "lost-worker",
          leaseDurationMs: 60000,
        });
        assert.equal(Option.getOrThrow(original).id, "start:0:remote");

        const summary = yield* recovery.recover;
        assert.equal(summary.terminalizedRuns, 0);
        assert.equal(summary.retiredEffects, 2);
        for (const id of ["start:0:remote", "start:1:local"]) {
          assert.equal(Option.getOrThrow(yield* outbox.get(id)).status, "cancelled");
        }
        // Real EventSink must accept a reconnect with zero projection events.
        const reconnect = Option.getOrThrow(
          yield* outbox.claimNext({
            workerId: "recovery-worker",
            leaseDurationMs: 60000,
          }),
        );
        assert.deepStrictEqual(reconnect.request, {
          type: "provider-runtime.reconnect",
          runId: identity.runId,
        });
        assert.equal((yield* store.lookupTurn(identity))?.state, state);
        assert.deepStrictEqual(yield* store.restoreTurns(identity.native), [identity]);

        // Another host loss requeues reconciliation, never the original sends.
        const rebuilt = yield* Effect.gen(function* () {
          const nextOutbox = yield* EffectOutbox.EffectOutboxV2;
          const nextStore = yield* Store.GrokBotManagedStateStore;
          assert.deepStrictEqual(yield* nextOutbox.reconcileAfterProcessLoss, {
            requeued: 1,
            cancelled: 0,
          });
          const restored = yield* nextStore.prepareTurn({
            ...identity,
            messageId: "must-not-replace-the-nonce",
            sentAtMs: 9999,
          });
          assert.deepStrictEqual(restored, identity);
          const effect = Option.getOrThrow(
            yield* nextOutbox.claimNext({
              workerId: "next-worker",
              leaseDurationMs: 60000,
            }),
          );
          assert.equal(effect.id, reconnect.id);
          assert.deepStrictEqual(effect.request, reconnect.request);
          yield* nextOutbox.succeed({ effectId: effect.id, workerId: "next-worker" });
          assert.isTrue(
            Option.isNone(
              yield* nextOutbox.claimNext({
                workerId: "next-worker",
                leaseDurationMs: 60000,
              }),
            ),
          );
          return restored;
        }).pipe(Effect.provide(Layer.mergeAll(Store.layer, EffectOutbox.layer)));
        assert.deepStrictEqual(rebuilt, identity);
      }).pipe(Effect.provide(fixture(status))),
  );
});
