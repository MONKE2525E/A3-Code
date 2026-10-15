import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type NativeAgentError,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Service from "./NativeAgentService.ts";
import * as Native from "../museAgent/MuseAgentNativeRuntimeService.ts";
import * as Transport from "../museAgent/MuseAgentTransport.ts";
import * as CredentialInbox from "../museAgent/MuseAgentCredentialInbox.ts";
import * as Features from "../museAgent/MuseAgentFeatureService.ts";
import * as Connectors from "../museAgent/MuseAgentConnectorService.ts";
import * as Computer from "../museAgent/MuseAgentComputerService.ts";
import * as Dictation from "../museAgent/MuseAgentDictation.ts";
import * as DirectToolsPort from "../museAgent/MuseAgentDirectToolsPort.ts";
import * as Grok from "../grokBot/GrokBotThreadService.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Mutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Search from "../orchestration-v2/ThreadSearch.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import type { MuseAgentPendingDelivery } from "../museAgent/MuseAgentDeliveryOwnership.ts";
import { createMuseAgentAdapterV2 } from "../orchestration-v2/Adapters/MuseAgentAdapterV2.ts";
import {
  binding,
  instanceId,
  options,
  makeNative,
  host,
} from "../orchestration-v2/Adapters/MuseAgentAdapterV2.testkit.ts";

const reference = {
  source: "muse-agent",
  agentId: "muse",
  providerInstanceId: instanceId,
} as const;
const snapshot = (id = instanceId): ServerProvider => ({
  instanceId: id,
  driver: ProviderDriverKind.make("muse-agent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});
const fixture = (
  input: {
    disabled?: boolean;
    configured?: ProviderInstanceConfigMap;
    computerLayer?: Layer.Layer<Computer.MuseAgentComputerService>;
  } = {},
) =>
  Effect.gen(function* () {
    const dictationStarted = yield* Deferred.make<void>();
    const archiveWritten = yield* Deferred.make<void>();
    const archiveContinue = yield* Deferred.make<void>();
    const state = {
      binding,
      avatarImagePath: "workspace/avatars/synthetic/image.png",
      credentialCalls: [] as Array<{
        method: string;
        params: Record<string, unknown>;
        write: boolean;
      }>,
      reads: 0,
      historyPages: false,
      rotateOnHistoryPage: false,
      historyCursors: [] as Array<number | undefined>,
      watches: 0,
      watchFailure: null as "busy" | "unsupported" | null,
      accountReads: 0,
      writes: 0,
      refreshes: 0,
      rotateOnRefresh: false,
      rotateOnResolve: false,
      rotateOnProfile: false,
      avatarReads: [] as string[],
      computerCalls: [] as Array<{
        kind: string;
        binding: string;
        sessionId: string;
        taskId: string;
        action?: string;
      }>,
      computerPreviewBytes: new Uint8Array([1, 2, 3]),
      computerReadOnly: false,
      forbidChatResolution: false,
      computerStreamInputs: [] as Uint8Array[],
      computerStreamClosed: 0,
      dictationCalls: [] as Array<{ pcm: Uint8Array; language?: string }>,
      dictationText: "Synthetic transcript",
      dictationFailure: null as Dictation.MuseAgentDictationError["kind"] | null,
      rotateOnDictation: false,
      dictationNever: false,
      dictationStarted,
      featureCalls: [] as string[],
      primarySessionId: "primary",
      archiveCalls: [] as Array<{ binding: string; sessionId: string; archived: boolean }>,
      nativeArchived: false,
      failArchiveSync: false,
      archiveSyncFailed: false,
      failArchiveRecovery: false,
      pauseArchive: false,
      archiveWritten,
      archiveContinue,
      reconciled: [] as ProviderInstanceConfigMap[],
      snapshots: [snapshot()],
      pending: [] as MuseAgentPendingDelivery[],
      releases: [] as string[],
      closed: [] as ProviderSessionId[],
      closeAllowed: true,
      rotateAfterClose: false,
      pretendTerminalShell: false,
      failRenameSync: false,
      rotateOnRename: false,
      nativeTitle: "Research",
    };
    const native = makeNative({
      status: Effect.sync(() => ({
        installed: true,
        sessionPresent: true,
        ready: true,
        message: "Synthetic session",
        accountBinding: state.binding,
      })),
      accountBinding: Effect.sync(() => {
        state.accountReads++;
        return state.binding;
      }),
      setup: Effect.sync(() => ({
        installed: true,
        sessionPresent: true,
        ready: true,
        message: "Synthetic session",
        accountBinding: state.binding,
      })),
      profile: () =>
        Effect.sync(() => {
          if (state.rotateOnProfile) state.binding = "b".repeat(64);
          return {
            id: "muse" as const,
            name: "Synthetic Muse",
            avatarImagePath: state.avatarImagePath,
            avatarVideoVariants: { idle: "workspace/avatars/synthetic/idle.mp4" },
          };
        }),
      sessions: () =>
        Effect.sync(() => [
          {
            session_id: state.primarySessionId,
            status: "idle",
            is_primary: true,
            is_thread: false,
          },
          {
            session_id: "side-one",
            status: "idle",
            is_primary: false,
            is_thread: true,
            archived: state.nativeArchived,
          },
          {
            session_id: "readonly-side",
            status: "idle",
            is_primary: false,
            is_thread: true,
            can_send_messages: false,
          },
        ]),
      resolveSession: (_binding, sessionId) =>
        Effect.suspend(() => {
          if (state.forbidChatResolution)
            return Effect.die("Computer ownership must not use chat sendability.");
          return Effect.sync(() => {
            if (state.rotateOnResolve) state.binding = "b".repeat(64);
            if (sessionId !== undefined && sessionId !== "primary")
              return {
                session_id: sessionId,
                status: "idle",
                is_primary: false,
                is_thread: true,
                title: "Side research",
              };
            return {
              session_id: "primary",
              status: "idle",
              is_primary: !state.computerReadOnly,
              is_thread: state.computerReadOnly,
            };
          });
        }),
      read: ({ beforeSeq }) =>
        Effect.sync(() => {
          state.reads++;
          state.historyCursors.push(beforeSeq);
          if (beforeSeq !== undefined && state.rotateOnHistoryPage) state.binding = "b".repeat(64);
          if (state.historyPages)
            return {
              events: [
                {
                  event_name: "message.user",
                  seq: beforeSeq === undefined ? 10 : 0,
                  occurred_at_ms: beforeSeq === undefined ? 1234 : 1,
                  message_id: beforeSeq === undefined ? "page-recent-user" : "page-older-user",
                  payload: {
                    display_text:
                      beforeSeq === undefined
                        ? "Synthetic recent history"
                        : "Synthetic paginated history",
                  },
                },
              ],
              hasMore: beforeSeq === undefined,
            };
          return {
            events: [
              {
                event_name: "message.user",
                seq: 1,
                occurred_at_ms: 1234,
                message_id: "history-user",
                payload: { display_text: "native quokka-ledger history" },
              },
            ],
            hasMore: false,
          };
        }),
      watch: () =>
        Effect.suspend(() => {
          state.watches++;
          return state.watchFailure === null
            ? Effect.succeed({ events: Stream.never, close: Effect.void })
            : Effect.fail(new Native.MuseAgentRuntimeError({ kind: state.watchFailure }));
        }),
      send: () => Effect.die("Viewing a native agent must not send a message."),
      pendingDeliveries: () => Effect.sync(() => state.pending),
      releaseLocalOwnership: (input) =>
        Effect.sync(() => {
          state.releases.push(input.deliveryKey);
          state.pending = state.pending.filter(
            (delivery) => delivery.deliveryKey !== input.deliveryKey,
          );
        }),
      stop: () => Effect.die("Releasing local tracking must never cancel native execution."),
    });
    const adapter = yield* createMuseAgentAdapterV2(options).pipe(
      Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
      Effect.provideService(ProviderHost.ProviderHost, host),
      Effect.provide(DirectToolsPort.layer),
    );
    const database = Sqlite.layerMemory;
    const runtime = Layer.mergeAll(
      Harness.layerWithRegistry({ name: "native-facade" }, Registry.layerFromAdapters([adapter]), {
        databaseLayer: database,
        runEffectWorker: false,
      }),
      Projections.layer.pipe(Layer.provide(database)),
      Projects.layer.pipe(Layer.provide(database)),
      Search.layer.pipe(Layer.provide(database)),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const context = yield* Layer.build(runtime);
    const orchestrator = Context.get(context, Orchestrator.OrchestratorV2);
    const projections = Context.get(context, Projections.ProjectionStoreV2);
    const projects = Context.get(context, Projects.ProjectStoreV2);
    const sessions = Context.get(context, Sessions.ProviderSessionManagerV2);
    const search = Context.get(context, Search.ThreadSearch);
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "native-agent-facade-" });
    const projectId = ProjectId.make("native-agent-scratch");
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("scratch-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-10T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Scratch",
        workspaceRoot: cwd,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
      },
    });
    const settingsContext = yield* Layer.build(
      Settings.layerTest({
        providerInstances: input.configured ?? {
          [instanceId]: {
            driver: "muse-agent",
            enabled: !input.disabled,
            config: { accountBinding: binding },
          },
        },
      }),
    );
    const settings = Context.get(settingsContext, Settings.ServerSettingsService);
    const inbox = yield* CredentialInbox.MuseAgentCredentialInbox.pipe(
      Effect.provide(CredentialInbox.layer),
    );
    const service = yield* Service.NativeAgentService.pipe(
      Effect.provide(
        Service.layer.pipe(
          Layer.provide(Layer.succeed(CredentialInbox.MuseAgentCredentialInbox, inbox)),
          Layer.provide(Layer.succeed(Native.MuseAgentNativeRuntimeService, native)),
          Layer.provide(
            Layer.succeed(Settings.ServerSettingsService, {
              ...settings,
              updateProviderInstance: (...args) =>
                settings.updateProviderInstance(...args).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      state.writes++;
                    }),
                  ),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(Transport.MuseAgentTransport)({
              request: (_binding, method, params, write = false) =>
                Effect.sync(() => {
                  state.credentialCalls.push({ method, params, write });
                  return { id: "stored-credential" };
                }),
              readAvatar: (account, path) =>
                Effect.sync(() => {
                  assert.equal(account, state.binding);
                  state.avatarReads.push(path);
                  return { bytes: new Uint8Array([1, 2]), contentType: "image/png" as const };
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(Features.MuseAgentFeatureService)({
              setSessionArchived: (binding, sessionId, archived) =>
                Effect.gen(function* () {
                  state.archiveCalls.push({ binding, sessionId, archived });
                  if (!archived && state.failArchiveRecovery)
                    return yield* new Features.MuseAgentFeatureError({
                      feature: "sessions",
                      code: "unavailable",
                    });
                  state.nativeArchived = archived;
                  state.archiveSyncFailed = archived && state.failArchiveSync;
                  if (archived && state.pauseArchive) {
                    yield* Deferred.succeed(archiveWritten, undefined);
                    yield* Deferred.await(archiveContinue);
                  }
                }),
              renameSession: (_binding, _sessionId, title) =>
                Effect.sync(() => {
                  state.nativeTitle = title.trim();
                  if (state.rotateOnRename) state.binding = "b".repeat(64);
                  return { title: state.nativeTitle };
                }),
              tasks: (account) =>
                Effect.sync(() => {
                  state.featureCalls.push(account);
                  return [];
                }),
              deleteTask: (account, id) =>
                Effect.sync(() => {
                  state.featureCalls.push(`${account}:${id}`);
                }),
            }),
          ),
          Layer.provide(Layer.mock(Connectors.MuseAgentConnectorService)({})),
          Layer.provide(
            Layer.mock(Dictation.MuseAgentDictation)({
              status: Effect.succeed({
                available: true,
                engineDetected: true,
                modelDetected: true,
                local: true as const,
                sampleRateHz: 24000 as const,
                maxAudioSeconds: 60 as const,
                reason: "ready" as const,
              }),
              transcribe: (input) =>
                Effect.suspend(() => {
                  state.dictationCalls.push(input);
                  if (state.dictationNever)
                    return Deferred.succeed(state.dictationStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    );
                  if (state.rotateOnDictation) state.binding = "b".repeat(64);
                  return state.dictationFailure
                    ? Effect.fail(
                        new Dictation.MuseAgentDictationError({
                          kind: state.dictationFailure,
                          cause: new Error("synthetic-private-account-secret"),
                        }),
                      )
                    : Effect.succeed({ text: state.dictationText });
                }),
            }),
          ),
          Layer.provide(
            input.computerLayer ??
              Layer.mock(Computer.MuseAgentComputerService)({
                readTask: (scope) =>
                  Effect.sync(() => {
                    state.computerCalls.push({ ...scope, kind: "read" });
                    return {
                      task: {
                        taskId: scope.taskId,
                        sessionId: scope.sessionId,
                        title: "Synthetic task",
                        readOnly: false,
                        previewAvailable: true,
                      },
                      state: {
                        sessionId: scope.sessionId,
                        presentedTaskId: scope.taskId,
                        lease: null,
                        activeTab: null,
                        deviceClipboardSupported: false,
                      },
                      preview: {
                        taskId: scope.taskId,
                        sha256: "a".repeat(64),
                        width: 640,
                        height: 480,
                        updatedAtMs: 1,
                      },
                    };
                  }),
                operate: (scope, command) =>
                  Effect.sync(() => {
                    state.computerCalls.push({ ...scope, kind: "operate", action: command.action });
                    return { action: "viewer" as const };
                  }),
                openStream: (scope) =>
                  Effect.gen(function* () {
                    let closed = false;
                    const close = Effect.sync(() => {
                      if (!closed) {
                        closed = true;
                        state.computerStreamClosed++;
                      }
                    });
                    yield* Effect.addFinalizer(() => close);
                    state.computerCalls.push({ ...scope, kind: "stream" });
                    return {
                      events: Stream.never,
                      send: (data: Uint8Array) =>
                        Effect.sync(() => {
                          state.computerStreamInputs.push(data);
                        }),
                      close,
                    };
                  }),
                preview: (scope) =>
                  Effect.sync(() => {
                    state.computerCalls.push({ ...scope, kind: "preview" });
                    return { bytes: state.computerPreviewBytes, contentType: "image/png" as const };
                  }),
              }),
          ),
          Layer.provide(
            Layer.mock(Grok.GrokBotThreadService)({
              open: () => Effect.die("Muse must not route through Grok."),
            }),
          ),
          Layer.provide(
            Layer.mock(Providers.ProviderRegistry)({
              getProviders: Effect.sync(() => state.snapshots),
              refreshInstance: () =>
                Effect.sync(() => {
                  state.refreshes++;
                  if (state.rotateOnRefresh) state.binding = "b".repeat(64);
                  return state.snapshots;
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(Mutator.ProviderInstanceRegistryMutator)({
              reconcile: (config) =>
                Effect.sync(() => {
                  state.reconciled.push(config);
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(Folders.ManagedProjectFolders)({
              namedProjectsRoot: cwd,
              ensureNativeAgentProject: Effect.succeed({ projectId }),
            }),
          ),
          Layer.provide(Layer.succeed(Orchestrator.OrchestratorV2, orchestrator)),
          Layer.provide(
            Layer.succeed(Projections.ProjectionStoreV2, {
              ...projections,
              getThreadShell: (threadId) =>
                (state.failRenameSync || state.archiveSyncFailed
                  ? Effect.fail(new Projections.ProjectionStoreReadError({ threadId }))
                  : projections.getThreadShell(threadId)
                ).pipe(
                  Effect.map((thread) =>
                    thread && state.pretendTerminalShell
                      ? {
                          ...thread,
                          activeRunId: null,
                          activityRunStatus: null,
                          status: "completed" as const,
                        }
                      : thread,
                  ),
                ),
            }),
          ),
          Layer.provide(Layer.succeed(Projects.ProjectStoreV2, projects)),
          Layer.provide(
            Layer.succeed(Sessions.ProviderSessionManagerV2, {
              ...sessions,
              closeNativeDeliverySession: (input) =>
                state.closeAllowed
                  ? sessions.closeNativeDeliverySession(input).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          state.closed.push(input.runtime.providerSessionId);
                          if (state.rotateAfterClose) state.binding = "b".repeat(64);
                        }),
                      ),
                    )
                  : Effect.succeed(false),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    return { service, state, settings, orchestrator, projections, sessions, search, inbox };
  });

it.effect(
  "loads older history into the canonical thread without sending or subscribing again",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      h.state.historyPages = true;
      const opened = yield* h.service.open(reference);
      const initial = yield* h.service.featureRead({
        providerInstanceId: instanceId,
        operation: "history_page",
        threadId: opened.threadId,
      });
      assert.deepEqual(initial, {
        operation: "history_page",
        data: { nextBeforeSeq: 10, hasMore: true, importedMessages: 0 },
      });
      const page = yield* h.service.featureUpdate({
        providerInstanceId: instanceId,
        operation: "history_page",
        threadId: opened.threadId,
        beforeSeq: 10,
      });
      assert.deepEqual(page, {
        updated: true,
        historyPage: { nextBeforeSeq: 0, hasMore: false, importedMessages: 1 },
      });
      yield* h.orchestrator
        .streamStoredEventsFrom({ threadId: opened.threadId, eventType: "turn-item.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "turn-item.updated" &&
              stored.event.payload.canonicalNativeSequence === 0,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      const projection = yield* h.orchestrator.getThreadProjection(opened.threadId);
      const texts = projection.turnItems
        .filter((item) => item.type === "user_message")
        .map((item) => item.text);
      assert.deepEqual(texts, ["Synthetic paginated history", "Synthetic recent history"]);
      assert.equal(h.state.watches, 1);
      assert.deepEqual(h.state.historyCursors, [undefined, 10]);
      assert.equal(projection.runs.length, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("history read refuses foreign or unopened threads instead of creating an observer", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const error = yield* h.service
      .featureRead({
        providerInstanceId: instanceId,
        operation: "history_page",
        threadId: ThreadId.make("foreign-thread"),
      })
      .pipe(Effect.flip);
    assert.equal(error.reason, "thread_changed");
    assert.equal(h.state.watches, 0);
    assert.equal(h.state.reads, 0);
    assert.deepEqual((yield* h.orchestrator.getShellSnapshot()).threads, []);
    const opened = yield* h.service.open(reference);
    yield* h.sessions.close(
      ProviderSessionId.make(`provider-session:muse-agent-observe:${opened.threadId}`),
    );
    const unavailable = yield* h.service
      .featureRead({
        providerInstanceId: instanceId,
        operation: "history_page",
        threadId: opened.threadId,
      })
      .pipe(Effect.flip);
    assert.equal(unavailable.reason, "provider_unavailable");
    assert.equal(h.state.watches, 1);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "opening Muse immediately imports searchable native history without starting a turn and reuses observation",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      assert.deepEqual((yield* h.search.search({ query: "quokka-ledger" })).matches, []);
      const opened = yield* h.service.open(reference);
      yield* h.orchestrator
        .streamStoredEventsFrom({ threadId: opened.threadId, eventType: "message.updated" })
        .pipe(Stream.take(1), Stream.runDrain);
      assert.deepEqual(
        (yield* h.search.search({ query: "quokka-ledger" })).matches.map((match) => [
          match.threadId,
          match.source,
        ]),
        [[opened.threadId, "user"]],
      );
      assert.equal((yield* h.orchestrator.getThreadProjection(opened.threadId)).runs.length, 0);
      assert.deepEqual(yield* h.service.open(reference), opened);
      assert.equal(h.state.reads, 1);
      assert.equal(h.state.watches, 1);
      yield* h.sessions.close(
        ProviderSessionId.make(`provider-session:muse-agent-observe:${opened.threadId}`),
      );
      yield* h.service.open(reference);
      assert.equal(h.state.watches, 2);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each([undefined, "side-one"])(
  "surfaces observer attach failure for %s and allows a later canonical reopen",
  (sessionId) =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const target = { ...reference, ...(sessionId === undefined ? {} : { sessionId }) };
      h.state.watchFailure = "busy";
      const failure = yield* Effect.flip(h.service.open(target));
      assert.equal(failure.reason, "provider_unavailable");
      assert.match(failure.message, /active Muse turn.*try again/);
      assert.equal(h.state.watches, 1);
      assert.equal(h.state.reads, 0);
      assert.deepEqual((yield* h.search.search({ query: "quokka-ledger" })).matches, []);
      const shells = (yield* h.orchestrator.getShellSnapshot()).threads;
      assert.equal(shells.length, 1);
      const threadId = shells[0]!.id;
      assert.equal(
        Option.isNone(
          yield* h.sessions.get(
            ProviderSessionId.make(`provider-session:muse-agent-observe:${threadId}`),
          ),
        ),
        true,
      );
      h.state.watchFailure = null;
      const opened = yield* h.service.open(target);
      assert.equal(opened.threadId, threadId);
      yield* h.orchestrator
        .streamStoredEventsFrom({ threadId, eventType: "message.updated" })
        .pipe(Stream.take(1), Stream.runDrain);
      assert.equal(h.state.watches, 2);
      assert.equal(h.state.reads, 1);
      assert.equal((yield* h.orchestrator.getThreadProjection(threadId)).runs.length, 0);
      assert.deepEqual(yield* h.service.open(target), opened);
      assert.equal(h.state.watches, 2);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const ownedDelivery = (
  h: Effect.Success<ReturnType<typeof fixture>>,
  status: "completed" | "running" = "completed",
) =>
  Effect.gen(function* () {
    const opened = yield* h.service.open(reference);
    const now = yield* DateTime.now;
    const runId = RunId.make("muse-recovery-run");
    const attemptId = RunAttemptId.make("muse-recovery-attempt");
    const nodeId = NodeId.make("muse-recovery-root");
    const providerThreadId = ProviderThreadId.make("muse-recovery-provider-thread");
    const providerTurnId = ProviderTurnId.make(`provider-turn/muse-agent/${attemptId}`);
    const userMessageId = MessageId.make("muse-recovery-user-message");
    const sessionId = ProviderSessionId.make(
      `provider-session:muse-agent-observe:${opened.threadId}`,
    );
    const events: OrchestrationV2DomainEvent[] = [
      {
        id: EventId.make("muse-recovery-provider-thread"),
        type: "provider-thread.updated",
        threadId: opened.threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: ProviderDriverKind.make("muse-agent"),
          providerInstanceId: instanceId,
          providerSessionId: sessionId,
          appThreadId: opened.threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: ProviderDriverKind.make("muse-agent"),
            nativeId: `${binding}/primary`,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make("muse-recovery-run"),
        type: "run.created",
        threadId: opened.threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: opened.threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "muse" },
          providerThreadId,
          userMessageId,
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status,
          requestedAt: now,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        id: EventId.make("muse-recovery-attempt"),
        type: "run-attempt.created",
        threadId: opened.threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId: null,
          reason: "initial",
          status,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      },
      {
        id: EventId.make("muse-recovery-node"),
        type: "node.updated",
        threadId: opened.threadId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId: opened.threadId,
          runId,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "root_turn",
          status,
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      },
      {
        id: EventId.make("muse-recovery-provider-turn"),
        type: "provider-turn.updated",
        threadId: opened.threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      },
    ];
    for (const event of events) yield* h.projections.apply(event);
    const context = {
      threadId: opened.threadId,
      providerInstanceId: instanceId,
      runId,
      nodeId,
      providerThreadId,
      providerTurnId,
      userMessageId,
    };
    h.state.pending = [{ deliveryKey: attemptId, status: "accepted", context }];
    return { opened, context, sessionId, attemptId };
  });

it.effect(
  "lists metadata only and releases verified terminal local tracking without native cancellation",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const owned = yield* ownedDelivery(h);
      const pending = yield* h.service.featureRead({
        providerInstanceId: instanceId,
        operation: "pending_deliveries",
      });
      assert.ok(pending.operation === "pending_deliveries");
      assert.deepEqual(pending.data, {
        sessionId: "primary",
        deliveries: [
          {
            deliveryKey: owned.attemptId,
            status: "accepted",
            threadId: owned.context.threadId,
            runId: owned.context.runId,
            releasable: true,
            blockedReason: null,
          },
        ],
      });
      assert.deepEqual(h.state.releases, []);
      assert.deepEqual(
        yield* h.service.featureUpdate({
          providerInstanceId: instanceId,
          operation: "delivery_release",
          sessionId: "primary",
          deliveryKey: owned.attemptId,
        }),
        { updated: true },
      );
      assert.deepEqual(h.state.releases, [owned.attemptId]);
      assert.deepEqual(h.state.closed, [owned.sessionId]);
      assert.isTrue(Option.isNone(yield* h.sessions.get(owned.sessionId)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("refuses an authoritative active run even when its shell claims completion", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const owned = yield* ownedDelivery(h, "running");
    h.state.pretendTerminalShell = true;
    const pending = yield* h.service.featureRead({
      providerInstanceId: instanceId,
      operation: "pending_deliveries",
    });
    assert.ok(pending.operation === "pending_deliveries");
    assert.strictEqual(pending.data.deliveries[0]?.blockedReason, "run_active");
    assert.strictEqual(
      (yield* Effect.flip(
        h.service.featureUpdate({
          providerInstanceId: instanceId,
          operation: "delivery_release",
          sessionId: "primary",
          deliveryKey: owned.attemptId,
        }),
      )).reason,
      "thread_active",
    );
    assert.deepEqual(h.state.releases, []);
    assert.deepEqual(h.state.closed, []);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "fails closed for legacy context and mismatched provider, thread, attempt, node and native session",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const owned = yield* ownedDelivery(h);
      const original = h.state.pending[0]!;
      const mutations: MuseAgentPendingDelivery[] = [
        { ...original, context: null },
        {
          ...original,
          context: { ...owned.context, providerInstanceId: ProviderInstanceId.make("wrong") },
        },
        { ...original, context: { ...owned.context, threadId: ThreadId.make("wrong") } },
        { ...original, deliveryKey: "wrong-attempt" },
        { ...original, context: { ...owned.context, nodeId: NodeId.make("wrong") } },
        {
          ...original,
          context: { ...owned.context, providerTurnId: ProviderTurnId.make("wrong") },
        },
      ];
      for (const delivery of mutations) {
        h.state.pending = [delivery];
        assert.strictEqual(
          (yield* Effect.flip(
            h.service.featureUpdate({
              providerInstanceId: instanceId,
              operation: "delivery_release",
              sessionId: "primary",
              deliveryKey: delivery.deliveryKey,
            }),
          )).reason,
          "thread_changed",
        );
      }
      h.state.pending = [original];
      assert.strictEqual(
        (yield* Effect.flip(
          h.service.featureUpdate({
            providerInstanceId: instanceId,
            operation: "delivery_release",
            sessionId: "other-session",
            deliveryKey: owned.attemptId,
          }),
        )).reason,
        "thread_changed",
      );
      assert.deepEqual(h.state.releases, []);
      assert.deepEqual(h.state.closed, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("refuses a changed live runtime and account rotation before ledger release", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const owned = yield* ownedDelivery(h);
    h.state.closeAllowed = false;
    const request = {
      providerInstanceId: instanceId,
      operation: "delivery_release" as const,
      sessionId: "primary",
      deliveryKey: owned.attemptId,
    };
    assert.strictEqual(
      (yield* Effect.flip(h.service.featureUpdate(request))).reason,
      "thread_active",
    );
    assert.deepEqual(h.state.releases, []);
    h.state.closeAllowed = true;
    h.state.rotateAfterClose = true;
    assert.strictEqual(
      (yield* Effect.flip(h.service.featureUpdate(request))).reason,
      "account_changed",
    );
    assert.deepEqual(h.state.releases, []);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "concurrent setup reenables the same binding once and refuses account rotation after hydration",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture({ disabled: true });
      const results = yield* Effect.all([h.service.setup, h.service.setup], { concurrency: 2 });
      assert.equal(
        results.every((result) => result.ready),
        true,
      );
      assert.equal(h.state.writes, 1);
      assert.deepEqual(Object.keys((yield* h.settings.getSettings).providerInstances), [
        instanceId,
      ]);
      assert.equal(
        h.state.reconciled.every((config) => config[instanceId]?.enabled === true),
        true,
      );
      h.state.rotateOnRefresh = true;
      assert.equal((yield* Effect.flip(h.service.setup)).reason, "account_changed");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "status is presence-only and selects the current account instead of the first stale snapshot",
  () =>
    Effect.gen(function* () {
      const stale = ProviderInstanceId.make("stale-muse");
      const h = yield* fixture({
        configured: {
          [stale]: {
            driver: ProviderDriverKind.make("muse-agent"),
            config: { accountBinding: "b".repeat(64) },
          },
          [instanceId]: {
            driver: ProviderDriverKind.make("muse-agent"),
            config: { accountBinding: binding },
          },
        },
      });
      h.state.snapshots.unshift(snapshot(stale));
      const status = yield* h.service.status;
      assert.equal(status.provider?.instanceId, instanceId);
      assert.equal(status.ready, true);
      assert.equal(h.state.accountReads, 0);
      yield* h.settings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("muse-agent"),
          enabled: false,
          config: { accountBinding: binding },
        },
      });
      assert.equal((yield* h.service.status).ready, false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("profile/avatar and feature calls stay bound to the selected enabled account", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const profile = yield* h.service.profile(instanceId);
    assert.match(profile.avatarRevision ?? "", /^[a-f0-9]{64}$/);
    assert.equal(
      profile.avatarImageUrl,
      `/api/ai-agents/muse/${instanceId}/avatar/image?revision=${profile.avatarRevision}`,
    );
    assert.equal(
      profile.avatarVideoUrls?.idle,
      `/api/ai-agents/muse/${instanceId}/avatar/idle?revision=${profile.avatarRevision}`,
    );
    yield* h.service.avatar(instanceId, "image");
    assert.deepEqual(h.state.avatarReads, ["workspace/avatars/synthetic/image.png"]);
    assert.equal(
      (yield* Effect.flip(h.service.avatar(instanceId, "../../secret"))).reason,
      "provider_unavailable",
    );
    assert.equal(
      (yield* Effect.flip(h.service.avatar(instanceId, "constructor"))).reason,
      "provider_unavailable",
    );
    assert.deepEqual(
      yield* h.service.featureRead({ providerInstanceId: instanceId, operation: "tasks" }),
      { operation: "tasks", data: [] },
    );
    yield* h.service.featureUpdate({
      providerInstanceId: instanceId,
      operation: "task_delete",
      jobId: "synthetic-task",
    });
    h.state.binding = "b".repeat(64);
    const requests: ReadonlyArray<Effect.Effect<unknown, NativeAgentError>> = [
      h.service.profile(instanceId),
      h.service.avatar(instanceId, "image"),
      h.service.featureRead({ providerInstanceId: instanceId, operation: "tasks" }),
      h.service.featureUpdate({
        providerInstanceId: instanceId,
        operation: "task_delete",
        jobId: "synthetic-task",
      }),
      h.service.open(reference),
    ];
    for (const request of requests)
      assert.equal((yield* Effect.flip(Effect.asVoid(request))).reason, "account_changed");
    assert.equal(h.state.featureCalls.length, 2);
    assert.equal(h.state.avatarReads.length, 1);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "native artwork path changes invalidate client avatar descriptors without changing canonical thread identity",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const opened = yield* h.service.open(reference);
      const before = yield* h.service.profile(instanceId);
      assert.deepEqual(yield* h.service.profile(instanceId), before);
      h.state.avatarImagePath = "workspace/avatars/synthetic/new-image.webp";
      const after = yield* h.service.profile(instanceId);
      assert.notEqual(after.avatarRevision, before.avatarRevision);
      assert.notEqual(after.avatarImageUrl, before.avatarImageUrl);
      assert.notEqual(after.avatarVideoUrls?.idle, before.avatarVideoUrls?.idle);
      assert.deepEqual(yield* h.service.open(reference), opened);
      assert.equal(h.state.watches, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "setup creates one canonical provider under concurrent first-time requests and preserves unrelated providers",
  () =>
    Effect.gen(function* () {
      const unrelated = ProviderInstanceId.make("existing-code-provider");
      const config = {
        driver: ProviderDriverKind.make("muse"),
        enabled: true,
        config: { command: "muse-code" },
      };
      const h = yield* fixture({ configured: { [unrelated]: config } });
      yield* Effect.all([h.service.setup, h.service.setup], { concurrency: 2 });
      const configured = (yield* h.settings.getSettings).providerInstances;
      assert.equal(h.state.writes, 1);
      assert.deepEqual(configured[unrelated], config);
      const native = Object.entries(configured).filter(
        ([, entry]) => entry.driver === "muse-agent",
      );
      assert.equal(native.length, 1);
      assert.equal(native[0]?.[0], `muse-agent-${binding.slice(0, 32)}`);
      assert.deepEqual(native[0]?.[1].config, { accountBinding: binding });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("setup refuses to replace an existing provider from a different native account", () =>
  Effect.gen(function* () {
    const h = yield* fixture({
      configured: {
        [instanceId]: {
          driver: ProviderDriverKind.make("muse-agent"),
          enabled: true,
          config: { accountBinding: "b".repeat(64) },
        },
      },
    });
    assert.equal((yield* Effect.flip(h.service.setup)).reason, "account_changed");
    assert.equal(h.state.writes, 0);
    assert.equal(h.state.refreshes, 0);
    assert.equal(h.state.reconciled.length, 0);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "disabled and removed providers deny all facade operations before touching native assets or features",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture({ disabled: true });
      const denied = Effect.gen(function* () {
        const requests: ReadonlyArray<Effect.Effect<unknown, NativeAgentError>> = [
          h.service.profile(instanceId),
          h.service.avatar(instanceId, "image"),
          h.service.featureRead({ providerInstanceId: instanceId, operation: "tasks" }),
          h.service.featureUpdate({
            providerInstanceId: instanceId,
            operation: "task_delete",
            jobId: "synthetic-task",
          }),
          h.service.open(reference),
        ];
        for (const request of requests)
          assert.equal((yield* Effect.flip(Effect.asVoid(request))).reason, "account_changed");
      });
      yield* denied;
      yield* h.settings.updateProviderInstance({ operation: "remove", instanceId });
      yield* denied;
      assert.equal(h.state.reads, 0);
      assert.equal(h.state.watches, 0);
      assert.deepEqual(h.state.avatarReads, []);
      assert.deepEqual(h.state.featureCalls, []);
      assert.deepEqual((yield* h.orchestrator.getShellSnapshot()).threads, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "opening an archived canonical thread unarchives it each time and imports history without a run",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const opened = yield* h.service.open(reference);
      yield* h.orchestrator
        .streamStoredEventsFrom({ threadId: opened.threadId, eventType: "message.updated" })
        .pipe(Stream.take(1), Stream.runDrain);
      assert.match(opened.threadId, /^muse-agent:[a-f0-9]{64}$/);
      for (const index of [1, 2]) {
        yield* h.orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`facade:archive:${index}`),
          threadId: opened.threadId,
        });
        assert.notEqual((yield* h.projections.getThread(opened.threadId)).archivedAt, null);
        assert.deepEqual(yield* h.service.open(reference), opened);
        assert.equal((yield* h.projections.getThread(opened.threadId)).archivedAt, null);
      }
      assert.equal((yield* h.orchestrator.getShellSnapshot()).threads.length, 1);
      const projection = yield* h.orchestrator.getThreadProjection(opened.threadId);
      assert.equal(projection.runs.length, 0);
      assert.equal(projection.messages[0]?.runId, null);
      assert.equal(h.state.reads, 1);
      assert.equal(h.state.watches, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "canonical reopen reuses a live provider-bound session without replacing it with an observer",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const opened = yield* h.service.open(reference);
      const observerId = ProviderSessionId.make(
        `provider-session:muse-agent-observe:${opened.threadId}`,
      );
      yield* h.sessions.close(observerId);
      const thread = yield* h.projections.getThread(opened.threadId);
      const liveId = ProviderSessionId.make("provider-session:muse-agent:live-turn");
      const runtime = yield* h.sessions.open({
        threadId: opened.threadId,
        providerSessionId: liveId,
        modelSelection: thread.modelSelection,
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
      });
      const nativeThread = yield* runtime.ensureThread({
        threadId: opened.threadId,
        modelSelection: thread.modelSelection,
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
      });
      const at = yield* DateTime.now;
      yield* h.projections.apply({
        id: EventId.make("facade:bound-live-session"),
        type: "provider-thread.updated",
        threadId: opened.threadId,
        occurredAt: at,
        payload: nativeThread,
      });
      const before = h.state.watches;
      assert.deepEqual(yield* h.service.open(reference), opened);
      assert.equal(h.state.watches, before);
      assert.equal(Option.isSome(yield* h.sessions.get(liveId)), true);
      assert.equal(Option.isNone(yield* h.sessions.get(observerId)), true);
      assert.equal((yield* h.orchestrator.getThreadProjection(opened.threadId)).runs.length, 0);
      yield* h.sessions.close(liveId);
      yield* h.service.open(reference);
      const restoredHistory = yield* h.service.featureRead({
        providerInstanceId: instanceId,
        operation: "history_page",
        threadId: opened.threadId,
      });
      assert.deepEqual(restoredHistory, {
        operation: "history_page",
        data: { nextBeforeSeq: 1, hasMore: false, importedMessages: 0 },
      });
      assert.equal(Option.isSome(yield* h.sessions.get(observerId)), true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("account change during identity lookup never creates a canonical thread", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    h.state.rotateOnProfile = true;
    assert.equal((yield* Effect.flip(h.service.open(reference))).reason, "account_changed");
    assert.deepEqual((yield* h.orchestrator.getShellSnapshot()).threads, []);
    assert.equal(h.state.watches, 0);
    assert.equal(
      (yield* Effect.flip(h.service.open({ ...reference, agentId: "arbitrary-agent" }))).reason,
      "provider_unavailable",
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "canonical open refuses a deleted/changed thread and does not create for a changed account",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      h.state.rotateOnResolve = true;
      assert.equal((yield* Effect.flip(h.service.open(reference))).reason, "account_changed");
      assert.deepEqual((yield* h.orchestrator.getShellSnapshot()).threads, []);
      h.state.rotateOnResolve = false;
      h.state.binding = binding;
      const opened = yield* h.service.open(reference);
      const thread = yield* h.projections.getThread(opened.threadId);
      const at = yield* DateTime.now;
      yield* h.projections.apply({
        id: EventId.make("native-thread-changed"),
        type: "thread.model-selection-updated",
        threadId: opened.threadId,
        occurredAt: at,
        payload: {
          ...thread,
          modelSelection: { instanceId: ProviderInstanceId.make("other-instance"), model: "muse" },
        },
      });
      assert.equal((yield* Effect.flip(h.service.open(reference))).reason, "thread_changed");
      yield* h.projections.apply({
        id: EventId.make("native-thread-deleted"),
        type: "thread.deleted",
        threadId: opened.threadId,
        occurredAt: at,
        payload: { ...thread, deletedAt: at },
      });
      assert.equal((yield* Effect.flip(h.service.open(reference))).reason, "thread_deleted");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "bounds pending metadata reads so old delivery rows cannot break the typed response",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      h.state.pending = Array.from({ length: 101 }, (_, index) => ({
        deliveryKey: `legacy-${index}`,
        status: "intent" as const,
        context: null,
      }));
      const first = yield* h.service.featureRead({
        providerInstanceId: instanceId,
        operation: "pending_deliveries",
      });
      assert.ok(first.operation === "pending_deliveries");
      assert.equal(first.data.deliveries.length, 100);
      assert.equal(first.data.deliveries[99]?.deliveryKey, "legacy-99");
      assert.equal(
        first.data.deliveries.every(
          (delivery) => !delivery.releasable && delivery.blockedReason === "legacy_context",
        ),
        true,
      );
      assert.deepEqual(h.state.pending.length, 101);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "computer reads, actions and preview bytes delegate the selected account and task session",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const scope = {
        providerInstanceId: instanceId,
        sessionId: "primary",
        taskId: "task:synthetic",
      };
      const read = yield* h.service.featureRead({ ...scope, operation: "computer_task" });
      assert.ok(read.operation === "computer_task");
      assert.equal(read.data.task.taskId, scope.taskId);
      assert.deepEqual(
        yield* h.service.featureUpdate({
          ...scope,
          operation: "computer_action",
          command: { action: "takeover", viewer: { width: 640, height: 480, devicePixelRatio: 1 } },
        }),
        { updated: true },
      );
      const preview = yield* h.service.computerPreview(instanceId, scope.sessionId, scope.taskId);
      assert.deepEqual(preview, { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" });
      assert.deepEqual(
        h.state.computerCalls.map((call) => [
          call.kind,
          call.binding,
          call.sessionId,
          call.taskId,
          call.action,
        ]),
        [
          ["read", binding, "primary", scope.taskId, undefined],
          ["operate", binding, "primary", scope.taskId, "takeover"],
          ["preview", binding, "primary", scope.taskId, undefined],
        ],
      );
      h.state.forbidChatResolution = true;
      assert.deepEqual(
        yield* h.service.featureUpdate({
          ...scope,
          operation: "computer_action",
          command: { action: "takeover" },
        }),
        { updated: true },
      );
      assert.equal(h.state.computerCalls.length, 4);
      h.state.binding = "b".repeat(64);
      assert.equal(
        (yield* Effect.flip(h.service.computerPreview(instanceId, "primary", scope.taskId))).reason,
        "account_changed",
      );
      assert.equal(h.state.computerCalls.length, 4);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("computer previews refuse empty and oversized native bytes", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    for (const bytes of [new Uint8Array(), new Uint8Array(20 * 1024 * 1024 + 1)]) {
      h.state.computerPreviewBytes = bytes;
      assert.equal(
        (yield* Effect.flip(h.service.computerPreview(instanceId, "primary", "synthetic-task")))
          .reason,
        "provider_unavailable",
      );
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "dictation is local, bounded, returned for review and gated before and after account changes",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const status = yield* h.service.featureRead({
        operation: "dictation",
        providerInstanceId: instanceId,
      });
      assert.deepEqual(status, {
        operation: "dictation",
        data: {
          available: true,
          engineDetected: true,
          modelDetected: true,
          local: true,
          sampleRateHz: 24000,
          maxAudioSeconds: 60,
          reason: "ready",
        },
      });
      assert.equal(h.state.dictationCalls.length, 0);
      const pcm = new Uint8Array([0, 0, 1, 0, 2, 0]);
      assert.deepEqual(
        yield* h.service.dictationTranscribe({
          providerInstanceId: instanceId,
          pcm,
          language: "en",
        }),
        { text: "Synthetic transcript" },
      );
      assert.deepEqual(h.state.dictationCalls, [{ pcm, language: "en" }]);
      for (const invalid of [new Uint8Array(), new Uint8Array(7), new Uint8Array(2_880_002)])
        assert.equal(
          (yield* Effect.flip(
            h.service.dictationTranscribe({ providerInstanceId: instanceId, pcm: invalid }),
          )).code,
          "invalid_audio",
        );
      assert.equal(h.state.dictationCalls.length, 1);
      h.state.rotateOnDictation = true;
      assert.equal(
        (yield* Effect.flip(h.service.dictationTranscribe({ providerInstanceId: instanceId, pcm })))
          .code,
        "account_changed",
      );
      assert.equal(h.state.dictationCalls.length, 2);
      assert.equal(
        (yield* Effect.flip(h.service.dictationTranscribe({ providerInstanceId: instanceId, pcm })))
          .code,
        "account_changed",
      );
      assert.equal(h.state.dictationCalls.length, 2);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("dictation errors expose safe structured codes without process or account data", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const pcm = new Uint8Array(6);
    for (const kind of [
      "unavailable",
      "invalid_audio",
      "busy",
      "timeout",
      "failed",
      "no_speech",
    ] as const) {
      h.state.dictationFailure = kind;
      const error = yield* Effect.flip(
        h.service.dictationTranscribe({ providerInstanceId: instanceId, pcm }),
      );
      assert.equal(error.code, kind);
      assert.notInclude(error.message, "synthetic-private-account-secret");
      assert.notInclude(JSON.stringify(error), "synthetic-private-account-secret");
    }
    h.state.dictationFailure = null;
    h.state.dictationText = "   ";
    assert.equal(
      (yield* Effect.flip(h.service.dictationTranscribe({ providerInstanceId: instanceId, pcm })))
        .code,
      "no_speech",
    );
    h.state.dictationText = "x".repeat(16001);
    assert.equal(
      (yield* Effect.flip(h.service.dictationTranscribe({ providerInstanceId: instanceId, pcm })))
        .code,
      "failed",
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("dictation facade times out an unfinished local transcription", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    h.state.dictationNever = true;
    const awaiting = yield* Effect.flip(
      h.service.dictationTranscribe({ providerInstanceId: instanceId, pcm: new Uint8Array(6) }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(h.state.dictationStarted);
    yield* TestClock.adjust("30 seconds");
    assert.equal((yield* Fiber.join(awaiting)).code, "timeout");
    assert.equal(h.state.dictationCalls.length, 1);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "computer facade inspects a visible task on a read-only execution session without resolving chat",
  () =>
    Effect.gen(function* () {
      const worker = "worker:readonly-execution",
        taskId = "browser-task:synthetic";
      const calls: string[] = [];
      let tookOver = false;
      const transport = Layer.mock(Transport.MuseAgentTransport)({
        connect: Effect.succeed(binding),
        connectionId: () => Effect.succeed("generation-1"),
        request: (_binding, method) =>
          Effect.sync(() => {
            calls.push(method);
            if (method === "computer.context")
              return {
                tasks: [
                  {
                    browser_task_id: taskId,
                    session_id: worker,
                    title: "Synthetic worker task",
                    latest_screenshot: {
                      url: `/api/computer/previews/${taskId}/${"a".repeat(64)}`,
                      width: 640,
                      height: 480,
                    },
                  },
                ],
              };
            if (method === "browser_task.takeover") {
              tookOver = true;
              return {
                session_id: worker,
                presented_task_id: taskId,
                lease: {
                  control_owner: "user",
                  task_id: taskId,
                  takeover_id: "owned-takeover",
                  control_expires_at_ms: 12000,
                },
              };
            }
            if (method === "browser_task.get")
              return {
                session_id: worker,
                presented_task_id: taskId,
                lease: {
                  control_owner: tookOver ? "user" : "agent",
                  task_id: taskId,
                  ...(tookOver
                    ? { takeover_id: "foreign-replacement", control_expires_at_ms: 13000 }
                    : {}),
                },
              };
            throw new Error("Computer ownership must not use the chat session list.");
          }),
        readComputerPreview: () =>
          Effect.succeed({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" as const }),
      });
      const h = yield* fixture({ computerLayer: Computer.layer.pipe(Layer.provide(transport)) });
      h.state.forbidChatResolution = true;
      const scope = { providerInstanceId: instanceId, sessionId: worker, taskId };
      const read = yield* h.service.featureRead({ ...scope, operation: "computer_task" });
      assert.ok(read.operation === "computer_task");
      assert.equal(read.data.state.sessionId, worker);
      assert.deepEqual(yield* h.service.computerPreview(instanceId, worker, taskId), {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
      });
      assert.deepEqual(
        yield* h.service.featureUpdate({
          ...scope,
          operation: "computer_action",
          command: { action: "takeover" },
        }),
        {
          updated: true,
          computerState: {
            sessionId: worker,
            presentedTaskId: taskId,
            lease: {
              controlOwner: "user",
              taskId,
              takeoverId: "owned-takeover",
              controlExpiresAtMs: 12000,
            },
            activeTab: null,
            deviceClipboardSupported: false,
          },
        },
      );
      const refreshed = yield* h.service.featureRead({ ...scope, operation: "computer_task" });
      assert.ok(refreshed.operation === "computer_task");
      assert.equal(refreshed.data.state.lease?.takeoverId, "foreign-replacement");
      assert.equal(calls.includes("sessions.list"), false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "computer stream input remains bound to the selected account and closes its owned scope",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      h.state.forbidChatResolution = true;
      const payload = new Uint8Array([1, 2, 3]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* h.service.computerStream({
            providerInstanceId: instanceId,
            sessionId: "worker:synthetic",
            taskId: "task:synthetic",
            takeoverId: "owned-takeover",
          });
          yield* stream.send(payload);
          h.state.binding = "b".repeat(64);
          assert.equal(
            (yield* Effect.flip(stream.send(new Uint8Array([4])))).reason,
            "account_changed",
          );
          assert.deepEqual(h.state.computerStreamInputs, [payload]);
        }),
      );
      assert.equal(h.state.computerStreamClosed, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const guardedHistoryGroup = WsRpcGroup.omit(
  ...Array.from(WsRpcGroup.requests.keys()).filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      typeof WS_METHODS.museAgentsFeatureRead | typeof WS_METHODS.museAgentsFeatureUpdate
    > => tag !== WS_METHODS.museAgentsFeatureRead && tag !== WS_METHODS.museAgentsFeatureUpdate,
  ),
);

it.effect("history RPC inspection cannot import; only operate access persists an older page", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    h.state.historyPages = true;
    const opened = yield* h.service.open(reference);
    yield* h.orchestrator
      .streamStoredEventsFrom({ threadId: opened.threadId, eventType: "turn-item.updated" })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "turn-item.updated" &&
            stored.event.payload.canonicalNativeSequence === 10,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
    const before = yield* h.orchestrator.getThreadProjection(opened.threadId);
    const client = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      RpcTest.makeClient(guardedHistoryGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            guardedHistoryGroup.toLayerHandler(WS_METHODS.museAgentsFeatureRead, (input) =>
              h.service.featureRead(input),
            ),
            guardedHistoryGroup.toLayerHandler(WS_METHODS.museAgentsFeatureUpdate, (input) =>
              h.service.featureUpdate(input),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
    const reader = yield* client([AuthOrchestrationReadScope]);
    const forgedRead = {
      providerInstanceId: instanceId,
      threadId: opened.threadId,
      operation: "history_page" as const,
      beforeSeq: 10,
    };
    assert.deepEqual(yield* reader[WS_METHODS.museAgentsFeatureRead](forgedRead), {
      operation: "history_page",
      data: { nextBeforeSeq: 10, hasMore: true, importedMessages: 0 },
    });
    const request = {
      providerInstanceId: instanceId,
      threadId: opened.threadId,
      operation: "history_page" as const,
      beforeSeq: 10,
    };
    assert.equal(
      (yield* reader[WS_METHODS.museAgentsFeatureUpdate](request).pipe(Effect.exit))._tag,
      "Failure",
    );
    assert.deepEqual(h.state.historyCursors, [undefined]);
    const unchanged = yield* h.orchestrator.getThreadProjection(opened.threadId);
    assert.deepEqual(unchanged.messages, before.messages);
    assert.deepEqual(unchanged.turnItems, before.turnItems);
    const operator = yield* client([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    assert.deepEqual(yield* operator[WS_METHODS.museAgentsFeatureUpdate](request), {
      updated: true,
      historyPage: { nextBeforeSeq: 0, hasMore: false, importedMessages: 1 },
    });
    yield* h.orchestrator
      .streamStoredEventsFrom({ threadId: opened.threadId, eventType: "turn-item.updated" })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "turn-item.updated" &&
            stored.event.payload.canonicalNativeSequence === 0,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
    const imported = yield* h.orchestrator.getThreadProjection(opened.threadId);
    assert.deepEqual(
      imported.turnItems.filter((item) => item.type === "user_message").map((item) => item.text),
      ["Synthetic paginated history", "Synthetic recent history"],
    );
    assert.deepEqual(h.state.historyCursors, [undefined, 10]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "history import refuses account changes during native fetch before persisting older messages",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      h.state.historyPages = true;
      const opened = yield* h.service.open(reference);
      yield* h.orchestrator
        .streamStoredEventsFrom({ threadId: opened.threadId, eventType: "turn-item.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "turn-item.updated" &&
              stored.event.payload.canonicalNativeSequence === 10,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      const before = yield* h.orchestrator.getThreadProjection(opened.threadId);
      h.state.rotateOnHistoryPage = true;
      assert.equal(
        (yield* Effect.flip(
          h.service.featureUpdate({
            providerInstanceId: instanceId,
            threadId: opened.threadId,
            operation: "history_page",
            beforeSeq: 10,
          }),
        )).reason,
        "provider_unavailable",
      );
      const after = yield* h.orchestrator.getThreadProjection(opened.threadId);
      assert.deepEqual(after.messages, before.messages);
      assert.deepEqual(after.turnItems, before.turnItems);
      assert.deepEqual(h.state.historyCursors, [undefined, 10]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("opens a side chat as its own thread and keeps Main chat canonical", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const main = yield* h.service.open(reference);
    const side = yield* h.service.open({ ...reference, sessionId: "side:1" });
    const again = yield* h.service.open({ ...reference, sessionId: "side:1" });
    const primary = yield* h.service.open({ ...reference, sessionId: "primary" });
    assert.notStrictEqual(side.threadId, main.threadId);
    assert.strictEqual(again.threadId, side.threadId);
    assert.strictEqual(primary.threadId, main.threadId);
    assert.isTrue(side.threadId.endsWith(`:${encodeURIComponent("side:1")}`));
    const shell = yield* h.projections.getThreadShell(side.threadId);
    assert.strictEqual(shell?.title, "Side research");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "stores a prompted credential outside chat, once, after validating field byte limits",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      h.inbox.observe(binding, {
        event: "delta.presentation",
        payload: {
          session_id: "primary",
          presentation_id: "vault-prompt",
          kind: "internal_link_action_card",
          data: {
            title: "Sign in",
            type: "credentials_vault",
            data: {
              capture: "sign_in",
              page_url: "https://example.test/login",
              capture_authorization: "synthetic-authorization",
            },
          },
        },
      });
      const request = {
        providerInstanceId: instanceId,
        operation: "credential_submit" as const,
        sessionId: "primary",
        requestId: "vault-prompt",
        username: "synthetic-user",
        password: "synthetic-password",
      };
      yield* Effect.flip(h.service.featureUpdate({ ...request, username: "é".repeat(129) }));
      assert.equal(h.state.credentialCalls.length, 0);
      yield* h.service.featureUpdate(request);
      assert.equal(h.state.credentialCalls.length, 1);
      assert.deepStrictEqual(h.state.credentialCalls[0]?.params.fields, [
        { name: "username", value: "synthetic-user", protected: true },
        { name: "password", value: "synthetic-password", protected: true },
      ]);
      assert.equal(h.state.credentialCalls[0]?.method, "credentials.capture");
      assert.equal(
        h.state.credentialCalls[0]?.params.capture_authorization,
        "synthetic-authorization",
      );
      assert.equal(h.state.credentialCalls[0]?.params.lifetime, "persist");
      yield* Effect.flip(h.service.featureUpdate(request));
      assert.equal(h.state.credentialCalls.length, 1);
      assert.equal(h.state.reads, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("synchronizes an opened side conversation title after a native rename", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const opened = yield* h.service.open({
      ...reference,
      sessionId: "side-one",
    });
    yield* h.service.featureUpdate({
      providerInstanceId: instanceId,
      operation: "session_rename",
      sessionId: "side-one",
      title: "Renamed research",
    });
    const shell = yield* h.projections.getThreadShell(opened.threadId);
    assert.equal(shell?.title, "Renamed research");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["projection", "account"] as const)(
  "reports a committed native rename as partial success after %s sync failure and allows retry",
  (failure) =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const opened = yield* h.service.open({ ...reference, sessionId: "side-one" });
      const input = {
        providerInstanceId: instanceId,
        operation: "session_rename",
        sessionId: "side-one",
        title: "Renamed research",
      } as const;
      h.state.failRenameSync = failure === "projection";
      h.state.rotateOnRename = failure === "account";
      const result = yield* h.service.featureUpdate(input);
      assert.deepStrictEqual(result, { updated: true, title: input.title, titleSyncPending: true });
      assert.strictEqual(h.state.nativeTitle, input.title);
      assert.notEqual((yield* h.projections.getThreadShell(opened.threadId))?.title, input.title);
      h.state.failRenameSync = false;
      h.state.rotateOnRename = false;
      h.state.binding = binding;
      const retried = yield* h.service.featureUpdate(input);
      assert.deepStrictEqual(retried, { updated: true, title: input.title });
      assert.strictEqual(
        (yield* h.projections.getThreadShell(opened.threadId))?.title,
        input.title,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("pairs direct native archives and restores with the canonical T3 shell", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const opened = yield* h.service.open({ ...reference, sessionId: "side-one" });
    for (const archived of [true, true, false, false]) {
      yield* h.service.featureUpdate({
        providerInstanceId: instanceId,
        operation: "session_archive",
        sessionId: "side-one",
        archived,
      });
      assert.equal(h.state.nativeArchived, archived);
      assert.equal(
        (yield* h.projections.getThreadShell(opened.threadId))?.archivedAt !== null,
        archived,
      );
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each([false, true])(
  "recovers a failed local archive or reports failed recovery: %s",
  (recoveryFails) =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const opened = yield* h.service.open({ ...reference, sessionId: "side-one" });
      h.state.failArchiveSync = true;
      h.state.failArchiveRecovery = recoveryFails;
      const request = {
        providerInstanceId: instanceId,
        operation: "session_archive",
        sessionId: "side-one",
        archived: true,
      } as const;
      const error = yield* Effect.flip(h.service.featureUpdate(request));
      assert.equal(error.reason, "storage_failed");
      assert.match(
        error.message,
        recoveryFails ? /or restore Muse/ : /restored the previous archive state/,
      );
      assert.equal(h.state.nativeArchived, recoveryFails);
      assert.equal((yield* h.projections.getThreadShell(opened.threadId))?.archivedAt, null);
      h.state.failArchiveSync = false;
      h.state.archiveSyncFailed = false;
      h.state.failArchiveRecovery = false;
      yield* h.service.featureUpdate(request);
      assert.equal(h.state.nativeArchived, true);
      assert.notEqual((yield* h.projections.getThreadShell(opened.threadId))?.archivedAt, null);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("finishes paired archive synchronization when the requesting fiber is interrupted", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    const opened = yield* h.service.open({ ...reference, sessionId: "side-one" });
    h.state.pauseArchive = true;
    const pending = yield* h.service
      .featureUpdate({
        providerInstanceId: instanceId,
        operation: "session_archive",
        sessionId: "side-one",
        archived: true,
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(h.state.archiveWritten);
    const interrupted = yield* Fiber.interrupt(pending).pipe(Effect.forkChild);
    yield* Deferred.succeed(h.state.archiveContinue, undefined);
    yield* Fiber.join(interrupted);
    assert.equal(h.state.nativeArchived, true);
    assert.notEqual((yield* h.projections.getThreadShell(opened.threadId))?.archivedAt, null);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["primary", "native-main-42"])(
  "refuses to archive primary %s or an unknown Muse session before native mutation",
  (primaryId) =>
    Effect.gen(function* () {
      const h = yield* fixture();
      h.state.primarySessionId = primaryId;
      for (const sessionId of [primaryId, "missing"]) {
        const error = yield* h.service
          .featureUpdate({
            providerInstanceId: instanceId,
            operation: "session_archive",
            sessionId,
            archived: true,
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "thread_changed");
        if (sessionId === primaryId)
          assert.strictEqual(error.message, "Muse's main conversation cannot be archived.");
      }
      assert.deepStrictEqual(h.state.archiveCalls, []);
      assert.strictEqual((yield* h.service.status).ready, true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
it.effect(
  "allows side chat archives and restoration, including recovery of the primary session",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      for (const [sessionId, archived] of [
        ["side-one", true],
        ["readonly-side", true],
        ["side-one", false],
        ["primary", false],
      ] as const) {
        assert.deepStrictEqual(
          yield* h.service.featureUpdate({
            providerInstanceId: instanceId,
            operation: "session_archive",
            sessionId,
            archived,
          }),
          { updated: true },
        );
      }
      assert.deepStrictEqual(h.state.archiveCalls, [
        { binding, sessionId: "side-one", archived: true },
        { binding, sessionId: "readonly-side", archived: true },
        { binding, sessionId: "side-one", archived: false },
        { binding, sessionId: "primary", archived: false },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
