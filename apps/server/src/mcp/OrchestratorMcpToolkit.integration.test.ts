import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { type JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import {
  EventId,
  IsoDateTime,
  type OrchestrationV2DelegatedCompletionDelivery,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitResult,
  ProviderThreadId,
  ProviderTurnId,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  ThreadMetadataMcpUpdateResult,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { delegatedTaskRun } from "./OrchestratorMcpService.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const claudeModel = "claude-sonnet-4-6";
const createdThreadPrompt = "Complete the newly created ordinary thread.";
const decodeCreateThreadsResult = Schema.decodeUnknownEffect(OrchestratorMcpCreateThreadsResult);
const decodeTaskCancelResult = Schema.decodeUnknownEffect(OrchestratorMcpTaskCancelResult);
const decodeThreadListResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeThreadWaitResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);
const decodeThreadUpdateResult = Schema.decodeUnknownEffect(ThreadMetadataMcpUpdateResult);
const claudeSelection = {
  instanceId: claudeInstanceId,
  model: claudeModel,
} satisfies ModelSelection;
interface CapturedTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly text: string;
}
function unsupported(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}
function makeDeterministicAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly shouldComplete: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => boolean;
  readonly terminalGate?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Deferred.Deferred<void> | undefined;
  readonly response: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => string;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const publish = (providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();
        const turnInputs = new Map<ProviderTurnId, ProviderAdapter.ProviderAdapterV2TurnInput>();

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  instanceId: input.instanceId,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              turnInputs.set(providerTurnId, turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt: eventTime,
                    completedAt: null,
                  },
                },
              ]);
              const terminalGate = input.terminalGate?.(turnInput);
              if (terminalGate !== undefined) {
                yield* Deferred.await(terminalGate);
              } else if (!input.shouldComplete(turnInput)) {
                return;
              }
              const response = input.response(turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              const turnInput = turnInputs.get(providerTurnId);
              const completedAt = yield* DateTime.now;
              if (turnInput !== undefined) {
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver: input.driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        driver: input.driver,
                        nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                        strength: "strong",
                      },
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "interrupted",
                      startedAt: completedAt,
                      completedAt,
                    },
                  },
                ]);
              }
              yield* publish([
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unsupported(input.driver, "readThreadSnapshot is unused in this test"),
          rollbackThread: () => unsupported(input.driver, "rollbackThread is unused in this test"),
          forkThread: () => unsupported(input.driver, "forkThread is unused in this test"),
        };
      }),
  };
}

function scheduledTaskFromUpsert(input: ScheduledTaskUpsertInput): ScheduledTask {
  const timestamp = IsoDateTime.make("2026-07-01T09:00:00.000Z");
  return {
    id: input.id ?? ScheduledTaskId.make(`scheduled-task:${input.commandId ?? "stub"}`),
    title: input.title,
    prompt: input.prompt,
    enabled: input.enabled,
    schedule:
      input.schedule.type === "webhook"
        ? {
            type: "webhook",
            signature:
              input.schedule.signature == null
                ? null
                : {
                    header: input.schedule.signature.header,
                    encoding: input.schedule.signature.encoding,
                    prefix: input.schedule.signature.prefix,
                  },
          }
        : input.schedule,
    projectId: input.projectId,
    threadId: input.threadId ?? null,
    workspaceStrategy: input.workspaceStrategy,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdBy: input.createdBy ?? "user",
    creationSource: input.creationSource ?? "web",
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
}
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  isProviderNativeSubagentThread,
  MessageId,
  type ModelSelection,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(function* (
  followupResult: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(
    decodeURIComponent(delegatedTaskStatusTranscriptFile.pathname),
  );
  return yield* decodeProviderReplayNdjson(text.replaceAll(queuedFollowupResult, followupResult));
}, Effect.provide(NodeServices.layer));

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("ScheduledTaskService.upsert is unused in this test"),
    setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
    delete: () => Effect.die("ScheduledTaskService.delete is unused in this test"),
    deleteForThread: () => Effect.die("unused in this test"),
    runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
    rotateWebhookToken: () => Effect.die("unused in this test"),
    listWebhookDeliveries: () => Effect.die("unused in this test"),
    getWebhookDelivery: () => Effect.die("unused in this test"),
    triggerWebhook: () => Effect.die("unused in this test"),
  }),
);

describe("orchestrator MCP toolkit", () => {
  it.live("delegates into a destination project while retaining task ownership", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const destinationProjectId = ProjectId.make("project:mcp-destination");
        const cwd = yield* checkpointWorkspace("mcp-destination-project");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          makeDeterministicAdapter({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            capabilities: CodexProviderCapabilitiesV2,
            capturedTurns,
            shouldComplete: (turn) => turn.threadId !== parentThreadId,
            response: () => delegatedResult,
          }),
        ]);
        const database = SqlitePersistence.layerMemory;
        const runtime = ProviderReplayHarness.layerWithRegistry(
          { name: "mcp-destination-project", runtimePolicyOverride: { cwd } },
          registry,
          { databaseLayer: database, runEffectWorker: false },
        );
        const orchestration = Layer.merge(
          runtime,
          ThreadManagementService.layer.pipe(
            Layer.provide(runtime),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
            Layer.provide(ServerSettings.layerTest()),
          ),
        );
        const layerTest = McpHttpServer.layerOrchestratorToolkit.pipe(
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
          Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(orchestration),
          Layer.provide(registry),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            ProviderRegistryMock.layer([
              makeProviderSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: codexModel,
                optionDescriptors: [
                  {
                    id: "reasoning",
                    label: "Reasoning effort",
                    type: "select",
                    options: [
                      { id: "high", label: "High" },
                      { id: "low", label: "Low" },
                    ],
                  },
                ],
              }),
            ]),
          ),
          Layer.provide(layerUnusedScheduledTaskStub),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              getById: (id) =>
                Effect.succeed(
                  id === projectId || id === destinationProjectId
                    ? Option.some({
                        id,
                        title: id,
                        workspaceRoot: `${cwd}/${id}`,
                        defaultModelSelection: codexSelection,
                        scripts: [],
                        createdAt: IsoDateTime.make("2026-10-11T00:00:00Z"),
                        updatedAt: IsoDateTime.make("2026-10-11T00:00:00Z"),
                        deletedAt: null,
                      })
                    : Option.none(),
                ),
            }),
          ),
          Layer.provideMerge(
            SecretRequests.layer.pipe(
              Layer.provide(layerMemorySecretStore),
              Layer.provide(orchestration),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const server = yield* McpServer.McpServer;
          const now = yield* DateTime.now;
          const timestamp = IsoDateTime.make(DateTime.formatIso(now));
          for (const id of [projectId, destinationProjectId]) {
            const commandId = CommandId.make(`command:destination-project:create:${id}`);
            yield* sink.commitProjectCommand({
              commandId,
              projectId: id,
              commandType: "project.create",
              acceptedAt: now,
              event: {
                eventId: EventId.make(`event:destination-project:create:${id}`),
                aggregateKind: "project",
                aggregateId: id,
                occurredAt: timestamp,
                commandId,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "project.created",
                payload: {
                  projectId: id,
                  title: id,
                  workspaceRoot: `${cwd}/${id}`,
                  defaultModelSelection: codexSelection,
                  scripts: [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              },
            });
          }
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:destination-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "Destination parent",
            modelSelection: codexSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: "parent-branch",
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:destination-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:destination-parent"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          const parent = yield* orchestrator.getThreadProjection(parentThreadId);
          const parentRun = parent.runs[0]!;
          const parentWithPullRequest = {
            ...parent.thread,
            branchPullRequest: {
              projectId,
              repository: "test/repo",
              number: 1,
              url: "https://example.com/test/repo/pull/1",
            },
          };
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:destination-parent:branch-pr"),
                type: "thread.metadata-updated",
                threadId: parentThreadId,
                providerInstanceId: codexInstanceId,
                occurredAt: now,
                payload: parentWithPullRequest,
              },
            ],
          });
          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-destination"),
            requestNamespace: "mcp-destination-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-destination-parent",
              providerInstanceId: codexInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const invoke = (name: string, args: Record<string, unknown>) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
          const args = {
            task: delegatedPrompt,
            projectId: destinationProjectId,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
              options: { reasoning: "high" },
            },
            clientRequestId: "destination-child",
            mode: "async",
          };
          const denied = yield* invoke("delegate_task", { ...args, runtimeMode: "full-access" });
          expect(declaredFailure(denied)?.code).toBe("runtime_mode_escalation_denied");
          const invalidOptions = yield* invoke("delegate_task", {
            ...args,
            target: { ...args.target, options: { reasoning: "unsupported" } },
          });
          expect(declaredFailure(invalidOptions)?.code).toBe("invalid_request");

          const first = yield* invoke("delegate_task", args);
          const task = yield* decodeDelegateTaskResult(first.structuredContent).pipe(Effect.orDie);
          const retry = yield* invoke("delegate_task", args);
          const retried = yield* decodeDelegateTaskResult(retry.structuredContent).pipe(
            Effect.orDie,
          );
          expect(retried.taskId).toBe(task.taskId);
          expect(retried.childThreadId).toBe(task.childThreadId);
          const changedDestination = yield* invoke("delegate_task", { ...args, projectId });
          const originalTask = yield* decodeDelegateTaskResult(
            changedDestination.structuredContent,
          ).pipe(Effect.orDie);
          expect(originalTask.taskId).toBe(task.taskId);
          expect(originalTask.childThreadId).toBe(task.childThreadId);
          const child = yield* orchestrator.getThreadProjection(task.childThreadId);
          expect(child.thread).toMatchObject({
            projectId: destinationProjectId,
            branch: null,
            worktreePath: null,
            branchPullRequest: null,
            runtimeMode: "approval-required",
            interactionMode: "default",
            modelSelection: { ...codexSelection, options: [{ id: "reasoning", value: "high" }] },
            lineage: {
              parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: parent.thread.lineage.rootThreadId,
            },
          });
          expect(
            child.contextTransfers.some(
              (transfer) =>
                transfer.type === "subagent_spawn" &&
                transfer.sourceThreadId === parentThreadId &&
                transfer.targetRunId === task.childRunId,
            ),
          ).toBe(true);
          expect((yield* orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(
            1,
          );

          for (const explicit of [false, true]) {
            const call = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              clientRequestId: `inherited-child:${explicit}`,
              ...(explicit ? { projectId } : {}),
            });
            const inherited = yield* decodeDelegateTaskResult(call.structuredContent).pipe(
              Effect.orDie,
            );
            expect(
              (yield* orchestrator.getThreadProjection(inherited.childThreadId)).thread,
            ).toMatchObject({
              projectId,
              branch: "parent-branch",
              worktreePath: cwd,
              branchPullRequest: parentWithPullRequest.branchPullRequest,
            });
          }
          for (const id of [ProjectId.make("project:missing"), destinationProjectId]) {
            if (id === destinationProjectId) {
              const commandId = CommandId.make("command:destination-project:delete");
              yield* sink.commitProjectCommand({
                commandId,
                projectId: id,
                commandType: "project.delete",
                acceptedAt: now,
                event: {
                  eventId: EventId.make("event:destination-project:delete"),
                  aggregateKind: "project",
                  aggregateId: id,
                  occurredAt: timestamp,
                  commandId,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  type: "project.deleted",
                  payload: { projectId: id, deletedAt: timestamp },
                },
              });
            }
            const failed = yield* orchestrator
              .dispatch({
                type: "delegated_task.request",
                createdBy: "agent",
                creationSource: "mcp",
                commandId: CommandId.make(`command:destination-rejected:${id}`),
                parentThreadId,
                parentRunId: parentRun.id,
                parentNodeId: parentRun.rootNodeId!,
                projectId: id,
                task: delegatedPrompt,
                modelSelection: codexSelection,
                runtimeMode: "approval-required",
                interactionMode: "default",
              })
              .pipe(Effect.flip);
            expect(failed._tag).toBe("OrchestratorDispatchError");
          }
          yield* worker.drain();
          yield* orchestrator
            .streamStoredEventsFrom({ threadId: parentThreadId, afterSequence: 0 })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.type === "subagent_result" &&
                  stored.event.payload.sourceThreadId === task.childThreadId,
              ),
              Stream.runHead,
            );
          const statusCall = yield* invoke("task_status", { taskId: task.taskId });
          const status = yield* decodeDelegateTaskResult(statusCall.structuredContent).pipe(
            Effect.orDie,
          );
          expect(status).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            childRunId: task.childRunId,
          });
          const cancelCall = yield* invoke("task_cancel", {
            taskId: task.taskId,
            clientRequestId: "cancel-destination-child",
          });
          const cancelled = yield* decodeTaskCancelResult(cancelCall.structuredContent).pipe(
            Effect.orDie,
          );
          expect(cancelled.status).toBe("completed");
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
              (candidate) => candidate.id === task.taskId,
            )?.completionDelivery?.state,
          ).toBe("disposed");
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );

  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
  ])("reports $label child results", ({ result, latestSummary }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("delegated-task-status");
        const rawTranscript = yield* readDelegatedTaskStatusTranscript(result);
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(rawTranscript, cwd),
        );
        const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
          {
            name: "delegated-task-status/codex",
            transcript,
            commands: [],
            runtimePolicyOverride: { cwd },
          },
          CodexOrchestratorReplayHarness,
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerProviderRegistry = ProviderRegistryMock.layer([
          makeProviderSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: codexModel,
          }),
        ]);
        const layerTest = layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(
            CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
              Layer.provide(McpProviderSessions.layer),
            ),
          ),
          Layer.provide(layerProviderRegistry),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(layerUnusedScheduledTaskStub),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provideMerge(
            SecretRequests.layer.pipe(
              Layer.provide(layerMemorySecretStore),
              Layer.provide(layerOrchestration),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const parentCreate = yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP replay parent",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-replay-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: parentCreate.sequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Parent provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-replay"),
            requestNamespace: "mcp-provider-session-replay-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-replay-parent",
              providerInstanceId: codexInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const invoke = (name: string, args: Record<string, unknown>) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                Effect.provideService(McpSchema.McpServerClient, client),
              );

          const delegationStartSequence =
            yield* orchestrator.getThreadEventSequence(parentThreadId);
          const delegatedCall = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
            },
            mode: "async",
            clientRequestId: "delegate-codex-replay-1",
          });
          const delegatedStart = yield* decodeDelegateTaskResult(
            delegatedCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegatedStart.childRunId).not.toBeNull();
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: delegationStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.type === "subagent_result" &&
                  stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                  stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Delegated result transfer was not created."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const delegatedStatusCall = yield* invoke("task_status", {
            taskId: delegatedStart.taskId,
          });
          const delegated = yield* decodeDelegateTaskResult(
            delegatedStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegated).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            providerInstanceId: codexInstanceId,
            hasPendingChildRuns: false,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });
          expect(delegated.resultContextTransferId).not.toBeNull();

          const delegatedChild = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
          expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
          const followupStartSequence = yield* orchestrator.getThreadEventSequence(
            delegated.childThreadId,
          );
          const runningFollowupCall = yield* invoke("t3_thread_send", {
            threadId: delegated.childThreadId,
            message: cancellationPrompt,
            clientRequestId: "delegated-child-replay-running-1",
          });
          const runningFollowup = yield* decodeThreadSendResult(
            runningFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: followupStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const queuedFollowupCall = yield* invoke("t3_thread_send", {
            threadId: delegated.childThreadId,
            message: queuedFollowupPrompt,
            mode: "queue",
            clientRequestId: "delegated-child-replay-queued-1",
          });
          const queuedFollowup = yield* decodeThreadSendResult(
            queuedFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(queuedFollowup).toMatchObject({
            status: "queued",
            delivery: "queued",
          });

          const pendingProjection = yield* orchestrator.getThreadProjection(
            delegated.childThreadId,
          );
          const followupTasks = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.filter(
            (task) =>
              task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
          );
          expect(followupTasks).toHaveLength(2);
          expect(followupTasks.every((task) => task.result === null)).toBe(true);
          expect(followupTasks.map((task) => task.id)).toEqual([
            runningFollowup.taskId,
            queuedFollowup.taskId,
          ]);
          expect(
            pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status,
          ).toBe("completed");
          expect(
            pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status,
          ).toBe("running");
          expect(
            pendingProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status,
          ).toBe("queued");
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
              (run) => run.status === "running",
            ),
          ).toBe(true);

          const pendingStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const pendingStatus = yield* decodeDelegateTaskResult(
            pendingStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(pendingStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: true,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });

          const finalSequence = yield* orchestrator.getThreadEventSequence(delegated.childThreadId);
          const interruptCall = yield* invoke("t3_thread_interrupt", {
            threadId: delegated.childThreadId,
            runId: runningFollowup.runId,
            reason: "Allow the queued replay follow-up to run.",
            clientRequestId: "interrupt-delegated-child-replay-1",
          });
          const interrupt = yield* decodeThreadInterruptResult(
            interruptCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(interrupt).toMatchObject({
            runId: runningFollowup.runId,
            status: "interrupt_requested",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === queuedFollowup.runId &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Queued follow-up did not complete."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const finalProjection = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
            "interrupted",
          );
          expect(finalProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
            "completed",
          );
          expect(
            finalProjection.turnItems.find(
              (item) =>
                item.runId === runningFollowup.runId && item.type === "run_interrupt_result",
            ),
          ).toMatchObject({
            message: "Stopped by an agent: Allow the queued replay follow-up to run.",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === followupTasks[1]!.id &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up task did not settle."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)?.status,
          ).toBe("interrupted");
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id),
          ).toMatchObject({
            status: "completed",
            result,
          });
          expect(
            finishedParent.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === delegated.childThreadId,
            ),
          ).toHaveLength(3);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const finalStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const finalStatus = yield* decodeDelegateTaskResult(
            finalStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(finalStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: false,
            latestTerminalRunId: queuedFollowup.runId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: latestSummary,
          });
          const followupTransfer = finishedParent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourcePoint.runId === queuedFollowup.runId,
          );
          expect(followupTransfer).toBeDefined();
          expect(finalStatus.latestTerminalResultContextTransferId).toBe(followupTransfer?.id);
          expect(finalStatus.latestTerminalResultContextTransferId).not.toBe(
            delegated.resultContextTransferId,
          );
          const read = yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            limit: 100,
          });
          expect(read.isError).not.toBe(true);
          const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            afterRead.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("acknowledged");
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );
});
