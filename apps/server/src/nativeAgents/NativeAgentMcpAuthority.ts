import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpRemoteRunValidator from "../mcp/McpRemoteRunValidator.ts";
import * as GrokBotMcpAuthority from "../grokBot/GrokBotMcpAuthority.ts";
import * as Muse from "../museAgent/MuseAgentNativeRuntimeService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Settings from "../serverSettings.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
const decodeBinding = Schema.decodeUnknownOption(Schema.Struct({ accountBinding: Schema.String }));

/** Native transports share one dispatcher; Grok retains its managed grant checks. */
export const layer = Layer.effect(
  McpRemoteRunValidator.McpRemoteRunValidator,
  Effect.gen(function* () {
    const grok = yield* McpRemoteRunValidator.McpRemoteRunValidator;
    const native = yield* Muse.MuseAgentNativeRuntimeService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const settings = yield* Settings.ServerSettingsService;
    return McpRemoteRunValidator.McpRemoteRunValidator.of({
      validate: (scope) =>
        Effect.gen(function* () {
          const remote = scope.thread.remoteRun;
          if (!remote) return false;
          const config = (yield* settings.getSettings).providerInstances[
            scope.thread.providerInstanceId
          ];
          if (config?.driver === "grok-bot")
            return config.enabled !== false && (yield* grok.validate(scope));
          if (config?.driver !== "muse-agent" || config.enabled === false) return false;
          const binding = decodeBinding(config.config);
          if (
            Option.isNone(binding) ||
            binding.value.accountBinding !== (yield* native.accountBinding)
          )
            return false;
          const thread = yield* projections.getThreadShell(scope.thread.threadId);
          if (
            !thread ||
            !thread.id.startsWith("muse-agent:") ||
            thread.deletedAt !== null ||
            thread.archivedAt !== null ||
            thread.providerInstanceId !== scope.thread.providerInstanceId ||
            thread.modelSelection.instanceId !== scope.thread.providerInstanceId ||
            thread.modelSelection.model !== "muse" ||
            (thread.activeRunId !== remote.runId &&
              !(
                thread.activeRunId === null &&
                thread.latestRunId === remote.runId &&
                thread.activityRunStatus === "waiting"
              ))
          )
            return false;
          const records = yield* projections.getThreadRecords(thread.id, ["runs"], {
            runIds: [remote.runId],
          });
          const run = records.runs.find((item) => item.id === remote.runId);
          return (
            run !== undefined &&
            run.activeAttemptId === remote.attemptId &&
            run.providerInstanceId === scope.thread.providerInstanceId &&
            run.modelSelection.instanceId === scope.thread.providerInstanceId &&
            run.modelSelection.model === "muse" &&
            ["starting", "running", "waiting"].includes(run.status) &&
            binding.value.accountBinding === (yield* native.accountBinding)
          );
        }).pipe(Effect.orElseSucceed(() => false)),
    });
  }),
).pipe(Layer.provide(GrokBotMcpAuthority.layer));
