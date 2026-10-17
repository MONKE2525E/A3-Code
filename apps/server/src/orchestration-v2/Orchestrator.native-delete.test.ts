import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NativeAgents from "../nativeAgents/NativeAgentService.ts";
import * as Native from "../museAgent/MuseAgentNativeRuntimeService.ts";
import * as Transport from "../museAgent/MuseAgentTransport.ts";
import * as Features from "../museAgent/MuseAgentFeatureService.ts";
import * as Connectors from "../museAgent/MuseAgentConnectorService.ts";
import * as Computer from "../museAgent/MuseAgentComputerService.ts";
import * as Dictation from "../museAgent/MuseAgentDictation.ts";
import * as Grok from "../grokBot/GrokBotThreadService.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Mutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Projects from "./ProjectStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import { museThreadIdentity, museThreadIdForSession } from "../museAgent/MuseAgentThreadIds.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { dispatchFailure } from "../mcp/threadAccess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

const database = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "native-delete" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId, nativeCreation = true) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:native-delete"),
        title: "Conversation",
        modelSelection: { instanceId: ProviderInstanceId.make("muse-agent"), model: "muse" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.provideService(
          Orchestrator.MuseThreadCreation,
          nativeCreation ? threadId : undefined,
        ),
      );
  });

it.effect.each([
  `muse-agent:${"a".repeat(64)}`,
  `muse-agent:${"a".repeat(64)}:side%3Achat`,
  "muse-agent:saved-hash",
])("rejects generic deletion of %s without changing its canonical shell", (id) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(id);
    yield* createThread(threadId);
    const before = yield* projections.getThreadProjection(threadId);
    const shellBefore = yield* orchestrator.getShellSnapshot();
    const command = {
      type: "thread.delete" as const,
      commandId: CommandId.make(`delete:${threadId}`),
      threadId,
    };
    const error = yield* Effect.flip(orchestrator.dispatch(command));
    assert.equal(error._tag, "OrchestratorCommandRejectedError");
    assert.equal(
      dispatchFailure(error).message,
      "Muse conversations cannot be deleted through generic thread commands. Use Muse's archive controls instead.",
    );
    assert.equal(userFacingDispatchErrorMessage(error), dispatchFailure(error).message);
    assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
    assert.deepEqual(yield* orchestrator.getShellSnapshot(), shellBefore);
    const replay = yield* Effect.flip(orchestrator.dispatch(command));
    assert.equal(replay._tag, "OrchestratorCommandPreviouslyRejectedError");
    assert.isNull((yield* projections.getThread(threadId)).deletedAt);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`archive:${threadId}`),
      threadId,
    });
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make(`unarchive:${threadId}`),
      threadId,
    });
    const restored = yield* projections.getThread(threadId);
    assert.isNull(restored.deletedAt);
    assert.isNull(restored.archivedAt);
    assert.deepEqual(restored.modelSelection, before.thread.modelSelection);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  `muse-agent:${"a".repeat(64)}`,
  `muse-agent:${"a".repeat(64)}:side%3Achat`,
  "muse-agent:saved-hash",
])("rejects generic provider and model changes to %s", (id) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(id);
    yield* createThread(threadId);
    const before = yield* projections.getThreadProjection(threadId);
    const shellBefore = yield* orchestrator.getShellSnapshot();
    for (const type of ["thread.model-selection.set", "provider.switch"] as const) {
      const command = {
        type,
        commandId: CommandId.make(`${type}:${threadId}`),
        threadId,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      };
      const error = yield* Effect.flip(orchestrator.dispatch(command));
      assert.equal(error._tag, "OrchestratorCommandRejectedError");
      assert.equal(
        userFacingDispatchErrorMessage(error),
        "Muse conversations cannot change provider or model through generic thread commands.",
      );
      assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
      assert.deepEqual(yield* orchestrator.getShellSnapshot(), shellBefore);
      const replay = yield* Effect.flip(orchestrator.dispatch(command));
      assert.equal(replay._tag, "OrchestratorCommandPreviouslyRejectedError");
    }
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  { instanceId: ProviderInstanceId.make("muse-agent"), model: "other-model" },
])("rejects Muse provider and model overrides in message dispatch: %s", (modelSelection) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`muse-agent:${"a".repeat(64)}`);
    yield* createThread(threadId);
    const before = yield* projections.getThreadProjection(threadId);
    const shellBefore = yield* orchestrator.getShellSnapshot();
    const error = yield* Effect.flip(
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch:override"),
        threadId,
        messageId: MessageId.make("override-message"),
        text: "Hello",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      }),
    );
    assert.equal(error._tag, "OrchestratorCommandRejectedError");
    assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
    assert.deepEqual(yield* orchestrator.getShellSnapshot(), shellBefore);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  `muse-agent:${"a".repeat(64)}`,
  `muse-agent:${"a".repeat(64)}:side%3Achat`,
  "muse-agent:saved-hash",
])("rejects generic worktree changes to %s while preserving metadata updates", (id) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(id);
    yield* createThread(threadId);
    const before = yield* projections.getThreadProjection(threadId);
    const shellBefore = yield* orchestrator.getShellSnapshot();
    const command = {
      type: "thread.metadata.update" as const,
      commandId: CommandId.make("metadata:redirect"),
      threadId,
      title: "Must not apply",
      worktreePath: "/unrelated-checkout",
    };
    const error = yield* Effect.flip(orchestrator.dispatch(command));
    assert.equal(error._tag, "OrchestratorCommandRejectedError");
    assert.equal(
      userFacingDispatchErrorMessage(error),
      "Muse conversations cannot change worktree through generic thread commands.",
    );
    assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
    assert.deepEqual(yield* orchestrator.getShellSnapshot(), shellBefore);
    const replay = yield* Effect.flip(orchestrator.dispatch(command));
    assert.equal(replay._tag, "OrchestratorCommandPreviouslyRejectedError");
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("metadata:title"),
      threadId,
      title: "Renamed conversation",
      worktreePath: null,
    });
    const updated = yield* projections.getThread(threadId);
    assert.equal(updated.title, "Renamed conversation");
    assert.isNull(updated.worktreePath);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["thread:ordinary", "grok-bot:saved-hash"])(
  "allows deletion of %s, preserving ordinary deletion and Grok owner cleanup",
  (id) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(id);
      yield* createThread(threadId);
      const deleted = yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete:ordinary"),
        threadId,
      });
      assert.isTrue(deleted.storedEvents.some((stored) => stored.event.type === "thread.deleted"));
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(layer)),
);

it.effect("native Muse open still reopens the canonical conversation after rejected deletion", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const instanceId = ProviderInstanceId.make("muse-agent");
    const binding = "a".repeat(64);
    const threadId = ThreadId.make(museThreadIdForSession(museThreadIdentity(binding, instanceId)));
    yield* createThread(threadId);
    const service = yield* NativeAgents.NativeAgentService.pipe(
      Effect.provide(
        NativeAgents.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
              Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
              Layer.mock(Native.MuseAgentNativeRuntimeService)({
                accountBinding: Effect.succeed(binding),
                resolveSession: () =>
                  Effect.succeed({
                    session_id: "primary",
                    status: "idle",
                    is_primary: true,
                    is_thread: false,
                  }),
              }),
              Settings.layerTest({
                providerInstances: {
                  [instanceId]: {
                    driver: "muse-agent",
                    enabled: true,
                    config: { accountBinding: binding },
                  },
                },
              }),
              Layer.mock(Projects.ProjectStoreV2)({ get: () => Effect.succeedNone }),
              Layer.mock(Transport.MuseAgentTransport)({}),
              Layer.mock(Features.MuseAgentFeatureService)({}),
              Layer.mock(Connectors.MuseAgentConnectorService)({}),
              Layer.mock(Computer.MuseAgentComputerService)({}),
              Layer.mock(Dictation.MuseAgentDictation)({}),
              Layer.mock(Grok.GrokBotThreadService)({}),
              Layer.mock(Providers.ProviderRegistry)({}),
              Layer.mock(Mutator.ProviderInstanceRegistryMutator)({}),
              Layer.mock(Folders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
              Layer.mock(Sessions.ProviderSessionManagerV2)({}),
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
    );
    const reference = {
      source: "muse-agent" as const,
      providerInstanceId: instanceId,
      agentId: "muse",
    };
    const opened = yield* service.open(reference);
    assert.equal(opened.threadId, threadId);
    const rejected = yield* Effect.flip(
      orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("native-open:delete"),
        threadId,
      }),
    );
    assert.equal(rejected._tag, "OrchestratorCommandRejectedError");
    for (const type of ["thread.model-selection.set", "provider.switch"] as const) {
      const rejectedSelection = yield* Effect.flip(
        orchestrator.dispatch({
          type,
          commandId: CommandId.make(`native-open:${type}`),
          threadId,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        }),
      );
      assert.equal(rejectedSelection._tag, "OrchestratorCommandRejectedError");
      assert.deepEqual(yield* service.open(reference), opened);
    }
    assert.deepEqual(yield* service.open(reference), opened);
    assert.isNull((yield* projections.getThread(threadId)).deletedAt);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  `muse-agent:${"a".repeat(64)}`,
  `muse-agent:${"a".repeat(64)}:side%3Achat`,
  "muse-agent:saved-hash",
])("reserves %s for native creation before recording a shell", (id) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(id);
    const before = yield* orchestrator.getShellSnapshot();
    const error = yield* Effect.flip(createThread(threadId, false));
    assert.equal(error._tag, "OrchestratorCommandRejectedError");
    assert.deepEqual(yield* orchestrator.getShellSnapshot(), before);
  }).pipe(Effect.provide(layer)),
);

it.effect("allows generic ordinary creation without a native creation grant", () =>
  Effect.gen(function* () {
    yield* createThread(ThreadId.make("ordinary:unreserved"), false);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    assert.equal(
      (yield* projections.getThread(ThreadId.make("ordinary:unreserved"))).title,
      "Conversation",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  `muse-agent:${"a".repeat(64)}`,
  `muse-agent:${"a".repeat(64)}:side%3Achat`,
  "muse-agent:saved-hash",
])("rejects unsupported policies on %s without changing the shell", (id) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(id);
    yield* createThread(threadId);
    const before = yield* projections.getThreadProjection(threadId);
    const commands = [
      {
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("policy:runtime"),
        threadId,
        runtimeMode: "approval-required",
      },
      {
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("policy:interaction"),
        threadId,
        interactionMode: "plan",
      },
    ] as const;
    for (const command of commands) {
      const error = yield* Effect.flip(orchestrator.dispatch(command));
      assert.equal(error._tag, "OrchestratorCommandRejectedError");
      assert.deepEqual(yield* projections.getThreadProjection(threadId), before);
    }
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("policy:runtime:valid"),
      threadId,
      runtimeMode: "full-access",
    });
    yield* orchestrator.dispatch({
      type: "thread.interaction-mode.set",
      commandId: CommandId.make("policy:interaction:valid"),
      threadId,
      interactionMode: "default",
    });
    const after = yield* projections.getThread(threadId);
    assert.equal(after.runtimeMode, "full-access");
    assert.equal(after.interactionMode, "default");
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects forks claiming the reserved Muse namespace before reading their source", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const before = yield* orchestrator.getShellSnapshot();
    const error = yield* Effect.flip(
      orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork:reserved"),
        sourceThreadId: ThreadId.make("ordinary:source"),
        targetThreadId: ThreadId.make(`muse-agent:${"a".repeat(64)}`),
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      }),
    );
    assert.equal(error._tag, "OrchestratorCommandRejectedError");
    assert.deepEqual(yield* orchestrator.getShellSnapshot(), before);
  }).pipe(Effect.provide(layer)),
);
