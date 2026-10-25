import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  EnvironmentId,
  MessageId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ServerConfig,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskInput,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Rpc from "effect/rpc/Rpc";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Peers from "../remoteOrchestration/PeerEnvironmentRegistry.ts";
import * as RemoteClient from "../remoteOrchestration/RemoteEnvironmentClient.ts";
import * as RemoteTasks from "../remoteOrchestration/RemoteTaskService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcp from "./OrchestratorMcpService.ts";

const shellRpcs = RpcGroup.make(
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
    payload: OrchestrationV2RpcSchemas.subscribeShell.input,
    success: OrchestrationV2RpcSchemas.subscribeShell.output,
    stream: true,
  }),
);

const decodeConfig = Schema.decodeEffect(ServerConfig);

const parentId = ThreadId.make("remote-test-parent");
const peerId = EnvironmentId.make("remote-test-destination");
const providerId = ProviderInstanceId.make("destination-provider");
const destinationProjectId = ProjectId.make("destination-only-project");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("remote-test-origin"),
  requestNamespace: "remote-test-session",
  issuedAt: 1,
  capabilities: new Set(["orchestration"]),
  thread: {
    threadId: parentId,
    providerSessionId: "remote-test-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const request = {
  environmentId: peerId,
  projectId: destinationProjectId,
  target: { providerInstanceId: providerId, model: "destination-model" },
  clientRequestId: "stable-request",
  task: "Check the destination workspace",
} satisfies OrchestratorMcpDelegateTaskInput;

const fixture = Effect.fn("RemoteMcpTest.fixture")(function* (
  options: {
    readonly parentMode?: RuntimeMode;
    readonly peerMode?: RuntimeMode;
    readonly supportedModes?: readonly RuntimeMode[];
    readonly existing?: boolean;
    readonly parentModeAfterConnect?: RuntimeMode;
    readonly remoteAncestor?: boolean;
  } = {},
) {
  const initialShell = liveThreadShell(parentId, {
    runtimeMode: options.parentMode ?? "full-access",
  });
  const shell = options.remoteAncestor
    ? {
        ...initialShell,
        lineage: { ...initialShell.lineage, parentThreadId: ThreadId.make("remote-task:ancestor") },
      }
    : initialShell;
  const projection: OrchestrationV2ThreadProjection = {
    ...idleThreadProjection(shell),
    runs: [
      {
        id: RunId.make("remote-test-parent-run"),
        threadId: parentId,
        ordinal: 1,
        providerInstanceId: shell.providerInstanceId,
        modelSelection: shell.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("remote-test-message"),
        rootNodeId: NodeId.make("remote-test-root"),
        activeAttemptId: null,
        status: "running",
        requestedAt: shell.createdAt,
        startedAt: shell.createdAt,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
  };
  const result: RemoteTasks.RemoteTaskResult = {
    environmentId: peerId,
    reachability: "offline",
    taskId: NodeId.make("remote-task:existing"),
    childThreadId: ThreadId.make("destination-child"),
    childRunId: null,
    childNodeId: NodeId.make("destination-root"),
    status: "running",
    workState: "working",
    hasPendingChildRuns: false,
    latestTerminalRunId: null,
    latestTerminalStatus: null,
    latestTerminalSummary: null,
    latestTerminalResultContextTransferId: null,
    providerInstanceId: providerId,
    model: "destination-model",
    summary: null,
    resultContextTransferId: null,
    hasPendingQuestion: false,
    pendingApproval: null,
    waitTimedOut: false,
  };
  const provider: ServerProvider = {
    instanceId: providerId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-25T00:00:00.000Z",
    models: [
      { slug: "destination-model", name: "Destination model", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    supportedRuntimeModes: options.supportedModes ?? ["approval-required", "full-access"],
  };
  const config = yield* decodeConfig({
    environment: {
      environmentId: peerId,
      label: "Destination",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "test",
      capabilities: { repositoryIdentity: false },
    },
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "test",
    },
    cwd: "/destination",
    keybindingsConfigPath: "/destination/keys.json",
    keybindings: [],
    issues: [],
    providers: [provider],
    availableEditors: [],
    settings: {},
    observability: {
      logsDirectoryPath: "/destination/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
  });
  const mutations: Parameters<RemoteTasks.RemoteTaskService["Service"]["delegate"]>[0][] = [];
  const observations: { operation: string; parentId: ThreadId; taskId: NodeId }[] = [];
  const requestKeys: string[] = [];
  const lookups: EnvironmentId[] = [];
  let connections = 0;
  let catalogReads = 0;
  let rpc!: Effect.Success<
    ReturnType<typeof RpcClient.makeNoSerialization<RpcGroup.Rpcs<typeof shellRpcs>, never>>
  >;
  const unused = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
    onFromClient: () => Effect.die("Unexpected remote RPC mutation"),
  });
  rpc = yield* RpcClient.makeNoSerialization(shellRpcs, {
    onFromClient: ({ message }) => {
      if (message._tag !== "Request") return Effect.void;
      if (message.tag !== ORCHESTRATION_V2_WS_METHODS.subscribeShell)
        return Effect.die("Unexpected remote RPC mutation");
      catalogReads += 1;
      return rpc.write({
        _tag: "Chunk",
        clientId: 0,
        requestId: message.id,
        values: [
          { kind: "synchronized" },
          {
            kind: "snapshot",
            snapshot: {
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
              projects: [
                {
                  id: destinationProjectId,
                  title: "Destination only",
                  workspaceRoot: "/destination/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-10-25T00:00:00.000Z",
                  updatedAt: "2026-10-25T00:00:00.000Z",
                },
              ],
            },
          },
        ],
      });
    },
  });
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(),
    Layer.mock(ServerEnvironment)({
      getDescriptor: Effect.succeed({
        ...config.environment,
        environmentId: scope.environmentId,
        label: "private-account-label",
      }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.sync((): OrchestrationV2ThreadProjection => ({
          ...projection,
          thread:
            connections > 0 && options.parentModeAfterConnect
              ? { ...projection.thread, runtimeMode: options.parentModeAfterConnect }
              : projection.thread,
        })),
      getThreadShell: () =>
        Effect.sync(() =>
          connections > 0 && options.parentModeAfterConnect
            ? { ...shell, runtimeMode: options.parentModeAfterConnect }
            : shell,
        ),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(Git.GitVcsDriver)({}),
    Layer.mock(Secrets.SecretRequests)({}),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
    Layer.mock(Peers.PeerEnvironmentRegistry)({
      get: (id) =>
        Effect.sync(() => {
          lookups.push(id);
          return {
            environmentId: id,
            label: "Destination",
            httpBaseUrl: "https://destination.example",
            bearerToken: "fixture",
            maxRuntimeMode: options.peerMode ?? "full-access",
          };
        }),
      list: () => Effect.succeed([]),
    }),
    Layer.mock(RemoteClient.RemoteEnvironmentClient)({
      connect: () =>
        Effect.sync(() => {
          connections += 1;
          return {
            config,
            client: { ...unused.client, ...rpc.client },
          };
        }),
    }),
    Layer.mock(RemoteTasks.RemoteTaskService)({
      existing: (_parentId, requestId) =>
        Effect.sync(() => {
          requestKeys.push(requestId);
          return options.existing ? result : null;
        }),
      delegate: (input) =>
        Effect.sync(() => {
          mutations.push(input);
          return result;
        }),
      status: (parentId, taskId) =>
        Effect.sync(() => {
          observations.push({ operation: "status", parentId, taskId });
          return result;
        }),
      cancel: (parentId, taskId) =>
        Effect.sync(() => {
          observations.push({ operation: "cancel", parentId, taskId });
          return result;
        }),
    }),
  );
  const service = yield* OrchestratorMcp.OrchestratorMcpService.pipe(
    Effect.provide(OrchestratorMcp.layer.pipe(Layer.provide(dependencies))),
  );
  return {
    service,
    result,
    mutations,
    observations,
    requestKeys,
    lookups,
    connections: () => connections,
    catalogReads: () => catalogReads,
  };
});

describe("OrchestratorMcpService cross-environment routing", () => {
  it.effect(
    "identifies the current connection without exposing private labels or claiming devices",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const catalog = yield* f.service.capabilities({
          ...scope,
          capabilities: new Set(["orchestration", "preview"]),
        });
        assert.deepEqual(catalog.connection, {
          environmentId: scope.environmentId,
          toolFamilies: ["orchestration", "preview"],
        });
        assert.equal(catalog.executionEnvironment?.environmentId, scope.environmentId);
        assert.deepEqual(catalog.executionEnvironment?.platform, { os: "linux", arch: "x64" });
        assert.notInclude(JSON.stringify(catalog), "private-account-label");
        assert.equal(f.connections(), 0);
      }).pipe(Effect.scoped),
  );
  it.effect("retains the request identity when the provider reconnects", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ existing: true });
      yield* f.service.delegateTask(scope, request);
      yield* f.service.delegateTask(
        { ...scope, requestNamespace: "new-provider-connection" },
        request,
      );
      assert.equal(f.requestKeys.length, 2);
      assert.equal(f.requestKeys[0], f.requestKeys[1]);
      assert.equal(f.connections(), 0);
    }).pipe(Effect.scoped),
  );
  it.effect("refuses a third-box launch from a remote task's local descendants", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ remoteAncestor: true });
      const error = yield* f.service.delegateTask(scope, request).pipe(Effect.flip);
      assert.include(error.message, "Nested cross-environment delegation is not supported");
      assert.equal(f.connections(), 0);
      assert.deepEqual(f.mutations, []);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "refuses a remote launch when parent authority drops during destination discovery",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ parentModeAfterConnect: "approval-required" });
        const error = yield* f.service
          .delegateTask(scope, { ...request, runtimeMode: "full-access" })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.deepEqual(f.mutations, []);
      }).pipe(Effect.scoped),
  );
  it.effect("returns an existing offline handle without looking up or connecting to the peer", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ existing: true });
      assert.deepEqual(yield* f.service.delegateTask(scope, request), f.result);
      assert.deepEqual(f.lookups, []);
      assert.equal(f.connections(), 0);
      assert.deepEqual(f.mutations, []);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses reuse of a stable request for another destination", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ existing: true });
      const error = yield* f.service
        .delegateTask(scope, {
          ...request,
          environmentId: EnvironmentId.make("spoofed-destination"),
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "another destination");
      assert.equal(f.connections(), 0);
      assert.deepEqual(f.mutations, []);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["clientRequestId", "projectId", "providerInstanceId", "model"])(
    "requires explicit %s before any remote activity",
    (missing) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const { clientRequestId, projectId, target, ...base } = request;
        const input = {
          ...base,
          ...(missing === "clientRequestId" ? {} : { clientRequestId }),
          ...(missing === "projectId" ? {} : { projectId }),
          target: {
            ...(missing === "providerInstanceId"
              ? {}
              : { providerInstanceId: target.providerInstanceId }),
            ...(missing === "model" ? {} : { model: target.model }),
          },
        };
        assert.equal(
          (yield* f.service.delegateTask(scope, input).pipe(Effect.flip)).code,
          "invalid_request",
        );
        assert.equal(f.connections(), 0);
        assert.deepEqual(f.lookups, []);
        assert.deepEqual(f.mutations, []);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects attachments and voice authority before network mutations", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const attachmentError = yield* f.service
        .delegateTask(scope, { ...request, attachmentIds: [ChatAttachmentId.make("attachment")] })
        .pipe(Effect.flip);
      assert.include(attachmentError.message, "attachments are not supported");
      const voiceScope: McpInvocationScope = {
        ...scope,
        call: {
          threadId: parentId,
          parentNodeId: NodeId.make("voice-parent"),
          environmentId: scope.environmentId,
          accountId: "account",
          botId: "bot",
          callId: "call",
          authorityId: "voice-authority",
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      };
      const voiceError = yield* f.service.delegateTask(voiceScope, request).pipe(Effect.flip);
      assert.include(voiceError.message, "voice call authority");
      assert.equal(f.connections(), 0);
      assert.deepEqual(f.mutations, []);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { parentMode: "full-access", peerMode: "approval-required" },
    { parentMode: "approval-required", peerMode: "full-access" },
  ] satisfies { parentMode: RuntimeMode; peerMode: RuntimeMode }[])(
    "uses the narrower runtime ceiling: %j",
    (modes) =>
      Effect.gen(function* () {
        const f = yield* fixture(modes);
        yield* f.service.delegateTask(scope, request);
        assert.equal(f.mutations.length, 1);
        assert.equal(f.mutations[0]?.launch.runtimeMode, "approval-required");
        assert.equal(f.mutations[0]?.launch.projectId, destinationProjectId);
        assert.equal(f.mutations[0]?.environmentId, peerId);
        assert.equal(f.mutations[0]?.parentThreadId, parentId);
        const error = yield* f.service
          .delegateTask(scope, { ...request, runtimeMode: "full-access" })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(f.mutations.length, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects an explicitly unsupported destination runtime mode", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ supportedModes: ["approval-required"] });
      const error = yield* f.service
        .delegateTask(scope, { ...request, runtimeMode: "full-access" })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "does not offer runtime mode");
      assert.deepEqual(f.mutations, []);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "routes remote status and cancellation by the calling parent and exact task handle",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const taskId = NodeId.make("remote-task:other-handle");
        assert.deepEqual(yield* f.service.taskStatus(scope, taskId), f.result);
        assert.deepEqual(yield* f.service.cancelTask(scope, { taskId }), {
          taskId: f.result.taskId,
          status: "cancel_requested",
        });
        assert.deepEqual(f.observations, [
          { operation: "status", parentId, taskId },
          { operation: "cancel", parentId, taskId },
        ]);
        assert.equal(f.connections(), 0);
        assert.deepEqual(f.mutations, []);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "discovers destination projects from its shell snapshot and models from its live config",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const catalog = yield* f.service.capabilities(scope, peerId);
        assert.deepEqual(catalog.projects, [
          {
            projectId: destinationProjectId,
            title: "Destination only",
            workspaceRoot: "/destination/project",
          },
        ]);
        assert.equal(catalog.providers[0]?.providerInstanceId, providerId);
        assert.equal(catalog.providers[0]?.models[0]?.id, "destination-model");
        assert.equal(catalog.inheritedProviderInstanceId, null);
        assert.deepEqual(catalog.connection, {
          environmentId: scope.environmentId,
          toolFamilies: ["orchestration"],
        });
        assert.deepEqual(catalog.executionEnvironment, {
          environmentId: peerId,
          platform: { os: "linux", arch: "x64" },
          capabilities: { repositoryIdentity: false },
        });
        assert.equal(f.catalogReads(), 1);
        assert.equal(f.connections(), 1);
        assert.deepEqual(f.mutations, []);
      }).pipe(Effect.scoped),
  );
});
