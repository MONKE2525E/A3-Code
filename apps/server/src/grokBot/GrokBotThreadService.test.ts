import * as EventSink from "../orchestration-v2/EventSink.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2Command,
  isGrokBotBackingThread,
  GrokBotError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type GrokBot,
  type GrokBotOrchestratorConfig,
} from "@t3tools/contracts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Settings from "../serverSettings.ts";
import {
  GROK_BOT_DRIVER_KIND,
  GrokBotCapabilitiesV2,
} from "../orchestration-v2/Adapters/GrokBotAdapterV2.ts";
import {
  accountBinding,
  instanceId,
  makeNative,
  selection,
} from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Native from "./GrokBotNativeRuntimeService.ts";
import * as Config from "./GrokBotOrchestratorService.ts";
import * as Bots from "./GrokBotService.ts";
import * as Service from "./GrokBotThreadService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const projectId = ProjectId.make("bot-project");
const otherProjectId = ProjectId.make("other-project");
const scratchProjectId = ProjectId.make("scratch-project");
const isClientCommand = Schema.is(OrchestrationV2Command);
const canonicalIdForFixture = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([accountBinding, instanceId, selection.model])),
  );
  return ThreadId.make(
    `grok-bot:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
});
const bot: GrokBot = {
  id: selection.model,
  name: "Bot One",
  label: "Bot One",
  description: "",
  avatarShape: "circle",
  avatarColor: "blue",
  notificationEnabled: true,
  hidden: false,
  pinned: true,
  featured: false,
  pullRequests: [],
};
const ready: typeof GrokBotOrchestratorConfig.Type = {
  bridge: { installed: true, managed: true, sessionPresent: true },
  botIds: [bot.id],
  state: "ready",
  authentication: "native_account",
  directDelegationSupported: true,
  publicEndpointReadiness: { ready: true, reason: null },
  instructions: "Select the bot.",
  provider: {
    instanceId,
    driver: ProviderDriverKind.make("grok-bot"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
};
const adapter: ProviderAdapterV2["Service"] = {
  instanceId,
  driver: GROK_BOT_DRIVER_KIND,
  getCapabilities: () => Effect.succeed(GrokBotCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  // Observation attaches a read-only session; it never starts a provider turn.
  openSession: (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      observedSessions.push(`${input.threadId}:${input.providerSessionId}`);
      return {
        instanceId,
        driver: GROK_BOT_DRIVER_KIND,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver: GROK_BOT_DRIVER_KIND,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? ".",
          model: input.modelSelection.model,
          capabilities: GrokBotCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        // Native history the bot already holds, delivered the way the live adapter imports it.
        events: Stream.concat(
          Stream.fromIterable(
            nativeHistory.map((entry) => ({
              type: "message.updated" as const,
              driver: GROK_BOT_DRIVER_KIND,
              message: {
                id: MessageId.make(`native:${input.threadId}:${entry.id}`),
                threadId: input.threadId,
                runId: null,
                nodeId: null,
                role: entry.role,
                createdBy: entry.role === "user" ? ("user" as const) : ("agent" as const),
                creationSource: "provider" as const,
                text: entry.text,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            })),
          ),
          Stream.never,
        ),
        startTurn: () => Effect.die("Observation must not start a turn."),
      } as never;
    }),
};
const observedSessions: string[] = [];
const nativeHistory: Array<{ id: string; role: "user" | "assistant"; text: string }> = [];
type DatabaseLayer = NonNullable<
  NonNullable<Parameters<typeof Harness.layerWithRegistry>[2]>["databaseLayer"]
>;
const runtime = (database: DatabaseLayer = Sqlite.layerMemory) =>
  Layer.mergeAll(
    database,
    Harness.layerWithRegistry({ name: "bot-open" }, Registry.layerFromAdapters([adapter]), {
      databaseLayer: database,
      runEffectWorker: false,
    }),
    Projections.layer.pipe(Layer.provide(database)),
    Projects.layer.pipe(Layer.provide(database)),
    CommandReceiptStore.layer.pipe(Layer.provide(database)),
    ThreadSearch.layer.pipe(Layer.provide(database)),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const seedProjects = Effect.gen(function* () {
  const projects = yield* Projects.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  for (const id of [projectId, otherProjectId, scratchProjectId]) {
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: `t3-${id}-` });
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make(`project:${id}`),
      aggregateKind: "project",
      aggregateId: id,
      occurredAt: "2026-10-10T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: id,
        title: id,
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
      },
    });
  }
});
const fixture = (
  options: {
    readonly inspect?: Config.GrokBotOrchestratorService["Service"]["inspect"];
    readonly native?: Native.GrokBotNativeRuntimeService["Service"];
    readonly bots?: readonly GrokBot[];
    readonly botDelete?: Bots.GrokBotService["Service"]["delete"];
    readonly orchestrator?: Orchestrator.OrchestratorV2["Service"];
    readonly scratchUnavailable?: boolean;
    readonly providerSessions?: ProviderSessions.ProviderSessionManagerV2["Service"];
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = options.orchestrator ?? (yield* Orchestrator.OrchestratorV2);
    const projections = yield* Projections.ProjectionStoreV2;
    const projects = yield* Projects.ProjectStoreV2;
    const providerSessions =
      options.providerSessions ?? (yield* ProviderSessions.ProviderSessionManagerV2);
    const layer = Service.layer.pipe(
      Layer.provide(Layer.succeed(ProviderSessions.ProviderSessionManagerV2, providerSessions)),
      Layer.provide(
        Threads.layer.pipe(Layer.provide(Layer.succeed(Orchestrator.OrchestratorV2, orchestrator))),
      ),
      Layer.provide(Layer.succeed(Orchestrator.OrchestratorV2, orchestrator)),
      Layer.provide(Layer.succeed(Projections.ProjectionStoreV2, projections)),
      Layer.provide(Layer.succeed(Projects.ProjectStoreV2, projects)),
      Layer.provide(
        Layer.succeed(Native.GrokBotNativeRuntimeService, options.native ?? makeNative()),
      ),
      Layer.provide(
        Layer.mock(Config.GrokBotOrchestratorService)({
          inspect: options.inspect ?? (() => Effect.succeed(ready)),
        }),
      ),
      Layer.provide(
        Layer.mock(Bots.GrokBotService)({
          list: Effect.succeed(options.bots ?? [bot]),
          delete: options.botDelete ?? ((input) => Effect.succeed({ botId: input.botId })),
        }),
      ),
      Layer.provide(
        Layer.mock(Folders.ManagedProjectFolders)({
          namedProjectsRoot: "/tmp/unused-projects",
          ensureScratchProject: options.scratchUnavailable
            ? Effect.fail(new Folders.ScratchUnavailableError())
            : Effect.succeed({ projectId: scratchProjectId }),
        }),
      ),
      Layer.provide(
        Settings.layerTest({
          defaultRuntimeMode: "approval-required",
          providerInstances: { [instanceId]: { driver: "grok-bot", enabled: true } },
          projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: "full-access" } },
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    const context = yield* Layer.build(layer);
    return Context.get(context, Service.GrokBotThreadService);
  });
const create = (id: string, selected = selection) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: ThreadId.make(id),
      projectId,
      title: "Existing bot",
      modelSelection: selected,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

it.effect(
  "agent messages restart an unsettled pending Grok attempt instead of queueing indefinitely",
  () =>
    Effect.gen(function* () {
      yield* observing;
      nativeHistory.length = 0;
      const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
      const controlledSessions = {
        ...sessions,
        open: (input: Parameters<typeof sessions.open>[0]) =>
          sessions.get(input.providerSessionId).pipe(
            Effect.flatMap((existing) =>
              Option.isSome(existing)
                ? sessions.open(input)
                : Effect.fail(
                    new ProviderSessions.ProviderSessionOpenError({
                      instanceId: input.modelSelection.instanceId,
                      providerSessionId: input.providerSessionId,
                      cause: "This test keeps read-only observer sessions unopened.",
                    }),
                  ),
            ),
          ),
      };
      const service = yield* fixture({ providerSessions: controlledSessions });
      const caller = { requestNamespace: "agent-followup" };
      const first = yield* service.send(
        { botId: bot.id, message: "first", clientRequestId: "first" },
        caller,
      );
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const initial = yield* orchestrator.getThreadProjection(first.threadId!);
      const run = initial.runs[0]!;
      if (run.rootNodeId === null || run.providerThreadId === null)
        return yield* Effect.die("The first Grok run must retain its root and provider thread.");
      const rootNode = initial.nodes.find((node) => node.id === run.rootNodeId);
      const providerThread = initial.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      if (rootNode?.providerThreadId !== run.providerThreadId || providerThread === undefined)
        return yield* Effect.die("The pending Grok turn must reference the run's provider thread.");
      const providerSessionId = providerThread.providerSessionId;
      if (providerSessionId === null)
        return yield* Effect.die("The pending Grok provider thread must retain its session.");
      const sessionCensus = {
        runBoundThreads: initial.providerThreads.filter(
          (candidate) =>
            candidate.id === run.providerThreadId && candidate.providerSessionId !== null,
        ).length,
        observedSessions: initial.providerSessions.filter((candidate) =>
          candidate.id.startsWith("provider-session:grok-bot-observe:"),
        ).length,
      };
      assert.deepEqual(sessionCensus, { runBoundThreads: 1, observedSessions: 0 });
      const projects = yield* Projects.ProjectStoreV2;
      const project = yield* projects.getShell(initial.thread.projectId);
      if (Option.isNone(project))
        return yield* Effect.die("The pending run must retain its project workspace.");
      const runSession = yield* sessions.open({
        threadId: first.threadId!,
        providerSessionId,
        modelSelection: initial.thread.modelSelection,
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: initial.thread.runtimeMode,
          interactionMode: initial.thread.interactionMode,
          cwd: initial.thread.worktreePath ?? project.value.workspaceRoot,
        }),
      });
      assert.equal(runSession.providerSessionId, providerSessionId);
      const withSession = yield* orchestrator.getThreadProjection(first.threadId!);
      assert.isTrue(
        withSession.providerSessions.some((session) => session.id === providerSessionId),
      );
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("agent-followup-seed"),
        events: [
          {
            id: EventId.make("agent-followup-run"),
            type: "run.updated",
            threadId: first.threadId!,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now },
          },
          {
            id: EventId.make("agent-followup-turn"),
            type: "provider-turn.updated",
            threadId: first.threadId!,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: ProviderTurnId.make("agent-followup-pending"),
              providerThreadId: providerThread.id,
              nodeId: rootNode.id,
              runAttemptId: run.activeAttemptId,
              nativeTurnRef: null,
              ordinal: 1,
              status: "pending",
              startedAt: null,
              completedAt: null,
            },
          },
        ],
      });
      const next = yield* service.send(
        { botId: bot.id, message: "follow up", clientRequestId: "followup" },
        caller,
      );
      assert.equal(next.delivery, "started");
      const updated = yield* orchestrator.getThreadProjection(first.threadId!);
      assert.lengthOf(updated.runs, 1);
      assert.notEqual(updated.runs[0]?.activeAttemptId, run.activeAttemptId);
      assert.equal(
        updated.attempts.find((attempt) => attempt.id === run.activeAttemptId)?.status,
        "superseded",
      );
      const retry = yield* service.send(
        { botId: bot.id, message: "follow up", clientRequestId: "followup" },
        caller,
      );
      assert.deepEqual(retry, next);
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "agent messages use the canonical thread, queue behind work, and deduplicate retries",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const service = yield* fixture();
      const caller = {
        requestNamespace: "caller-one",
        senderThreadId: ThreadId.make("coordinating-agent"),
      };
      const first = yield* service.send(
        { botId: bot.id, message: "first", clientRequestId: "first" },
        caller,
      );
      const retry = yield* service.send(
        { botId: bot.id, message: "first", clientRequestId: "first" },
        caller,
      );
      assert.deepEqual(retry, first);
      const second = yield* service.send(
        { botId: bot.id, message: "second", clientRequestId: "second" },
        caller,
      );
      assert.equal(second.delivery, "queued");
      assert.equal(first.threadId, second.threadId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* orchestrator.getThreadProjection(first.threadId!);
      assert.equal(projection.messages.filter((message) => message.role === "user").length, 2);
      for (const message of projection.messages.filter((entry) => entry.role === "user")) {
        assert.equal(message.senderThreadId, caller.senderThreadId);
        assert.equal(message.createdBy, "agent");
        assert.equal(message.creationSource, "mcp");
      }
      assert.equal(projection.runs.length, 2);
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "concurrent devices and a fresh service reuse one ordinary V2 thread and preserve explicit unpin",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const service = yield* fixture();
      const results = yield* Effect.forEach(
        Array.from({ length: 12 }),
        () => service.open({ botId: bot.id, projectId }),
        { concurrency: "unbounded" },
      );
      assert.equal(new Set(results.map((result) => result.threadId)).size, 1);
      const id = results[0]!.threadId;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* orchestrator.getThreadProjection(id);
      assert.equal(projection.thread.projectId, scratchProjectId);
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.title, bot.name);
      assert.isNotNull(projection.thread.pinnedAt);
      assert.equal(projection.runs.length, 0);
      yield* orchestrator.dispatch({
        type: "thread.unpin",
        commandId: CommandId.make("explicit-unpin"),
        threadId: id,
      });
      const recreated = yield* fixture();
      assert.equal(
        (yield* recreated.open({ botId: bot.id, projectId: otherProjectId })).threadId,
        id,
      );
      assert.isNull((yield* orchestrator.getThreadProjection(id)).thread.pinnedAt);
      assert.equal((yield* orchestrator.getShellSnapshot()).threads.length, 1);
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("restores the canonical bot conversation without taking an ordinary project thread", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const canonicalId = yield* canonicalIdForFixture;
    yield* create(canonicalId);
    yield* create("ordinary-user-bot");
    yield* create("other-account", {
      instanceId: ProviderInstanceId.make("another-account"),
      model: bot.id,
    });
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pin",
      commandId: CommandId.make("existing-pin"),
      threadId: canonicalId,
    });
    const pinned = (yield* orchestrator.getThreadProjection(canonicalId)).thread.pinnedAt;
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("existing-archive"),
      threadId: canonicalId,
    });
    const service = yield* fixture({ bots: [{ ...bot, pinned: false }] });
    assert.equal((yield* service.open({ botId: bot.id })).threadId, canonicalId);
    const restored = yield* orchestrator.getThreadProjection(canonicalId);
    assert.isNull(restored.thread.archivedAt);
    assert.equal(restored.thread.projectId, scratchProjectId);
    assert.deepStrictEqual(restored.thread.pinnedAt, pinned);
    assert.equal(
      (yield* orchestrator.getThreadProjection(ThreadId.make("ordinary-user-bot"))).thread
        .projectId,
      projectId,
    );
    assert.equal((yield* orchestrator.getShellSnapshot()).threads.length, 3);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("requires No project storage even when an older client provides a project", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* fixture({ scratchUnavailable: true });
    assert.equal(
      (yield* Effect.flip(service.open({ botId: bot.id }))).message,
      "Grok Bot conversations require No project storage, which is unavailable in this environment.",
    );
    const missing = yield* Effect.flip(
      service.open({ botId: bot.id, projectId: ProjectId.make("missing") }),
    );
    assert.equal(missing.reason, "scratch_unavailable");
    const linked = yield* fixture({
      bots: [
        {
          ...bot,
          pullRequests: [
            {
              reference: { projectId: otherProjectId, repository: "owner/repo", number: 1 },
              url: "https://example.test/pr/1",
              title: "Linked",
              state: "open",
            },
          ],
        },
      ],
    });
    const result = yield* linked.open({ botId: bot.id });
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    assert.equal(
      (yield* orchestrator.getThreadProjection(result.threadId)).thread.projectId,
      scratchProjectId,
    );
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "creates its canonical conversation separately from a user-created bot project thread",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* create("ordinary-user-bot");
      const canonicalId = yield* canonicalIdForFixture;
      const service = yield* fixture();
      const opened = yield* service.open({ botId: bot.id, projectId: ProjectId.make("missing") });
      assert.equal(opened.threadId, canonicalId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      assert.equal(
        (yield* orchestrator.getThreadProjection(canonicalId)).thread.projectId,
        scratchProjectId,
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(ThreadId.make("ordinary-user-bot"))).thread
          .projectId,
        projectId,
      );
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "rebinds an existing canonical conversation without losing its history, identity, or explicit pin",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const canonicalId = yield* canonicalIdForFixture;
      yield* create(canonicalId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("legacy-workspace"),
        threadId: canonicalId,
        branch: "old-project-branch",
        worktreePath: "/tmp/old-project-checkout",
      });
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("legacy-pin"),
        threadId: canonicalId,
      });
      const projections = yield* Projections.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const providerSessionId = ProviderSessionId.make("existing-native-session");
      yield* projections.apply({
        id: EventId.make("existing-native-session"),
        type: "provider-session.updated",
        threadId: canonicalId,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver: GROK_BOT_DRIVER_KIND,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/tmp/old-project-checkout",
          model: bot.id,
          capabilities: GrokBotCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      yield* projections.apply({
        id: EventId.make("existing-native-thread"),
        type: "provider-thread.updated",
        threadId: canonicalId,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make("existing-native-thread"),
          driver: GROK_BOT_DRIVER_KIND,
          providerInstanceId: instanceId,
          providerSessionId,
          appThreadId: canonicalId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: GROK_BOT_DRIVER_KIND,
            nativeId: "native-conversation",
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      const before = yield* orchestrator.getThreadProjection(canonicalId);
      yield* projections.apply({
        id: EventId.make("legacy-message"),
        type: "message.updated",
        threadId: canonicalId,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: MessageId.make("legacy-message"),
          threadId: canonicalId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text: "The previous bot conversation remains available.",
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: now,
          updatedAt: now,
        },
      });
      const history = yield* orchestrator.getThreadProjection(canonicalId);
      const service = yield* fixture();
      assert.equal((yield* service.open({ botId: bot.id })).threadId, canonicalId);
      const after = yield* orchestrator.getThreadProjection(canonicalId);
      assert.equal(after.thread.projectId, scratchProjectId);
      assert.isNull(after.thread.branch);
      assert.isNull(after.thread.worktreePath);
      assert.deepStrictEqual(after.thread.pinnedAt, before.thread.pinnedAt);
      assert.deepStrictEqual(after.thread.createdAt, before.thread.createdAt);
      assert.deepStrictEqual(after.thread.modelSelection, before.thread.modelSelection);
      assert.equal(after.thread.activeProviderThreadId, before.thread.activeProviderThreadId);
      const boundProviderSessions = (sessions: typeof after.providerSessions) =>
        sessions.filter(
          (session) => !String(session.id).startsWith("provider-session:grok-bot-observe:"),
        );
      assert.deepStrictEqual(
        boundProviderSessions(after.providerSessions),
        boundProviderSessions(before.providerSessions),
      );
      assert.deepStrictEqual(after.providerThreads, before.providerThreads);
      assert.deepStrictEqual(after.messages, history.messages);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly project_id: string }>`
        SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ${canonicalId}
      `;
      assert.equal(rows[0]?.project_id, scratchProjectId);
      assert.equal((yield* (yield* fixture()).open({ botId: bot.id })).threadId, canonicalId);
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("refuses to migrate a bot conversation with active work without cancelling it", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const canonicalId = yield* canonicalIdForFixture;
    yield* create(canonicalId);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("active-bot-turn"),
      threadId: canonicalId,
      messageId: MessageId.make("active-bot-message"),
      text: "Continue the existing task.",
      attachments: [],
      modelSelection: selection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const before = yield* orchestrator.getThreadProjection(canonicalId);
    const service = yield* fixture();
    assert.equal((yield* Effect.flip(service.open({ botId: bot.id }))).reason, "thread_active");
    assert.equal(
      (yield* Effect.flip(
        orchestrator.dispatch({
          type: "grok-bot.thread.rebind",
          commandId: CommandId.make("rebind-active-bot"),
          threadId: canonicalId,
          projectId: scratchProjectId,
        }),
      ))._tag,
      "OrchestratorDispatchError",
    );
    const after = yield* orchestrator.getThreadProjection(canonicalId);
    assert.deepStrictEqual(after.thread, before.thread);
    assert.deepStrictEqual(after.runs, before.runs);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "the internal rebind cannot move an ordinary thread or use an unavailable destination",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      yield* create("ordinary-user-bot");
      const canonicalId = yield* canonicalIdForFixture;
      yield* create(canonicalId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const [threadId, destination] of [
        [ThreadId.make("ordinary-user-bot"), scratchProjectId],
        [canonicalId, ProjectId.make("missing")],
      ] as const) {
        yield* Effect.flip(
          orchestrator.dispatch({
            type: "grok-bot.thread.rebind",
            commandId: CommandId.make(`invalid-rebind:${threadId}`),
            threadId,
            projectId: destination,
          }),
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).thread.projectId,
          projectId,
        );
      }
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("reopens an active No project conversation without clearing its managed folder", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* fixture();
    const { threadId } = yield* service.open({ botId: bot.id });
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("scratch-thread-folder"),
      threadId,
      worktreePath: "/tmp/scratch/bot-conversation",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("active-scratch-turn"),
      threadId,
      messageId: MessageId.make("active-scratch-message"),
      text: "Talk about a task.",
      attachments: [],
      modelSelection: selection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const before = yield* orchestrator.getThreadProjection(threadId);
    assert.equal((yield* service.open({ botId: bot.id, projectId })).threadId, threadId);
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(after.thread.worktreePath, "/tmp/scratch/bot-conversation");
    assert.deepStrictEqual(after.thread, before.thread);
    assert.deepStrictEqual(after.runs, before.runs);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("opens and restores the same bot thread when managed delivery is unavailable", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* fixture({
      inspect: () =>
        Effect.succeed({
          ...ready,
          state: "blocked",
          publicEndpointReadiness: { ready: false, reason: "Connect is unavailable." },
          provider: { ...ready.provider!, status: "error" },
        }),
    });
    const { threadId } = yield* service.open({ botId: bot.id, projectId });
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-unavailable-delivery"),
      threadId,
    });
    assert.equal((yield* service.open({ botId: bot.id })).threadId, threadId);
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.archivedAt);
    assert.equal(projection.runs.length, 0);
    assert.equal((yield* orchestrator.getShellSnapshot()).threads.length, 1);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "refuses unbound providers, wrong accounts, unknown bots, and an account switch during validation",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      for (const state of [
        "account_changed",
        "native_account_unavailable",
        "not_configured",
      ] as const) {
        const service = yield* fixture({ inspect: () => Effect.succeed({ ...ready, state }) });
        assert.equal(
          (yield* Effect.flip(service.open({ botId: bot.id, projectId })))._tag,
          "GrokBotThreadError",
        );
      }
      const unbound = yield* fixture({
        inspect: () => Effect.succeed({ ...ready, state: "blocked", provider: null }),
      });
      assert.equal(
        (yield* Effect.flip(unbound.open({ botId: bot.id, projectId }))).reason,
        "provider_not_ready",
      );
      const unknown = yield* fixture({
        inspect: () => Effect.fail(new GrokBotError({ reason: "bot_not_found" })),
      });
      assert.equal(
        (yield* Effect.flip(unknown.open({ botId: "unknown", projectId })))._tag,
        "GrokBotError",
      );
      const binding = yield* Ref.make(accountBinding);
      const changed = yield* fixture({
        native: makeNative({ accountBinding: Ref.get(binding) }),
        inspect: (input) =>
          input.botId === undefined
            ? Effect.succeed({ ...ready, state: "account_changed" as const })
            : Ref.set(binding, "other-account").pipe(Effect.as(ready)),
      });
      assert.equal(
        (yield* Effect.flip(changed.open({ botId: bot.id, projectId }))).message,
        "The selected Grok Bot account changed. Open the bot again after restoring its account.",
      );
      assert.equal(
        (yield* (yield* Orchestrator.OrchestratorV2).getShellSnapshot()).threads.length,
        0,
      );
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "does not create a thread when account or provider changes during its final validation",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      for (const change of ["account", "provider"] as const) {
        const binding = yield* Ref.make(accountBinding);
        const inspections = yield* Ref.make(0);
        const service = yield* fixture({
          native: makeNative({ accountBinding: Ref.get(binding) }),
          inspect: () =>
            Effect.gen(function* () {
              const previous = yield* Ref.getAndUpdate(inspections, (count) => count + 1);
              if (previous === 0) return ready;
              if (change === "account") yield* Ref.set(binding, "other-account");
              return {
                ...ready,
                state: "blocked",
                provider:
                  change === "provider"
                    ? { ...ready.provider!, instanceId: ProviderInstanceId.make("replacement") }
                    : ready.provider,
              };
            }),
        });
        const error = yield* Effect.flip(service.open({ botId: bot.id, projectId }));
        assert.equal(error.reason, change === "account" ? "account_changed" : "provider_not_ready");
        assert.equal(
          (yield* (yield* Orchestrator.OrchestratorV2).getShellSnapshot()).threads.length,
          0,
        );
      }
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "a process restart after create resumes pinning and never resurrects a deleted canonical thread",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-thread-" });
      const database = Sqlite.layerFromPath(`${directory}/state.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const firstId = yield* Effect.gen(function* () {
        yield* seedProjects;
        const original = yield* Orchestrator.OrchestratorV2;
        const service = yield* fixture({
          orchestrator: {
            ...original,
            dispatch: (command) =>
              command.type === "thread.pin"
                ? Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                    }),
                  )
                : original.dispatch(command),
          },
        });
        assert.equal(
          (yield* Effect.flip(service.open({ botId: bot.id, projectId })))._tag,
          "GrokBotThreadError",
        );
        const snapshot = yield* original.getShellSnapshot();
        assert.equal(snapshot.threads.length, 1);
        assert.isNull(snapshot.threads[0]!.pinnedAt);
        return snapshot.threads[0]!.id;
      }).pipe(Effect.provide(runtime(database)), Effect.scoped);
      yield* Effect.gen(function* () {
        const service = yield* fixture();
        const result = yield* service.open({ botId: bot.id });
        assert.equal(result.threadId, firstId);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        assert.isNotNull((yield* orchestrator.getThreadProjection(firstId)).thread.pinnedAt);
        assert.equal((yield* orchestrator.getShellSnapshot()).threads.length, 1);
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-canonical"),
          threadId: firstId,
        });
        const error = yield* Effect.flip(service.open({ botId: bot.id, projectId }));
        assert.equal(error.reason, "thread_deleted");
        assert.equal((yield* orchestrator.getShellSnapshot()).threads.length, 0);
      }).pipe(Effect.provide(runtime(database)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("profile PR links do not bind or populate the bot's backing conversation", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* fixture({
      bots: [
        {
          ...bot,
          pullRequests: [projectId, otherProjectId].map((id, index) => ({
            reference: { projectId: id, repository: "owner/repo", number: index + 1 },
            url: `https://github.com/owner/repo/pull/${index + 1}`,
            title: "Linked",
            state: "open" as const,
          })),
        },
      ],
    });
    const { threadId } = yield* service.open({ botId: bot.id, projectId: otherProjectId });
    const thread = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId))
      .thread;
    assert.equal(thread.projectId, scratchProjectId);
    assert.deepStrictEqual(thread.pullRequests ?? [], []);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("does not reclaim a persistent thread whose model the user changed", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const service = yield* fixture();
    const { threadId } = yield* service.open({ botId: bot.id, projectId });
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("change-bot-model"),
      threadId,
      modelSelection: { instanceId, model: "other-bot" },
    });
    const error = yield* Effect.flip(service.open({ botId: bot.id, projectId }));
    assert.match(error.message, /different provider or model/);
    assert.equal(
      (yield* orchestrator.getThreadProjection(threadId)).thread.modelSelection.model,
      "other-bot",
    );
    assert.equal((yield* orchestrator.getShellSnapshot()).threads.length, 1);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it("recognizes only canonical backing IDs and keeps rebind outside client commands", () => {
  assert.isTrue(isGrokBotBackingThread({ id: "grok-bot:canonical" }));
  assert.isFalse(isGrokBotBackingThread({ id: "thread:ordinary-grok-bot" }));
  assert.isFalse(isGrokBotBackingThread({ id: "delegated:grok-bot:child" }));
  assert.isFalse(
    isClientCommand({
      type: "grok-bot.thread.rebind",
      commandId: CommandId.make("not-a-client-command"),
      threadId: ThreadId.make("grok-bot:canonical"),
      projectId: scratchProjectId,
    }),
  );
});

it.effect(
  "a process restart retains the canonical conversation's migrated storage and history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-rebind-" });
      const database = Sqlite.layerFromPath(`${directory}/state.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const migrated = yield* Effect.gen(function* () {
        yield* seedProjects;
        const canonicalId = yield* canonicalIdForFixture;
        yield* create(canonicalId);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("old-persistent-workspace"),
          threadId: canonicalId,
          branch: "old-branch",
          worktreePath: "/tmp/old-worktree",
        });
        yield* orchestrator.dispatch({
          type: "thread.pin",
          commandId: CommandId.make("old-persistent-pin"),
          threadId: canonicalId,
        });
        const projections = yield* Projections.ProjectionStoreV2;
        const now = yield* DateTime.now;
        yield* projections.apply({
          type: "message.updated",
          id: EventId.make("persistent-old-message"),
          threadId: canonicalId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: MessageId.make("persistent-old-message"),
            threadId: canonicalId,
            runId: null,
            nodeId: null,
            role: "assistant",
            text: "Existing bot history.",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* (yield* fixture()).open({ botId: bot.id });
        return yield* orchestrator.getThreadProjection(canonicalId);
      }).pipe(Effect.provide(runtime(database)), Effect.scoped);
      yield* Effect.gen(function* () {
        assert.equal(
          (yield* (yield* fixture()).open({ botId: bot.id })).threadId,
          migrated.thread.id,
        );
        const after = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          migrated.thread.id,
        );
        assert.equal(after.thread.projectId, scratchProjectId);
        assert.isNull(after.thread.branch);
        assert.isNull(after.thread.worktreePath);
        assert.deepStrictEqual(after.thread.pinnedAt, migrated.thread.pinnedAt);
        assert.deepStrictEqual(after.messages, migrated.messages);
      }).pipe(Effect.provide(runtime(database)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const observing = Effect.gen(function* () {
  observedSessions.length = 0;
  yield* seedProjects;
});

it.effect(
  "re-attaches native observation for an existing bot thread with no T3 turn, once while live",
  () =>
    Effect.gen(function* () {
      yield* observing;
      const canonicalId = yield* canonicalIdForFixture;
      yield* create(canonicalId);
      const service = yield* fixture();
      yield* service.observeAll;
      yield* service.observeAll;
      assert.equal(observedSessions.length, 1);
      assert.isTrue(observedSessions[0]!.startsWith(`${canonicalId}:`));
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      assert.equal((yield* orchestrator.getThreadProjection(canonicalId)).runs.length, 0);
      // Idle release, the pin cap, and a restart all leave no session: the next pass restores it.
      const manager = yield* ProviderSessions.ProviderSessionManagerV2;
      const sessionId = observedSessions[0]!.slice(canonicalId.length + 1);
      yield* manager.close(ProviderSessionId.make(sessionId));
      const restarted = yield* fixture();
      yield* restarted.observeAll;
      assert.equal(observedSessions.length, 2);
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("deleting a bot deletes its observing thread only after the bot is gone", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const canonicalId = yield* canonicalIdForFixture;
    yield* create(canonicalId);
    const projections = yield* Projections.ProjectionStoreV2;
    const failing = yield* fixture({
      botDelete: () => Effect.fail(new GrokBotError({ reason: "delete_uncertain" })),
    });
    const failure = yield* Effect.flip(failing.deleteBot({ botId: bot.id }));
    assert.equal(failure.reason, "delete_uncertain");
    assert.equal((yield* projections.getThread(canonicalId)).deletedAt, null);
    const service = yield* fixture();
    assert.deepEqual(yield* service.deleteBot({ botId: bot.id }), { botId: bot.id });
    assert.notEqual((yield* projections.getThread(canonicalId)).deletedAt, null);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "observation creates one searchable thread per bot but never revives or crosses accounts",
  () =>
    Effect.gen(function* () {
      yield* observing;
      const none = yield* fixture();
      yield* none.observeAll;
      yield* none.observeAll;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const canonicalId = yield* canonicalIdForFixture;
      // A bot never opened in T3 still gets its canonical thread, so native history can be imported and searched.
      const created = (yield* orchestrator.getShellSnapshot()).threads;
      assert.deepEqual(
        created.map((thread) => thread.id),
        [canonicalId],
      );
      assert.equal(observedSessions.length, 1);
      assert.equal((yield* orchestrator.getThreadProjection(canonicalId)).runs.length, 0);
      observedSessions.length = 0;
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("observe-archive"),
        threadId: canonicalId,
      });
      yield* none.observeAll;
      const changed = yield* fixture({
        inspect: () => Effect.succeed({ ...ready, state: "account_changed" as const }),
      });
      yield* changed.observeAll;
      assert.equal(observedSessions.length, 0);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("observe-delete"),
        threadId: canonicalId,
      });
      yield* none.observeAll;
      assert.equal(observedSessions.length, 0);
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("native history of a never-opened bot reaches thread search through observation", () =>
  Effect.gen(function* () {
    yield* observing;
    nativeHistory.length = 0;
    nativeHistory.push(
      { id: "u1", role: "user", text: "remind me about the quokka-ledger migration" },
      { id: "a1", role: "assistant", text: "the quokka-ledger migration is scheduled" },
    );
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const canonicalId = yield* canonicalIdForFixture;
    // The bot has no T3 thread: nothing to search before observation.
    assert.deepEqual((yield* orchestrator.getShellSnapshot()).threads, []);
    const search = yield* ThreadSearch.ThreadSearch;
    assert.deepEqual((yield* search.search({ query: "quokka-ledger" })).matches, []);
    // Await the persisted import events themselves rather than sleeping.
    const imported = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "message.updated"),
      Stream.take(2),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    const service = yield* fixture();
    yield* service.observeAll;
    yield* Fiber.join(imported);
    const matches = (yield* search.search({ query: "quokka-ledger" })).matches;
    assert.deepEqual(
      matches.map((match) => [match.threadId, match.source]),
      [[canonicalId, "user"]],
    );
    assert.equal((yield* orchestrator.getThreadProjection(canonicalId)).runs.length, 0);
    nativeHistory.length = 0;
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("observation does not reclaim a thread whose model the user changed", () =>
  Effect.gen(function* () {
    yield* observing;
    const canonicalId = yield* canonicalIdForFixture;
    yield* create(canonicalId);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("observe-model-change"),
      threadId: canonicalId,
      modelSelection: { instanceId, model: "other-bot" },
    });
    const service = yield* fixture();
    yield* service.observeAll;
    assert.equal(observedSessions.length, 0);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("observation uses a dedicated session after restart instead of a stopped binding", () =>
  Effect.gen(function* () {
    yield* observing;
    const canonicalId = yield* canonicalIdForFixture;
    yield* create(canonicalId);
    const projections = yield* Projections.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const stoppedSessionId = ProviderSessionId.make("stopped-native-session");
    yield* projections.apply({
      id: EventId.make("stopped-native-session"),
      type: "provider-session.updated",
      threadId: canonicalId,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: stoppedSessionId,
        driver: GROK_BOT_DRIVER_KIND,
        providerInstanceId: instanceId,
        status: "stopped",
        cwd: "/tmp/bot-project",
        model: bot.id,
        capabilities: GrokBotCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("stopped-native-thread"),
      type: "provider-thread.updated",
      threadId: canonicalId,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("stopped-native-thread"),
        driver: GROK_BOT_DRIVER_KIND,
        providerInstanceId: instanceId,
        providerSessionId: stoppedSessionId,
        appThreadId: canonicalId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: GROK_BOT_DRIVER_KIND,
          nativeId: "native-conversation",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const service = yield* fixture();
    yield* service.observeAll;
    assert.equal(observedSessions.length, 1);
    assert.equal(
      observedSessions[0],
      `${canonicalId}:provider-session:grok-bot-observe:${canonicalId}`,
    );
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    assert.equal((yield* orchestrator.getThreadProjection(canonicalId)).runs.length, 0);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("observation switches to a live bound session instead of doubling the native watch", () =>
  Effect.gen(function* () {
    yield* observing;
    const canonicalId = yield* canonicalIdForFixture;
    yield* create(canonicalId);
    const service = yield* fixture();
    yield* service.observeAll;
    const observeSessionId = ProviderSessionId.make(
      observedSessions[0]!.slice(canonicalId.length + 1),
    );
    const manager = yield* ProviderSessions.ProviderSessionManagerV2;
    const boundSessionId = ProviderSessionId.make("live-bound-session");
    const projections = yield* Projections.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* manager.open({
      threadId: canonicalId,
      providerSessionId: boundSessionId,
      modelSelection: selection,
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: Option.getOrThrow(yield* (yield* Projects.ProjectStoreV2).get(scratchProjectId))
          .workspaceRoot,
      },
    });
    yield* projections.apply({
      id: EventId.make("live-bound-thread"),
      type: "provider-thread.updated",
      threadId: canonicalId,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("live-bound-thread"),
        driver: GROK_BOT_DRIVER_KIND,
        providerInstanceId: instanceId,
        providerSessionId: boundSessionId,
        appThreadId: canonicalId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: GROK_BOT_DRIVER_KIND,
          nativeId: "native-conversation",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* service.observeAll;
    assert.equal(observedSessions.at(-1), `${canonicalId}:${boundSessionId}`);
    assert.isTrue(Option.isNone(yield* manager.get(observeSessionId)));
    assert.isTrue(Option.isSome(yield* manager.get(boundSessionId)));
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect("viewing the bot re-attaches observation without waiting for the next pass", () =>
  Effect.gen(function* () {
    yield* observing;
    const canonicalId = yield* canonicalIdForFixture;
    yield* create(canonicalId);
    const service = yield* fixture({ inspect: () => Effect.succeed(ready) });
    yield* service.observeAll;
    assert.equal(observedSessions.length, 1);
    const manager = yield* ProviderSessions.ProviderSessionManagerV2;
    yield* manager.close(
      ProviderSessionId.make(observedSessions[0]!.slice(canonicalId.length + 1)),
    );
    yield* service.open({ botId: bot.id });
    assert.equal(observedSessions.length, 2);
  }).pipe(Effect.provide(runtime()), Effect.scoped),
);

it.effect(
  "restores a dropped native watch on the five-second sweep without reopening healthy watches",
  () =>
    Effect.gen(function* () {
      yield* observing;
      const canonicalId = yield* canonicalIdForFixture;
      yield* create(canonicalId);
      const manager = yield* ProviderSessions.ProviderSessionManagerV2;
      const firstSweep = yield* Deferred.make<void>();
      const restored = yield* Deferred.make<void>();
      let opens = 0;
      yield* fixture({
        providerSessions: {
          ...manager,
          open: (input) =>
            manager.open(input).pipe(
              Effect.tap(() => {
                opens++;
                return Deferred.succeed(opens === 1 ? firstSweep : restored, undefined);
              }),
            ),
        },
      });
      yield* Deferred.await(firstSweep);
      const sessionId = ProviderSessionId.make(observedSessions[0]!.slice(canonicalId.length + 1));
      yield* manager.close(sessionId);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(restored);
      assert.isTrue(Option.isSome(yield* manager.get(sessionId)));
      assert.equal(observedSessions.length, 2);
      yield* TestClock.adjust("5 seconds");
      assert.equal(observedSessions.length, 2);
      assert.equal(
        (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(canonicalId)).runs.length,
        0,
      );
    }).pipe(Effect.provide(runtime()), Effect.scoped),
);
