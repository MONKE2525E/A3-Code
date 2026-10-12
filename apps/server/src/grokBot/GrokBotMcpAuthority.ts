import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpRemoteRunValidator from "../mcp/McpRemoteRunValidator.ts";
import * as GrokBotManagedStateStore from "./GrokBotManagedStateStore.ts";
import * as GrokBotNativeRuntimeService from "./GrokBotNativeRuntimeService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

/** A still-active T3 run cannot keep a cloud grant after the native account changes. */
const make = Effect.gen(function* () {
  const native = yield* GrokBotNativeRuntimeService.GrokBotNativeRuntimeService;
  const store = yield* GrokBotManagedStateStore.GrokBotManagedStateStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return McpRemoteRunValidator.McpRemoteRunValidator.of({
    validate: (scope) =>
      Effect.gen(function* () {
        const remote = scope.thread.remoteRun;
        if (remote === undefined) return false;
        const record = yield* store.lookupTurn(remote);
        if (record === undefined || record.state === "settled") return false;
        const owned = record.identity.native;
        if (
          owned.threadId !== scope.thread.threadId ||
          owned.providerInstanceId !== scope.thread.providerInstanceId ||
          owned.binding !== (yield* native.accountBinding)
        )
          return false;
        const thread = yield* projections.getThreadShell(owned.threadId);
        if (
          thread === null ||
          thread.deletedAt !== null ||
          thread.archivedAt !== null ||
          thread.providerInstanceId !== owned.providerInstanceId ||
          thread.modelSelection.model !== owned.botId ||
          thread.activeRunId !== record.identity.runId
        )
          return false;
        const records = yield* projections.getThreadRecords(owned.threadId, ["runs"], {
          runIds: [record.identity.runId],
        });
        const run = records.runs.find((candidate) => candidate.id === record.identity.runId);
        if (
          run === undefined ||
          !["starting", "running", "waiting"].includes(run.status) ||
          run.activeAttemptId !== record.identity.attemptId ||
          run.rootNodeId !== record.identity.rootNodeId ||
          run.providerInstanceId !== owned.providerInstanceId ||
          run.modelSelection.model !== owned.botId
        )
          return false;
        return true;
      }).pipe(Effect.orElseSucceed(() => false)),
  });
});

export const layer = Layer.effect(McpRemoteRunValidator.McpRemoteRunValidator, make);
