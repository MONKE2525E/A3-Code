import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskResult,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Config from "../../config.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Access from "../../mcp/McpToolAccess.ts";
import * as Orchestrator from "../../mcp/OrchestratorMcpService.ts";
import * as OrchestratorHandlers from "../../mcp/toolkits/orchestrator/handlers.ts";
import * as ProjectHandlers from "../../mcp/toolkits/project/handlers.ts";
import * as ThreadHandlers from "../../mcp/toolkits/thread/handlers.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SourceControl from "../../sourceControl/SourceControlRepositoryService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as Metadata from "../../mcp/ThreadMetadataMcpService.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Launches from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Folders from "../../project/ManagedProjectFolders.ts";
import * as Settings from "../../serverSettings.ts";
import * as Git from "../../vcs/GitVcsDriver.ts";
import * as Voice from "./GrokBotVoiceOrchestration.ts";

// Real checked MCP handlers; external services would fail if either refusal reached execution.
let acquisitionFailure: OrchestratorMcpFailure | undefined;
let taskWaitFailure: OrchestratorMcpFailure | undefined;
let threadWaitTimedOut = true;
let pendingQuestions: OrchestratorMcpDelegateTaskResult["pendingQuestions"] = [];
let pendingApprovals: OrchestratorMcpDelegateTaskResult["pendingApprovals"] = [];
const harness = Voice.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Access.HandlersLayer.layer(OrchestratorHandlers.layer),
      Access.HandlersLayer.layer(ProjectHandlers.layer),
      Access.HandlersLayer.layer(ThreadHandlers.layer),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(Environment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("voice-env")),
      } as never),
      Layer.succeed(Crypto.Crypto, {} as never),
      Layer.succeed(FileSystem.FileSystem, {} as never),
      Layer.succeed(Config.ServerConfig, {} as never),
      Layer.succeed(Orchestrator.OrchestratorMcpService, {
        acquireCallInvocation: () =>
          acquisitionFailure !== undefined
            ? Effect.fail(acquisitionFailure)
            : Effect.succeed({
                environmentId: EnvironmentId.make("voice-env"),
                issuedAt: 0,
                capabilities: new Set(["orchestration"]),
                requestNamespace: "voice-call",
                thread: undefined,
                client: { sessionId: "call", label: "Voice call", access: "approval-required" },
              }),
        validateCallInvocation: () => Effect.void,
        restrictCallInvocation: (
          scope: import("../../mcp/McpInvocationContext.ts").McpInvocationScope,
        ) => Effect.succeed({ ...scope, client: { ...scope.client!, access: "read-only" } }),
        releaseCallInvocation: () => Effect.void,
        waitForTask: () =>
          taskWaitFailure !== undefined
            ? Effect.fail(taskWaitFailure)
            : Effect.succeed({
                waitTimedOut: true,
                title: "Watched task",
                childThreadId: "watched-child",
                summary: null,
                status: "running",
                pendingQuestions,
                pendingApprovals,
              }),
        waitForThread: () =>
          Effect.succeed({
            threadId: "observed-thread",
            runId: "observed-run",
            status: threadWaitTimedOut ? "running" : "completed",
            timedOut: threadWaitTimedOut,
          }),
        capabilities: () =>
          Effect.succeed({
            parentThreadId: null,
            inheritedProviderInstanceId: null,
            inheritedModel: null,
            runtimeMode: "approval-required",
            interactionMode: "default",
            providers: [],
            features: {
              appOwnedSubagents: true,
              asyncPolling: true,
              cancellation: true,
              batchThreadCreation: true,
              threadManagement: true,
              incrementalThreadRead: true,
              scheduledTasks: true,
              maxBatchThreads: 20,
            },
          }),
      } as never),
      Layer.succeed(Metadata.ThreadMetadataMcpService, {} as never),
      Layer.succeed(Threads.ThreadManagementService, {} as never),
      Layer.succeed(ThreadSearch.ThreadSearch, {} as never),
      Layer.succeed(ScheduledTasks.ScheduledTaskService, {} as never),
      Layer.succeed(SourceControl.SourceControlRepositoryService, {} as never),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.succeed(Launches.ThreadLaunchService, {} as never),
      Layer.succeed(Projects.ProjectService, {} as never),
      Layer.succeed(Folders.ManagedProjectFolders, {} as never),
      Layer.succeed(Settings.ServerSettingsService, {} as never),
      Layer.succeed(Git.GitVcsDriver, {} as never),
    ),
  ),
);

const caller = {
  binding: "account",
  botId: "bot",
  callId: "call",
  toolCallId: "tool",
  canonicalThreadId: "canonical-bot-thread",
};

it.effect.each(["question", "approval"] as const)(
  "routes each nested %s notice with its own origin thread",
  (kind) =>
    Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceOrchestration;
      yield* voice.activate(caller);
      const origins = ["watched-child", "nested-grandchild"].map((origin) => ThreadId.make(origin));
      if (kind === "question")
        pendingQuestions = origins.map((origin) => ({
          threadId: ThreadId.make(origin),
          requestId: RuntimeRequestId.make(`request:${origin}`),
          questions: [{ id: "branch", header: "Branch", question: "Which branch?", options: [] }],
        }));
      else
        pendingApprovals = origins.map((origin) => ({
          threadId: ThreadId.make(origin),
          requestId: RuntimeRequestId.make(`request:${origin}`),
          title: "Publish?",
        }));
      const result = yield* voice.wait({
        ...caller,
        access: "operate",
        taskId: "watched-task",
        seenApprovalIds: [],
      });
      const output = result.result.output as {
        threadId?: string;
        questions?: typeof pendingQuestions;
        approvals?: typeof pendingApprovals;
      };
      assert.isTrue(result.pending);
      assert.deepEqual(
        (kind === "question" ? output.questions : output.approvals)?.map(
          (notice) => notice.threadId,
        ),
        origins,
      );
      assert.isUndefined(output.threadId);
      yield* voice.forget(caller.callId);
    }).pipe(
      Effect.provide(harness),
      Effect.ensuring(
        Effect.sync(() => {
          pendingQuestions = [];
          pendingApprovals = [];
        }),
      ),
    ),
);

it.effect("retains pending work after a retryable task read failure", () =>
  Effect.gen(function* () {
    const voice = yield* Voice.GrokBotVoiceOrchestration;
    yield* voice.activate(caller);
    taskWaitFailure = new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "Task status is temporarily unavailable.",
    });
    const failed = yield* voice.wait({
      ...caller,
      access: "read",
      taskId: "watched-task",
      seenApprovalIds: [],
    });
    assert.isTrue(failed.pending);
    assert.isTrue((failed.result.output as { retryable: boolean }).retryable);
    taskWaitFailure = undefined;
    const recovered = yield* voice.wait({
      ...caller,
      access: "read",
      taskId: "watched-task",
      seenApprovalIds: [],
    });
    assert.isTrue(recovered.pending);
    assert.equal(recovered.result.kind, "served");
    yield* voice.forget(caller.callId);
  }).pipe(
    Effect.provide(harness),
    Effect.ensuring(
      Effect.sync(() => {
        taskWaitFailure = undefined;
      }),
    ),
  ),
);

it.effect("keeps watching a checked thread wait that timed out, but not a completed run", () =>
  Effect.gen(function* () {
    const voice = yield* Voice.GrokBotVoiceOrchestration;
    yield* voice.activate(caller);
    for (const pending of [true, false]) {
      threadWaitTimedOut = pending;
      const result = yield* voice.call({
        ...caller,
        access: "read",
        name: "t3_thread_wait",
        input: { threadId: "observed-thread" },
      });
      assert.equal(result.result.kind, "served");
      if (pending)
        assert.deepStrictEqual(result.target, {
          threadId: "observed-thread",
          runId: "observed-run",
        });
      else assert.isUndefined(result.target);
    }
    yield* voice.forget(caller.callId);
  }).pipe(
    Effect.provide(harness),
    Effect.ensuring(
      Effect.sync(() => {
        threadWaitTimedOut = true;
      }),
    ),
  ),
);

it.effect("an explicit watch observes an existing run without sending another message", () =>
  Effect.gen(function* () {
    const voice = yield* Voice.GrokBotVoiceOrchestration;
    yield* voice.activate(caller);
    const result = yield* voice.call({
      ...caller,
      access: "read",
      name: "t3_watch_thread",
      input: { threadId: "observed-thread" },
    });
    assert.equal(result.result.kind, "served");
    assert.deepStrictEqual(result.target, {
      threadId: "observed-thread",
      runId: "observed-run",
      watch: true,
    });
    assert.isTrue(Voice.isTool("t3_thread_organize"));
    assert.isTrue(Voice.isTool("t3_pending_request_respond"));
    assert.isTrue(Voice.isTool("t3_pending_approval_respond"));
    yield* voice.forget(caller.callId);
  }).pipe(Effect.provide(harness)),
);

it.effect.each([
  [
    "t3_pending_request_respond",
    { requestId: "request", answers: { choice: "main" }, userConfirmed: true },
  ],
  [
    "t3_pending_request_respond",
    { threadId: "ordinary-thread", requestId: "request", answers: { choice: "main" } },
  ],
  [
    "t3_pending_approval_respond",
    { requestId: "request", decision: "accept", userConfirmed: true },
  ],
  [
    "t3_pending_approval_respond",
    { threadId: "ordinary-thread", requestId: "request", decision: "accept" },
  ],
  [
    "t3_pending_approval_respond",
    {
      threadId: "ordinary-thread",
      requestId: "request",
      decision: "acceptForSession",
      userConfirmed: true,
    },
  ],
] as const)(
  "%s refuses a missing explicit thread/consent or a broader approval decision before execution",
  ([name, input]) =>
    Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceOrchestration;
      yield* voice.activate(caller);
      const result = yield* voice.call({ ...caller, name, input, access: "operate" });
      assert.equal(result.result.kind, "invalid_input");
      assert.equal((result.result.output as { code: string }).code, "invalid_arguments");
      yield* voice.forget(caller.callId);
    }).pipe(Effect.provide(harness)),
);

it.effect("preserves an authority acquisition failure and can acquire again after recovery", () =>
  Effect.gen(function* () {
    const voice = yield* Voice.GrokBotVoiceOrchestration;
    acquisitionFailure = new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The call conversation is archived. Reopen it before calling.",
    });
    yield* voice.activate(caller);
    const failed = yield* voice.call({
      ...caller,
      access: "operate",
      name: "orchestrator_capabilities",
      input: {},
    });
    assert.strictEqual(failed.result.kind, "invalid_input");
    assert.include((failed.result.output as { error: string }).error, "archived");
    acquisitionFailure = undefined;
    yield* voice.activate(caller);
    const recovered = yield* voice.call({
      ...caller,
      access: "operate",
      name: "orchestrator_capabilities",
      input: {},
    });
    assert.strictEqual(recovered.result.kind, "served");
    yield* voice.forget(caller.callId);
  }).pipe(
    Effect.provide(harness),
    Effect.ensuring(
      Effect.sync(() => {
        acquisitionFailure = undefined;
      }),
    ),
  ),
);

it.effect(
  "direct call tools require activation and preserve the checked MCP read-only ceiling",
  () =>
    Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceOrchestration;
      const inactive = yield* voice.call({
        ...caller,
        access: "operate",
        name: "delegate_task",
        input: { task: "work" },
      });
      assert.strictEqual(inactive.result.kind, "invalid_input");
      yield* voice.activate(caller);
      const capabilities = yield* voice.call({
        ...caller,
        access: "read",
        name: "orchestrator_capabilities",
        input: {},
      });
      assert.strictEqual(capabilities.result.kind, "served");
      assert.strictEqual(
        (capabilities.result.output as { features: { appOwnedSubagents: boolean } }).features
          .appOwnedSubagents,
        true,
      );
      const denied = yield* voice.call({
        ...caller,
        access: "read",
        name: "t3_thread_launch",
        input: { title: "Read-only launch", scratch: true, runtimeMode: "full-access" },
      });
      assert.strictEqual(denied.result.kind, "invalid_input");
      assert.strictEqual((denied.result.output as { code: string }).code, "capability_denied");
      assert.isUndefined(denied.target);
      const noParent = yield* voice.call({
        ...caller,
        access: "operate",
        name: "delegate_task",
        input: { task: "Do the task", mode: "async" },
      });
      assert.strictEqual(
        (noParent.result.output as { code: string }).code,
        "thread_credential_required",
      );
      assert.isUndefined(noParent.target);
    }).pipe(Effect.provide(harness)),
);

it("realtime definitions reuse the MCP catalog and include direct launch and read functions", () => {
  assert.includeMembers(
    Voice.tools.map((tool) => tool.name),
    ["delegate_task", "task_status", "t3_thread_launch", "t3_thread_read"],
  );
  assert.notInclude(
    Voice.tools.map((tool) => tool.name),
    "t3_run_task",
  );
  assert.notIncludeMembers(
    Voice.tools.map((tool) => tool.name),
    ["create_threads", "request_secret"],
  );
  assert.isFalse(Voice.isTool("create_threads"));
  assert.isFalse(Voice.isTool("request_secret"));
});
