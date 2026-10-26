import * as MergeGit from "../vcs/GitVcsDriver.ts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  GrokBotCompleteTurnResult,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadSendResult,
  type OrchestrationV2StoredEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedEndpoint from "../cloud/ManagedEndpointAddress.ts";
import * as ManagedState from "../grokBot/GrokBotManagedStateStore.ts";
import { GrokBotManagedBinding } from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import * as BindingLive from "../grokBot/GrokBotManagedBindingLive.ts";
import * as Native from "../grokBot/GrokBotNativeRuntimeService.ts";
import * as NativeAuthority from "../grokBot/GrokBotMcpAuthority.ts";
import * as Completion from "../grokBot/GrokBotTurnCompletion.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Ingestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as Activity from "./McpToolActivity.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as AdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as LegacyImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  createGrokBotAdapterV2,
  GrokBotCapabilitiesV2,
} from "../orchestration-v2/Adapters/GrokBotAdapterV2.ts";
import {
  makeNative,
  accountBinding,
} from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Enrichment from "../project/ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import * as WorktreeSetup from "../project/WorktreeSetupTracker.ts";
import * as CloneTracker from "../project/ProjectCloneTracker.ts";
import * as SetupScripts from "../project/ProjectSetupScriptRunner.ts";
import * as Terminal from "../terminal/Manager.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Settings from "../serverSettings.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as Scheduled from "../scheduledTasks/ScheduledTaskService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import { callAcpMcpTool } from "./AcpMcpStdioBridge.ts";
import * as Http from "./McpHttpServer.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Registry from "./McpSessionRegistry.ts";
import * as RemoteCredentials from "./McpRemoteCredentialStore.ts";
import * as ProjectTools from "./toolkits/project/tools.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import * as CompletionTools from "./toolkits/grokBot/completion.ts";

const endpoint = "https://shell-fixture.invalid/mcp";
const projectId = ProjectId.make("shell-fixture-project");
const nativeInstance = ProviderInstanceId.make("shell-native-fixture");
const childInstance = ProviderInstanceId.make("shell-child-fixture");
const selection = { instanceId: nativeInstance, model: "owned-fixture-bot" };
const childSelection = { instanceId: childInstance, model: "deterministic-child" };
const childDriver = ProviderDriverKind.make("shell-child");
const finalAnswer = "The isolated delegated task completed.";
const preliminaryAnswer = "A native reply does not declare T3 completion.";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "shell-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "shell-test", version: "1" },
  },
  getClient: Effect.die("No outside MCP clients in this isolated test"),
});
const rpcRequest = Schema.Struct({
  id: Schema.optionalKey(Schema.Unknown),
  method: Schema.String,
  params: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
const decodeRpc = Schema.decodeUnknownSync(rpcRequest);
const bridgeResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
  ),
});
const decodeBridgeResult = Schema.decodeUnknownEffect(bridgeResult);
const decodeLaunch = Schema.decodeUnknownEffect(
  Schema.Struct({ threadId: ThreadId, runId: Schema.NullOr(RunId) }),
);
const decodeTask = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeCompletion = Schema.decodeUnknownEffect(GrokBotCompleteTurnResult);
const decodeQueued = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeProjects = Schema.decodeUnknownEffect(
  Schema.Struct({ projects: Schema.Array(Project) }),
);
const decodeFailure = Schema.decodeUnknownEffect(
  Schema.Struct({
    code: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
  }),
);

function snapshot(
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: string,
): ServerProvider {
  return {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: "fixture",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-10T00:00:00.000Z",
    models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
}

/** A provider event fixture only: no CLI, process, Git, filesystem checkpoint, or network execution. */
const childAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId: childInstance,
  driver: childDriver,
  getCapabilities: () => Effect.succeed(GrokBotCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      return {
        instanceId: childInstance,
        driver: childDriver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver: childDriver,
          providerInstanceId: childInstance,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? "/fixture",
          model: childSelection.model,
          capabilities: GrokBotCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromPubSub(events),
        ensureThread: (request) =>
          Effect.succeed({
            id: ProviderThreadId.make(`fixture:${request.threadId}`),
            driver: childDriver,
            providerInstanceId: childInstance,
            providerSessionId: input.providerSessionId,
            appThreadId: request.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (turn) =>
          Effect.gen(function* () {
            const at = yield* DateTime.now;
            const id = ProviderTurnId.make(`fixture:${turn.runId}`);
            const emitted: ProviderAdapter.ProviderAdapterV2Event[] = [
              {
                type: "provider_turn.updated",
                driver: childDriver,
                threadId: turn.threadId,
                providerTurn: {
                  id,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: at,
                  completedAt: null,
                },
              },
              {
                type: "message.updated",
                driver: childDriver,
                message: {
                  id: MessageId.make(`fixture-answer:${turn.runId}`),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId: turn.rootNodeId,
                  role: "assistant",
                  createdBy: "agent",
                  creationSource: "provider",
                  text: finalAnswer,
                  attachments: [],
                  streaming: false,
                  createdAt: at,
                  updatedAt: at,
                },
              },
              {
                type: "provider_turn.updated",
                driver: childDriver,
                threadId: turn.threadId,
                providerTurn: {
                  id,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: turn.providerTurnOrdinal,
                  status: "completed",
                  startedAt: at,
                  completedAt: at,
                },
              },
              {
                type: "turn.terminal",
                driver: childDriver,
                providerThreadId: turn.providerThread.id,
                providerTurnId: id,
                runOrdinal: turn.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ];
            yield* Effect.forEach(emitted, (event) => PubSub.publish(events, event), {
              discard: true,
            });
          }),
        steerTurn: () => Effect.die("No active steering in this fixture"),
        interruptTurn: () => Effect.die("No cancellation in this fixture"),
        respondToRuntimeRequest: () => Effect.die("No provider requests in this fixture"),
        readThreadSnapshot: () => Effect.die("No native snapshots in this fixture"),
        rollbackThread: () => Effect.die("No rollback in this fixture"),
        forkThread: () => Effect.die("No native forks in this fixture"),
      };
    }),
};

it.effect.each([
  "live",
  "reconstructed",
  "settlement_first",
  "reconstructed_both",
  "lookup_gap",
] as const)(
  "runs isolated MCP transport through V2 delegation, completion and durable grant fencing (%s)",
  (observation) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shell-orchestration-" });
      const state = { binding: accountBinding, sends: [] as Native.Turn[] };
      const nativeFrames = yield* PubSub.unbounded<Native.RuntimeFrame>();
      const nativeSettlement = yield* Deferred.make<Native.SettlementFrame>();
      const completionRelease = yield* Deferred.make<void>();
      const nativeReadNone = yield* Deferred.make<void>();
      const releaseNativeRead = yield* Deferred.make<void>();
      const reconstruct = observation === "reconstructed" || observation === "reconstructed_both";
      const settlementFirst =
        observation === "settlement_first" || observation === "reconstructed_both";
      const lookupGap = observation === "lookup_gap";
      if (!settlementFirst && !lookupGap) yield* Deferred.succeed(completionRelease, undefined);
      const nativeLayer = Layer.succeed(
        Native.GrokBotNativeRuntimeService,
        makeNative({
          accountBinding: Effect.sync(() => state.binding),
          watch: () => Stream.fromPubSub(nativeFrames),
          openSettlementWatch: () =>
            Effect.succeed({
              events: Stream.fromEffect(Deferred.await(nativeSettlement)).pipe(
                Stream.concat(Stream.never),
              ),
            }),
          sessionContext: ({ botId }) =>
            Effect.succeed({ bot: { agentId: botId, viewerIsOwner: true }, sessions: [] }),
          startTurn: (turn) =>
            Effect.sync(() => {
              state.sends.push(turn);
              return { delivery: "accepted" as const };
            }),
          sendStatus: (turn) =>
            Effect.sync(() => {
              const accepted = state.sends.some(
                (sent) =>
                  sent.binding === turn.binding &&
                  sent.botId === turn.botId &&
                  sent.sessionId === turn.sessionId &&
                  sent.messageId === turn.messageId,
              );
              return { status: accepted ? ("accepted" as const) : ("not_found" as const) };
            }),
        }),
      );
      const settings = Settings.layerTest({
        projectSettingsOverrides: {
          [projectId]: {
            providerInstances: {
              [nativeInstance]: { enabled: true },
              [childInstance]: { enabled: true },
            },
          },
        },
      });
      const database = Sqlite.layerMemory;
      const managed = ManagedState.layer.pipe(Layer.provide(database));
      const projection = Projection.layer.pipe(Layer.provide(database));
      const authority = NativeAuthority.layer.pipe(
        Layer.provide([nativeLayer, managed, projection]),
      );
      const remoteCredentials = RemoteCredentials.layer.pipe(Layer.provide(database));
      const registryEffect = Registry.__testing.make({ now: () => 1000 }).pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("shell-fixture")),
          getDescriptor: Effect.die("No live environment descriptor"),
        }),
      );
      const registryLayer = Layer.effect(Registry.McpSessionRegistry, registryEffect).pipe(
        Layer.provide([remoteCredentials, authority, NodeServices.layer, NodeCrypto.layer]),
      );
      const liveBindings = BindingLive.layer.pipe(
        Layer.provide([
          nativeLayer,
          managed,
          projection,
          registryLayer,
          settings,
          Layer.mock(ManagedEndpoint.ManagedEndpointAddress)({
            read: Effect.succeed({
              httpBaseUrl: "https://shell-fixture.invalid/",
              wsBaseUrl: "wss://shell-fixture.invalid/",
              providerKind: "cloudflare_tunnel",
            }),
          }),
        ]),
      );
      const bindings = Layer.effect(
        GrokBotManagedBinding,
        Effect.gen(function* () {
          const binding = yield* GrokBotManagedBinding;
          return GrokBotManagedBinding.of({
            ...binding,
            openCompletionWatch: (owned) =>
              binding
                .openCompletionWatch(owned)
                .pipe(
                  Effect.map((stream) =>
                    Stream.fromEffect(Deferred.await(completionRelease)).pipe(
                      Stream.flatMap(() => stream),
                    ),
                  ),
                ),
            lookupCompletion: (identity) =>
              binding
                .lookupCompletion(identity)
                .pipe(
                  Effect.tap((declaration) =>
                    lookupGap && declaration === undefined
                      ? Deferred.succeed(nativeReadNone, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseNativeRead)),
                        )
                      : Effect.void,
                  ),
                ),
          });
        }),
      ).pipe(Layer.provide(liveBindings));
      const adapterRegistry = Layer.effect(
        AdapterRegistry.ProviderAdapterRegistryV2,
        createGrokBotAdapterV2({
          instanceId: nativeInstance,
          displayName: undefined,
          enabled: true,
          environment: [],
          config: { accountBinding },
        }).pipe(
          Effect.map((adapter) =>
            AdapterRegistry.ProviderAdapterRegistryV2.of({
              get: (id) => Effect.succeed(id === nativeInstance ? adapter : childAdapter),
              list: () => Effect.succeed([nativeInstance, childInstance]),
            }),
          ),
        ),
      ).pipe(
        Layer.provide([nativeLayer, bindings, IdAllocator.layer]),
        Layer.provide(NodeCrypto.layer),
      );
      const replay = Replay.layerWithRegistry(
        { name: "shell-orchestration", runtimePolicyOverride: { cwd } },
        adapterRegistry,
        { databaseLayer: Layer.merge(database, managed), runEffectWorker: false },
      );
      const threads = Threads.layer.pipe(
        Layer.provide(replay),
        Layer.provide(Receipts.layer.pipe(Layer.provide(database))),
        Layer.provide(settings),
      );
      const folders = Layer.mock(ManagedFolders.ManagedProjectFolders)({
        namedProjectsRoot: cwd,
        folderForThread: () => Effect.succeedNone,
      });
      const serverConfig = Layer.effect(
        ServerConfig.ServerConfig,
        Replay.makeReplayServerConfig("shell-mcp-tools").pipe(Effect.orDie),
      ).pipe(Layer.provide(NodeServices.layer));
      const projects = ProjectService.layer.pipe(
        Layer.provide([
          replay,
          projection,
          ProjectStore.layer.pipe(Layer.provide(database)),
          IdAllocator.layer,
          WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
          Layer.mock(Enrichment.ProjectEnrichmentService)({
            getAvailable: () =>
              Effect.succeed({
                repositoryIdentity: null,
                faviconPath: null,
                repositoryIdentityResolved: true,
              }),
            invalidate: () => Effect.void,
          }),
          Layer.mock(LegacyImporter.LegacyV1ThreadImporter)({
            reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
          }),
        ]),
        Layer.provide(serverConfig),
      );
      const providers = ProviderRegistryMock.layer([
        snapshot(nativeInstance, ProviderDriverKind.make("grok-bot"), selection.model),
        snapshot(childInstance, childDriver, childSelection.model),
      ]);
      const launches = ThreadLaunch.layer.pipe(
        Layer.provide([
          threads,
          projects,
          folders,
          providers,
          IdAllocator.layer,
          settings,
          Receipts.layer.pipe(Layer.provide(database)),
          WorktreeSetup.layer,
          Layer.mock(CloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
          Layer.mock(Terminal.TerminalManager)({}),
          Layer.mock(GitWorkflow.GitWorkflowService)({}),
          Layer.mock(SetupScripts.ProjectSetupScriptRunner)({
            runForThread: () => Effect.succeed({ status: "no-script" }),
          }),
          Layer.mock(TextGeneration.TextGeneration)({}),
        ]),
      );
      const activity = Activity.layer.pipe(
        Layer.provide([
          managed,
          authority,
          projection,
          ThreadCommandExecutor.layer,
          Ingestor.layer.pipe(
            Layer.provide(Layer.mock(MergeGit.GitVcsDriver)({})),
            Layer.provide([replay, projection, IdAllocator.layer, ThreadCommandExecutor.layer]),
          ),
        ]),
        Layer.provide(NodeCrypto.layer),
      );
      const completion = Completion.layer.pipe(Layer.provide([managed, authority]));
      const serverLayer = Layer.mergeAll(
        Http.layerOrchestratorToolkit,
        Http.toolkitRegistration(ProjectTools.ProjectToolkit, ProjectHandlers.layer),
        Http.toolkitRegistration(CompletionTools.toolkit, CompletionTools.layer),
      ).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(replay),
        Layer.provideMerge(projection),
        Layer.provideMerge(threads),
        Layer.provideMerge(projects),
        Layer.provideMerge(managed),
        Layer.provideMerge(registryLayer),
        Layer.provideMerge(database),
        Layer.provide([
          activity,
          adapterRegistry,
          providers,
          folders,
          launches,
          completion,
          Layer.mock(ThreadSearch.ThreadSearch)({}),
          Layer.mock(DocumentText.DocumentText)({}),
          Layer.mock(Scheduled.ScheduledTaskService)({}),
          Layer.mock(Secrets.SecretRequests)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(Repositories.SourceControlRepositoryService)({}),
          NodeServices.layer,
        ]),
        Layer.provide(settings),
        Layer.provideMerge(serverConfig),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const registry = yield* Registry.McpSessionRegistry;
        const store = yield* ManagedState.GrokBotManagedStateStore;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const projects = yield* ProjectService.ProjectService;
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* Sessions.ProviderSessionManagerV2;
        const services = yield* Effect.context();
        // The bridge requires a Promise-returning fetch callback; only that transport boundary leaves this test Effect.
        // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
        const run = Effect.runPromiseWith(services);
        const events: OrchestrationV2StoredEvent[] = [];
        const waiting = new Map<RunId, Deferred.Deferred<void>>();
        const completed = new Map<RunId, Deferred.Deferred<void>>();
        const prepared = yield* Deferred.make<void>();
        const replyObserved = yield* Deferred.make<void>();
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.runForEach((stored) =>
            Effect.gen(function* () {
              events.push(stored);
              if (
                stored.event.type === "message.updated" &&
                stored.event.payload.text === preliminaryAnswer
              )
                yield* Deferred.succeed(replyObserved, undefined);
              const event = stored.event;
              if (event.type !== "run.updated") return;
              if (event.payload.status === "starting") yield* Deferred.succeed(prepared, undefined);
              const milestone =
                event.payload.status === "waiting"
                  ? waiting.get(event.payload.id)
                  : event.payload.status === "completed"
                    ? completed.get(event.payload.id)
                    : undefined;
              if (milestone !== undefined) yield* Deferred.succeed(milestone, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* projects.create({
          commandId: CommandId.make("shell:create-project"),
          projectId,
          title: "Isolated shell fixture",
          workspaceRoot: cwd,
          defaultModelSelection: selection,
        });
        const oauth = (access: "read-only" | "full-access"): Invocation.McpInvocationScope => ({
          environmentId: EnvironmentId.make("shell-fixture"),
          issuedAt: 1000,
          requestNamespace: `fixture-oauth-${access}`,
          capabilities: new Set(["orchestration"]),
          thread: undefined,
          client: { sessionId: `oauth-${access}`, label: "isolated external client", access },
        });
        let activeRegistry = registry;
        let requests = 0;
        // This is the HTTP client/framework boundary. Every request is intercepted; no fetch fallback exists.
        const fetchImplementation = async (url: string, init?: RequestInit): Promise<Response> => {
          assert.equal(url, endpoint);
          requests++;
          const header = new Headers(init?.headers).get("authorization") ?? "";
          const scope =
            header === "Bearer fixture-oauth-read"
              ? oauth("read-only")
              : header === "Bearer fixture-oauth-full"
                ? oauth("full-access")
                : await run(activeRegistry.resolve(header.replace(/^Bearer\s+/, "")));
          if (scope === undefined) return new Response("Unauthorized", { status: 401 });
          const request = decodeRpc(JSON.parse(String(init?.body)));
          if (request.method === "initialize")
            return Response.json(
              {
                jsonrpc: "2.0",
                id: request.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "isolated-real-toolkit", version: "1" },
                },
              },
              { headers: { "mcp-session-id": "fixture-session" } },
            );
          assert.equal(new Headers(init?.headers).get("mcp-session-id"), "fixture-session");
          if (request.method === "notifications/initialized")
            return new Response(null, { status: 202 });
          assert.equal(request.method, "tools/call");
          const result = await run(
            server
              .callTool({
                name: request.params?.name ?? "",
                arguments: request.params?.arguments ?? {},
              })
              .pipe(
                Effect.provideService(Invocation.McpInvocationContext, scope),
                Effect.provideService(McpSchema.McpServerClient, client),
              ),
          );
          return Response.json({ jsonrpc: "2.0", id: request.id, result });
        };
        const invoke = (tool: string, args: Record<string, unknown>, authorization: string) =>
          callAcpMcpTool({
            endpoint,
            authorization,
            tool,
            arguments: args,
            fetchImplementation,
          }).pipe(
            Effect.flatMap(decodeBridgeResult),
            Effect.map(
              (result) =>
                JSON.parse(
                  result.content.find((part) => part.type === "text")?.text ?? "null",
                ) as unknown,
            ),
          );
        const list = yield* invoke("t3_project_list", {}, "Bearer fixture-oauth-read").pipe(
          Effect.flatMap(decodeProjects),
        );
        assert.equal(list.projects[0]?.id, projectId);
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const managedWorkspace = path.resolve(config.baseDir, "native-agents");
        const managedProjectId = ProjectId.make("project:protected-native-storage");
        yield* fs.makeDirectory(managedWorkspace, { recursive: true });
        yield* projects.bootstrapNativeAgentProject({
          commandId: CommandId.make("shell:create-managed-project"),
          projectId: managedProjectId,
        });
        for (const force of [false, true]) {
          const protectedFailure = yield* invoke(
            "t3_project_delete",
            { projectId: managedProjectId, force },
            "Bearer fixture-oauth-full",
          ).pipe(Effect.flatMap(decodeFailure));
          assert.equal(protectedFailure.code, "invalid_request");
          assert.equal(
            protectedFailure.message,
            "The managed AI Agents project cannot be deleted.",
          );
          assert.equal((yield* projects.getById(managedProjectId))._tag, "Some");
        }
        const deniedLaunch = yield* invoke(
          "t3_thread_launch",
          { title: "Denied", projectId, modelSelection: selection },
          "Bearer fixture-oauth-read",
        ).pipe(Effect.flatMap(decodeFailure));
        assert.equal(deniedLaunch.code, "capability_denied");
        const deniedDelegation = yield* invoke(
          "delegate_task",
          { task: "Denied child", mode: "async", clientRequestId: "denied" },
          "Bearer fixture-oauth-full",
        ).pipe(Effect.flatMap(decodeFailure));
        assert.equal(deniedDelegation.code, "thread_credential_required");
        const deniedCompletion = yield* invoke(
          "grok_bot_complete_turn",
          { finalText: "Denied final" },
          "Bearer fixture-oauth-full",
        ).pipe(Effect.flatMap(decodeFailure));
        assert.equal(deniedCompletion.code, "thread_credential_required");
        const launch = yield* invoke(
          "t3_thread_launch",
          {
            title: "Persistent native parent",
            projectId,
            modelSelection: selection,
            runtimeMode: "full-access",
            message: "Keep this fake native parent active.",
          },
          "Bearer fixture-oauth-full",
        ).pipe(Effect.flatMap(decodeLaunch));
        assert.isNotNull(launch.runId);
        yield* Deferred.await(prepared);
        yield* worker.drain();
        assert.lengthOf(state.sends, 1);
        const parent = yield* orchestrator.getThreadProjection(launch.threadId);
        const parentRun = parent.runs[0];
        if (parentRun?.activeAttemptId === null || parentRun === undefined)
          return yield* Effect.die("Missing committed native parent attempt");
        const identity = (yield* store.lookupTurn({
          runId: parentRun.id,
          attemptId: parentRun.activeAttemptId,
        }))?.identity;
        if (identity === undefined) return yield* Effect.die("Missing durable native identity");
        const authorization =
          state.sends[0]?.mcpConfig?.mcpServers["t3-code-managed"]?.headers?.Authorization;
        if (authorization === undefined)
          return yield* Effect.die("No trusted fixture grant was issued");
        assert.equal(identity.native.botId, selection.model);
        assert.equal(identity.native.binding, accountBinding);
        assert.equal(identity.native.threadId, launch.threadId);
        // Native acceptance, an idle snapshot and a visible reply are not terminal evidence.
        yield* PubSub.publish(nativeFrames, {
          _tag: "Live",
          state: { agentId: selection.model, isRunning: false, isComposingMessage: false },
          observedAtMs: 1,
          snapshot: true,
        });
        yield* PubSub.publish(nativeFrames, {
          _tag: "Rows",
          generation: 0,
          replay: false,
          deletes: [],
          entries: [
            {
              seq: "1",
              updatedSeq: "1",
              value: {
                id: "fixture-native-echo",
                kind: "message",
                role: "user",
                content: "fake parent",
                clientNonce: identity.messageId,
                requestId: "fixture-native-request",
              },
            },
            {
              seq: "2",
              updatedSeq: "2",
              value: {
                id: "fixture-native-answer",
                kind: "send-message",
                message: { type: "text", content: preliminaryAnswer },
                requestId: "fixture-native-request",
              },
            },
          ],
        });
        yield* Deferred.await(replyObserved);
        assert.equal(
          (yield* orchestrator.getThreadProjection(launch.threadId)).runs[0]?.status,
          "running",
        );

        // Reconstructing the credential registry loses its memory cache, while SQL retains exact authority.
        activeRegistry = yield* registryEffect.pipe(
          Effect.provide([remoteCredentials, authority, NodeServices.layer, NodeCrypto.layer]),
        );
        assert.isDefined(yield* activeRegistry.resolve(authorization.replace(/^Bearer\s+/, "")));
        state.binding = "b".repeat(64);
        assert.isUndefined(yield* activeRegistry.resolve(authorization.replace(/^Bearer\s+/, "")));
        state.binding = accountBinding;
        yield* invoke("t3_project_list", {}, authorization).pipe(Effect.flatMap(decodeProjects));
        const taskArgs = {
          task: "Complete the isolated child task",
          mode: "async",
          clientRequestId: "one-stable-shell-request",
          target: { providerInstanceId: childInstance, model: childSelection.model },
        };
        const task = yield* invoke("delegate_task", taskArgs, authorization).pipe(
          Effect.flatMap(decodeTask),
        );
        const duplicate = yield* invoke("delegate_task", taskArgs, authorization).pipe(
          Effect.flatMap(decodeTask),
        );
        assert.equal(duplicate.taskId, task.taskId);
        assert.equal(duplicate.childRunId, task.childRunId);
        if (task.childRunId === null) return yield* Effect.die("Missing admitted child run");
        const childWaiting = yield* Deferred.make<void>();
        const childCompleted = yield* Deferred.make<void>();
        waiting.set(task.childRunId, childWaiting);
        completed.set(task.childRunId, childCompleted);
        yield* worker.drain();
        yield* Deferred.await(childWaiting);
        yield* worker.drain();
        yield* Deferred.await(childCompleted);
        const result = yield* invoke("task_status", { taskId: task.taskId }, authorization).pipe(
          Effect.flatMap(decodeTask),
        );
        assert.equal(result.status, "completed");
        assert.equal(result.summary, finalAnswer);
        assert.equal(result.workState, "result_available");
        const queued = yield* invoke(
          "t3_thread_send",
          {
            threadId: launch.threadId,
            message: "Queued fake native follow-up",
            mode: "queue",
            clientRequestId: "queued-shell-follow-up",
          },
          authorization,
        ).pipe(Effect.flatMap(decodeQueued));
        yield* worker.drain();
        assert.lengthOf(state.sends, 1);
        const parentWaiting = yield* Deferred.make<void>();
        const parentCompleted = yield* Deferred.make<void>();
        waiting.set(parentRun.id, parentWaiting);
        completed.set(parentRun.id, parentCompleted);
        if (reconstruct) {
          const providerSessionId = parent.providerThreads[0]?.providerSessionId;
          if (providerSessionId === undefined || providerSessionId === null)
            return yield* Effect.die("Missing persisted fixture provider session");
          yield* sessions.close(providerSessionId);
          assert.equal(
            (yield* orchestrator.getThreadProjection(launch.threadId)).runs[0]?.status,
            "running",
          );
        }
        const settlement: Native.SettlementFrame = {
          _tag: "Settlement",
          clientNonce: identity.messageId,
          outcome: "success",
          settledAtMs: 2000,
        };
        if (lookupGap) {
          // Pause after the real SQL lookup returned none, before its native terminal batch is enqueued.
          yield* Deferred.succeed(nativeSettlement, settlement);
          yield* Deferred.await(nativeReadNone);
        }
        const declared = yield* invoke(
          "grok_bot_complete_turn",
          { finalText: finalAnswer },
          authorization,
        ).pipe(Effect.flatMap(decodeCompletion));
        assert.equal(declared.nativeWorkflowStatus, "unknown");
        if (settlementFirst) yield* Deferred.succeed(nativeSettlement, settlement);
        if (lookupGap) yield* Deferred.succeed(releaseNativeRead, undefined);
        if (reconstruct) {
          // Persisting a declaration with its observer absent cannot advance the queue.
          assert.equal(
            (yield* orchestrator.getThreadProjection(launch.threadId)).runs[0]?.status,
            "running",
          );
          assert.lengthOf(state.sends, 1);
          const duplicateDeclaration = yield* invoke(
            "grok_bot_complete_turn",
            { finalText: finalAnswer },
            authorization,
          ).pipe(Effect.flatMap(decodeCompletion));
          assert.deepStrictEqual(duplicateDeclaration, declared);
          const conflict = yield* invoke(
            "grok_bot_complete_turn",
            { finalText: "A different final answer" },
            authorization,
          ).pipe(Effect.flatMap(decodeFailure));
          assert.equal(conflict.reason, "conflicting_declaration");
          const [scheduledReconnect] = yield* sql<{ readonly effect_id: string }>`
            SELECT effect_id
            FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${launch.threadId}
              AND effect_type = 'provider-runtime.reconnect'
              AND json_extract(payload_json, '$.runId') = ${parentRun.id}
              AND status = 'pending'
            ORDER BY rowid
            LIMIT 1
          `;
          if (scheduledReconnect === undefined)
            return yield* Effect.die("Missing scheduled remote reconnect effect");
          const reconnectEffectId = scheduledReconnect.effect_id;
          yield* worker.drain();
          const nextClaimable = yield* worker.nextClaimableAt;
          if (Option.isNone(nextClaimable))
            return yield* Effect.die("Scheduled remote reconnect was not claimable");
          const now = yield* DateTime.now;
          yield* TestClock.adjust(
            Math.max(0, DateTime.toEpochMillis(nextClaimable.value) - DateTime.toEpochMillis(now)),
          );
          yield* worker.drain();
          const reconnectEffect = yield* outbox.get(reconnectEffectId);
          if (Option.isNone(reconnectEffect))
            return yield* Effect.die("Missing durable reconnect effect");
          assert.equal(
            reconnectEffect.value.status,
            "succeeded",
            JSON.stringify(reconnectEffect.value),
          );
          assert.lengthOf(state.sends, 1);
        }
        yield* Deferred.await(parentWaiting);
        yield* worker.drain();
        yield* Deferred.await(parentCompleted);
        const after = yield* orchestrator.getThreadProjection(launch.threadId);
        assert.equal(
          after.runs.find((candidate) => candidate.id === parentRun.id)?.status,
          "completed",
        );
        assert.equal(
          after.attempts.find((candidate) => candidate.id === identity.attemptId)?.status,
          "completed",
        );
        assert.equal((yield* store.lookupTurn(identity))?.state, "settled");
        assert.equal(
          after.runs.find((candidate) => candidate.id === queued.runId)?.status,
          "running",
        );
        assert.lengthOf(state.sends, 2);
        const finalIndex = events.findIndex(
          ({ event }) =>
            event.type === "message.updated" &&
            event.payload.runId === parentRun.id &&
            event.payload.text === finalAnswer,
        );
        const terminalIndex = events.findIndex(
          ({ event }) =>
            event.type === "run.updated" &&
            event.payload.id === parentRun.id &&
            event.payload.status === "completed",
        );
        assert.isAtLeast(finalIndex, 0);
        assert.isAbove(terminalIndex, finalIndex);
        const nativeTerminalIndex = events.findIndex(
          ({ event }) =>
            event.type === "provider-turn.updated" &&
            event.payload.id === identity.providerTurnId &&
            event.payload.status === "completed",
        );
        assert.isAbove(nativeTerminalIndex, finalIndex);
        assert.lengthOf(
          after.messages.filter(
            (message) => message.runId === parentRun.id && message.text === finalAnswer,
          ),
          1,
        );
        assert.isUndefined(yield* activeRegistry.resolve(authorization.replace(/^Bearer\s+/, "")));
        const stale = yield* callAcpMcpTool({
          endpoint,
          authorization,
          tool: "t3_project_list",
          arguments: {},
          fetchImplementation,
        }).pipe(
          Effect.match({
            onFailure: (error) => error.message,
            onSuccess: () => "Unexpected stale credential admission",
          }),
        );
        assert.include(stale, "HTTP 401");
        const calls = after.turnItems.filter(
          (item) => item.type === "dynamic_tool" && item.id.startsWith("mcp-call:"),
        );
        assert.includeMembers(
          calls.map((item) => item.title),
          ["t3_project_list", "delegate_task", "task_status"],
        );
        for (const call of calls) {
          assert.equal(call.runId, parentRun.id);
          assert.equal(call.nodeId, identity.rootNodeId);
          assert.equal(call.providerTurnId, identity.providerTurnId);
          assert.equal(call.status, "completed");
          if (call.type !== "dynamic_tool")
            return yield* Effect.die("Missing persisted MCP activity");
          assert.deepStrictEqual(call.input, {});
          assert.isUndefined(call.output);
          const history = events.filter(
            ({ event }) => event.type === "turn-item.updated" && event.payload.id === call.id,
          );
          assert.deepStrictEqual(
            history.map(({ event }) =>
              event.type === "turn-item.updated" ? event.payload.status : undefined,
            ),
            ["running", "completed"],
          );
        }
        const declarationRows =
          yield* sql`SELECT source, final_text FROM grok_bot_managed_completions`;
        assert.equal(declarationRows[0]?.source, "agent_declaration");
        const tokens = yield* sql`SELECT token_hash FROM mcp_remote_credentials`;
        assert.isTrue(
          tokens.every(
            (row) => typeof row.token_hash === "string" && /^[0-9a-f]{64}$/.test(row.token_hash),
          ),
        );
        assert.isAbove(requests, 0);
        // Release only fake provider observers owned by this test; native account state is never touched.
        for (const session of after.providerSessions) yield* sessions.close(session.id);
      }).pipe(Effect.provide(serverLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
