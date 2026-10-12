import { assert, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
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
const harness = Voice.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Access.HandlersLayer.layer(OrchestratorHandlers.layer),
      Access.HandlersLayer.layer(ProjectHandlers.layer),
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
});
