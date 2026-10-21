import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Validator from "../mcp/McpRemoteRunValidator.ts";
import * as Authority from "./NativeAgentMcpAuthority.ts";
import * as Native from "../museAgent/MuseAgentNativeRuntimeService.ts";
import * as GrokNative from "../grokBot/GrokBotNativeRuntimeService.ts";
import * as GrokStore from "../grokBot/GrokBotManagedStateStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Settings from "../serverSettings.ts";
import {
  binding,
  instanceId,
  makeNative,
  makeTurn,
} from "../orchestration-v2/Adapters/MuseAgentAdapterV2.testkit.ts";
import * as GrokFixture from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import { grokBotTurnIdentity } from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";

import { museThreadIdForSession, museThreadIdentity } from "../museAgent/MuseAgentThreadIds.ts";

const fixture = (grok = false, sessionId?: string) =>
  Effect.gen(function* () {
    const museTurn = yield* makeTurn;
    const grokTurn = yield* GrokFixture.makeTurn;
    const turn = grok ? grokTurn.input : museTurn;
    const id = grok
      ? turn.threadId
      : ThreadId.make(
          museThreadIdForSession(
            museThreadIdentity(binding, turn.modelSelection.instanceId),
            sessionId,
          ),
        );
    const thread = {
      ...turn.appThread,
      id,
      lineage: { ...turn.appThread.lineage, rootThreadId: id },
    };
    const at = thread.createdAt;
    const run: OrchestrationV2Run = {
      id: turn.runId,
      threadId: id,
      ordinal: turn.runOrdinal,
      providerInstanceId: turn.modelSelection.instanceId,
      modelSelection: turn.modelSelection,
      providerThreadId: turn.providerThread.id,
      userMessageId: turn.message.messageId,
      rootNodeId: turn.rootNodeId,
      activeAttemptId: turn.attemptId,
      status: "running",
      requestedAt: at,
      startedAt: at,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const projections = yield* Projections.ProjectionStoreV2.pipe(
      Effect.provide(Projections.layerMemory),
    );
    yield* projections.apply({
      id: EventId.make("authority:thread"),
      type: "thread.created",
      threadId: id,
      occurredAt: at,
      payload: thread,
    });
    yield* projections.apply({
      id: EventId.make("authority:run"),
      type: "run.updated",
      threadId: id,
      occurredAt: at,
      payload: run,
    });
    const settings = yield* Settings.ServerSettingsService.pipe(
      Effect.provide(
        Settings.layerTest({
          providerInstances: {
            [turn.modelSelection.instanceId]: {
              driver: ProviderDriverKind.make(grok ? "grok-bot" : "muse-agent"),
              enabled: true,
              config: { accountBinding: binding },
            },
          },
        }),
      ),
    );
    const state = {
      binding,
      signedOut: false,
      storeDown: false,
      rotateDuringProjection: false,
      recordPresent: true,
      accountReads: 0,
      grokLookups: 0,
      grokState: "prepared" as GrokStore.StoredGrokBotTurn["state"],
    };
    const account = Effect.suspend(() =>
      state.signedOut
        ? Effect.fail(new Native.MuseAgentRuntimeError({ kind: "account_changed" }))
        : Effect.sync(() => {
            state.accountReads++;
            return state.binding;
          }),
    );
    const record: GrokStore.StoredGrokBotTurn = {
      identity: grokBotTurnIdentity(grokTurn),
      state: "prepared",
      delivery: null,
      workflowId: null,
      echoEntryId: null,
      outcome: null,
      settledAtMs: null,
    };
    const validator = yield* Validator.McpRemoteRunValidator.pipe(
      Effect.provide(
        Authority.layer.pipe(
          Layer.provide(
            Layer.succeed(
              Native.MuseAgentNativeRuntimeService,
              makeNative({ accountBinding: account }),
            ),
          ),
          Layer.provide(
            Layer.succeed(
              GrokNative.GrokBotNativeRuntimeService,
              GrokFixture.makeNative({ accountBinding: Effect.sync(() => state.binding) }),
            ),
          ),
          Layer.provide(
            Layer.mock(GrokStore.GrokBotManagedStateStore)({
              lookupTurn: () =>
                Effect.sync(() => {
                  state.grokLookups++;
                  return state.recordPresent ? { ...record, state: state.grokState } : undefined;
                }),
            }),
          ),
          Layer.provide(Layer.succeed(Settings.ServerSettingsService, settings)),
          Layer.provide(
            Layer.succeed(Projections.ProjectionStoreV2, {
              ...projections,
              getThreadShell: (threadId) =>
                Effect.suspend(() =>
                  state.storeDown
                    ? Effect.fail(
                        new Projections.ProjectionStoreReadError({
                          threadId,
                          cause: new Error("synthetic unavailable store"),
                        }),
                      )
                    : projections.getThreadShell(threadId),
                ),
              getThreadRecords: (...args) =>
                projections.getThreadRecords(...args).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (state.rotateDuringProjection) state.binding = "b".repeat(64);
                    }),
                  ),
                ),
            }),
          ),
        ),
      ),
    );
    const scope: McpThreadInvocationScope = {
      environmentId: EnvironmentId.make("authority-test"),
      issuedAt: 0,
      requestNamespace: "authority-fixture",
      capabilities: new Set(["orchestration"]),
      client: undefined,
      thread: {
        threadId: id,
        providerInstanceId: turn.modelSelection.instanceId,
        providerSessionId: "observer-credential",
        remoteRun: { runId: run.id, attemptId: turn.attemptId },
      },
    };
    let sequence = 0;
    return {
      validator,
      state,
      settings,
      projections,
      thread,
      run,
      scope,
      at,
      updateRun: (patch: Partial<OrchestrationV2Run>) =>
        projections.apply({
          id: EventId.make(`authority:run:${++sequence}`),
          type: "run.updated",
          threadId: id,
          occurredAt: at,
          payload: { ...run, ...patch },
        }),
    };
  });

it.effect(
  "Muse grants require the exact active run and attempt, and survive only host credential rotation",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      for (const status of ["starting", "running", "waiting"] as const) {
        yield* h.updateRun({ status });
        assert.equal(yield* h.validator.validate(h.scope), true);
      }
      assert.equal(
        yield* h.validator.validate({
          ...h.scope,
          thread: { ...h.scope.thread, providerSessionId: "reconstructed-host-session" },
        }),
        true,
      );
      for (const thread of [
        { ...h.scope.thread, threadId: ThreadId.make("muse-agent:foreign-thread") },
        { ...h.scope.thread, providerInstanceId: ProviderInstanceId.make("foreign-provider") },
        {
          ...h.scope.thread,
          remoteRun: { runId: RunId.make("foreign-run"), attemptId: h.run.activeAttemptId! },
        },
        {
          ...h.scope.thread,
          remoteRun: { runId: h.run.id, attemptId: RunAttemptId.make("foreign-attempt") },
        },
        {
          threadId: h.scope.thread.threadId,
          providerInstanceId: h.scope.thread.providerInstanceId,
          providerSessionId: h.scope.thread.providerSessionId,
        },
      ])
        assert.equal(yield* h.validator.validate({ ...h.scope, thread }), false);
      yield* h.updateRun({ id: RunId.make("newer-muse-run"), ordinal: 2, status: "running" });
      assert.equal(yield* h.validator.validate(h.scope), false);
      assert.equal(h.state.grokLookups, 0);
    }),
);

it.effect(
  "Muse grants are fenced by native account changes, sign-out, provider disable and deletion",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      assert.equal(yield* h.validator.validate(h.scope), true);
      h.state.binding = "b".repeat(64);
      assert.equal(yield* h.validator.validate(h.scope), false);
      h.state.binding = binding;
      h.state.signedOut = true;
      assert.equal(yield* h.validator.validate(h.scope), false);
      h.state.signedOut = false;
      yield* h.settings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("muse-agent"),
          enabled: false,
          config: { accountBinding: binding },
        },
      });
      const reads = h.state.accountReads;
      assert.equal(yield* h.validator.validate(h.scope), false);
      yield* h.settings.updateProviderInstance({ operation: "remove", instanceId });
      assert.equal(yield* h.validator.validate(h.scope), false);
      assert.equal(h.state.accountReads, reads);
    }),
);

it.effect(
  "a new attempt, settled run, archived or deleted thread cannot retain Muse authority",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      yield* h.updateRun({ activeAttemptId: RunAttemptId.make("replacement-attempt") });
      assert.equal(yield* h.validator.validate(h.scope), false);
      for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
        yield* h.updateRun({ status });
        assert.equal(yield* h.validator.validate(h.scope), false);
      }
      yield* h.updateRun({ status: "running" });
      yield* h.projections.apply({
        id: EventId.make("authority:archive"),
        type: "thread.archived",
        threadId: h.thread.id,
        occurredAt: h.at,
        payload: { ...h.thread, archivedAt: h.at },
      });
      assert.equal(yield* h.validator.validate(h.scope), false);
      yield* h.projections.apply({
        id: EventId.make("authority:delete"),
        type: "thread.deleted",
        threadId: h.thread.id,
        occurredAt: h.at,
        payload: { ...h.thread, deletedAt: h.at },
      });
      assert.equal(yield* h.validator.validate(h.scope), false);
    }),
);

it.effect(
  "Muse authority fails closed on unavailable storage and substituted model selections",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      h.state.storeDown = true;
      assert.equal(yield* h.validator.validate(h.scope), false);
      h.state.storeDown = false;
      yield* h.updateRun({
        modelSelection: { instanceId: ProviderInstanceId.make("other-instance"), model: "muse" },
      });
      assert.equal(yield* h.validator.validate(h.scope), false);
      yield* h.updateRun({ modelSelection: { instanceId, model: "muse-code" } });
      assert.equal(yield* h.validator.validate(h.scope), false);
      yield* h.updateRun({});
      yield* h.projections.apply({
        id: EventId.make("authority:thread-selection"),
        type: "thread.model-selection-updated",
        threadId: h.thread.id,
        occurredAt: h.at,
        payload: { ...h.thread, modelSelection: { instanceId, model: "muse-code" } },
      });
      assert.equal(yield* h.validator.validate(h.scope), false);
    }),
);

it.effect("an account change while reading the committed run cannot admit a Muse tool", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    h.state.rotateDuringProjection = true;
    assert.equal(yield* h.validator.validate(h.scope), false);
    assert.equal(h.state.grokLookups, 0);
  }),
);

it.effect("the shared validator preserves Grok managed-delivery and account fencing", () =>
  Effect.gen(function* () {
    const h = yield* fixture(true);
    for (const state of ["prepared", "uncertain", "accepted"] as const) {
      h.state.grokState = state;
      assert.equal(yield* h.validator.validate(h.scope), true);
    }
    assert.equal(h.state.grokLookups, 3);
    assert.equal(h.state.accountReads, 0);
    h.state.binding = "b".repeat(64);
    assert.equal(yield* h.validator.validate(h.scope), false);
    h.state.binding = binding;
    h.state.recordPresent = false;
    assert.equal(yield* h.validator.validate(h.scope), false);
    h.state.recordPresent = true;
    h.state.grokState = "settled";
    assert.equal(yield* h.validator.validate(h.scope), false);
    h.state.grokState = "accepted";
    yield* h.updateRun({ activeAttemptId: RunAttemptId.make("grok-retry") });
    assert.equal(yield* h.validator.validate(h.scope), false);
    yield* h.settings.updateProviderInstance({
      operation: "upsert",
      instanceId: h.scope.thread.providerInstanceId,
      instance: { driver: ProviderDriverKind.make("grok-bot"), enabled: false },
    });
    const lookups = h.state.grokLookups;
    assert.equal(yield* h.validator.validate(h.scope), false);
    assert.equal(h.state.grokLookups, lookups);
  }),
);

it.effect.each([undefined, "side:session/42"])(
  "rebinding native and provider accounts cannot revive an old Muse grant (%s)",
  (sessionId) =>
    Effect.gen(function* () {
      const h = yield* fixture(false, sessionId);
      assert.equal(yield* h.validator.validate(h.scope), true);
      h.state.binding = "b".repeat(64);
      yield* h.settings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("muse-agent"),
          enabled: true,
          config: { accountBinding: h.state.binding },
        },
      });
      for (const status of ["running", "waiting"] as const) {
        yield* h.updateRun({ status });
        assert.equal(yield* h.validator.validate(h.scope), false);
      }
    }),
);
