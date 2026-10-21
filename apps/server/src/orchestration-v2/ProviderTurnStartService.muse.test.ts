import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { expect, it } from "@effect/vitest";
import {
  ContextHandoffId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Result from "effect/Result";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import { MuseAgentCapabilitiesV2 } from "./Adapters/MuseAgentAdapterV2.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const makeHarness = (
  mode: "refused" | "uncertain" | "accepted",
  previousFailure = false,
  resumeFailure = false,
) => {
  const now = DateTime.makeUnsafe("2026-10-13T12:00:00Z");
  const threadId = ThreadId.make("muse-handoff-thread");
  const runId = RunId.make("muse-handoff-run");
  const instanceId = ProviderInstanceId.make("muse-personal");
  const providerThreadId = ProviderThreadId.make("muse-handoff-provider-thread");
  const sessionId = ProviderSessionId.make("muse-handoff-session");
  const attemptId = RunAttemptId.make("muse-handoff-attempt");
  const rootNodeId = NodeId.make("muse-handoff-root");
  const messageId = MessageId.make("muse-handoff-message");
  const driver = ProviderDriverKind.make("muse-agent");
  // The service reads only startup and runtime recovery fields from this fixture.
  let projection = {
    thread: { id: threadId, title: "Muse", branch: null, worktreePath: null },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "muse" },
        providerThreadId,
        userMessageId: messageId,
        rootNodeId,
        activeAttemptId: attemptId,
        status: "starting",
        startedAt: null,
        requestedAt: now,
        completedAt: null,
        contextHandoffId: null,
        checkpointId: null,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId: "muse-scope", status: "pending" }],
    attempts: [{ id: attemptId, runId, providerThreadId, status: "pending" }],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { nativeId: "native-muse-session", driver, strength: "strong" },
        contextUsage: { usedTokens: 0, maxTokens: 128000 },
        handoffIds: [],
        forkedFrom: null,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ],
    messages: [{ id: messageId, text: "Continue", attachments: [], role: "user" }],
    checkpointScopes: [{ id: "muse-scope" }],
    contextHandoffs: [
      {
        id: ContextHandoffId.make("muse-inline-handoff"),
        threadId,
        targetRunId: runId,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThreadId,
        coveredRunOrdinals: { from: 1, to: 1 },
        status: "ready",
        strategy: "full_thread_summary",
        summaryMessageId: null,
        summaryText: "Keep the earlier verified result.",
        createdByProviderInstanceId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    contextTransfers: [],
    providerSessions: [],
    providerTurns: [],
    subagents: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  if (previousFailure) {
    const current = projection.runs[0]!;
    const failedId = RunId.make("muse-previous-failed-run");
    projection = {
      ...projection,
      runs: [
        { ...current, id: failedId, ordinal: 1, status: "failed" },
        { ...current, ordinal: 2 },
      ],
      contextHandoffs: projection.contextHandoffs.map((handoff) => ({
        ...handoff,
        targetRunId: failedId,
        strategy: "delta_since_target_last_seen",
      })),
    };
  }
  const persisted: Array<OrchestrationV2DomainEvent> = [];
  const prompts: string[] = [];
  let turnResult: Result.Result<void, ProviderAdapter.ProviderAdapterV2Error> | undefined;
  const session = {
    driver,
    providerSession: {
      id: sessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: null,
      model: "muse",
      capabilities: MuseAgentCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    resumeThread: () =>
      resumeFailure
        ? Effect.fail(
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver,
              threadId,
              providerThreadId,
              runId,
              cause: new Error("observer disconnected"),
            }),
          )
        : Effect.succeed(projection.providerThreads[0]!),
    ensureThread: () => Effect.succeed(projection.providerThreads[0]!),
    startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.gen(function* () {
        // The pending intent is durable before the adapter can receive the prompt.
        expect(projection.contextHandoffs[0]?.delivery?.status).toBe(
          previousFailure ? undefined : "pending",
        );
        prompts.push(input.message.text);
        if (mode === "accepted") return;
        const failure = new Error(
          mode === "refused" ? "direct-tool authority denied" : "connection lost after admission",
        );
        return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
          driver,
          threadId,
          providerThreadId,
          runId,
          cause:
            mode === "refused"
              ? new ProviderAdapter.ProviderPromptNotSubmittedError({ cause: failure })
              : failure,
        });
      }),
  };
  const applyEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
    for (const event of events) {
      persisted.push(event);
      projection = ProjectionStore.applyToProjection(projection, event);
    }
  };
  const dependencies = Layer.mergeAll(
    IdAllocator.layer,
    FileSystem.layerNoop({}),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ProviderAuthService.ProviderAuthService)({}),
    Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: () => Effect.sync(() => projection),
      getTurnStartContext: () => Effect.sync(() => ({ ...projection, hasConversation: true })),
      getRuntimeRecoveryProjection: () => Effect.sync(() => projection),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      open: () =>
        Effect.succeed(session as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
    }),
    Layer.mock(RuntimePolicy.RuntimePolicyV2)({
      resolve: () =>
        Effect.succeed({ cwd: null, runtimeMode: "full-access", interactionMode: "default" }),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      write: ({ events }) =>
        Effect.sync(() => {
          applyEvents(events);
          return [];
        }),
      writeIfRunCurrent: ({ events }) =>
        Effect.sync(() => {
          applyEvents(events);
          return { committed: true, storedEvents: [] };
        }),
    }),
    Layer.mock(RunExecutionService.RunExecutionServiceV2)({
      startRootRun: (input) =>
        Effect.gen(function* () {
          turnResult = yield* Effect.result(
            input.session.startTurn({
              appThread: input.appThread,
              threadId,
              runId,
              runOrdinal: input.run.ordinal,
              attemptId,
              rootNodeId,
              providerTurnOrdinal: input.providerTurnOrdinal,
              providerThread: input.providerThread,
              message: input.message,
              modelSelection: input.modelSelection,
              runtimePolicy: input.runtimePolicy,
            }),
          );
        }),
    }),
  );
  return {
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(
      Effect.provide(
        ProviderTurnStart.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              dependencies,
              ServerSettings.layerTest(),
              ServerConfig.layerTest("/repo", "/tmp/t3-muse-turn-start").pipe(
                Layer.provide(NodeServices.layer),
              ),
              NodeServices.layer,
            ),
          ),
        ),
      ),
    ),
    handoff: () => projection.contextHandoffs[0]!,
    deliveryWrites: () =>
      persisted.flatMap((event) =>
        event.type === "context-handoff.updated" ? [event.payload.delivery?.status] : [],
      ),
    turnResult: () => turnResult,
    prompts,
  };
};

it.effect("restores an inline handoff after Muse refuses direct tools before admission", () =>
  Effect.gen(function* () {
    const harness = makeHarness("refused");
    yield* harness.start;
    expect(harness.turnResult()?._tag).toBe("Failure");
    expect(harness.deliveryWrites()).toEqual(["pending", undefined]);
    expect(harness.handoff().delivery).toBeUndefined();
    expect(harness.handoff().status).toBe("ready");
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain("Keep the earlier verified result.");
  }),
);

it.effect("keeps an ambiguous admitted Muse handoff pending instead of making it replayable", () =>
  Effect.gen(function* () {
    const harness = makeHarness("uncertain");
    yield* harness.start;
    expect(harness.turnResult()?._tag).toBe("Failure");
    expect(harness.deliveryWrites()).toEqual(["pending"]);
    expect(harness.handoff().delivery).toMatchObject({
      nativeThreadId: "native-muse-session",
      status: "pending",
    });
    expect(harness.prompts).toHaveLength(1);
  }),
);

it.effect("records an inline handoff only after Muse accepts its prompt", () =>
  Effect.gen(function* () {
    const harness = makeHarness("accepted");
    yield* harness.start;
    expect(harness.turnResult()?._tag).toBe("Success");
    expect(harness.deliveryWrites()).toEqual(["pending", "inline"]);
    expect(harness.handoff().delivery).toMatchObject({
      nativeThreadId: "native-muse-session",
      status: "inline",
    });
    expect(harness.prompts).toHaveLength(1);
  }),
);

it.effect("sends only the new message after a failed Muse turn", () =>
  Effect.gen(function* () {
    const harness = makeHarness("accepted", true);
    yield* harness.start;
    expect(harness.turnResult()?._tag).toBe("Success");
    expect(harness.prompts).toEqual(["Continue"]);
    expect(harness.deliveryWrites()).toEqual([]);
  }),
);

it.effect("reattaches Muse without injecting a local recovery transcript", () =>
  Effect.gen(function* () {
    const harness = makeHarness("accepted", true, true);
    yield* harness.start;
    expect(harness.turnResult()?._tag).toBe("Success");
    expect(harness.prompts).toEqual(["Continue"]);
    expect(harness.deliveryWrites()).toEqual([]);
  }),
);
