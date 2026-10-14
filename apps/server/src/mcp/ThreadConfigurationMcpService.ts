import {
  CommandId,
  type ModelSelection,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { validateModelSelection } from "../provider/modelSelectionValidation.ts";
import * as Invocation from "./McpInvocationContext.ts";
import { dispatchFailure, readThread } from "./threadAccess.ts";

export class ThreadConfigurationMcpService extends Context.Service<
  ThreadConfigurationMcpService,
  {
    readonly configure: (input: {
      readonly threadId?: ThreadId | undefined;
      readonly modelSelection: ModelSelection;
    }) => Effect.Effect<
      { sequence: number },
      OrchestratorMcpFailure,
      Invocation.McpInvocationContext
    >;
  }
>()("t3/mcp/ThreadConfigurationMcpService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const crypto = yield* Crypto.Crypto;
  const configure = Effect.fn("ThreadConfigurationMcpService.configure")(function* (input: {
    readonly threadId?: ThreadId | undefined;
    readonly modelSelection: ModelSelection;
  }) {
    const {
      projection: { thread },
    } = yield* readThread(input.threadId).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );
    const provider = (yield* providers.getProviders).find(
      (provider) => provider.instanceId === input.modelSelection.instanceId,
    );
    yield* validateModelSelection(provider, input.modelSelection).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.reason === "invalid_options" ? "invalid_request" : error.reason,
            message: error.message,
          }),
      ),
    );
    const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const result = yield* threads
      .dispatch({
        type: modelSelectionCommandType(thread.providerInstanceId, input.modelSelection),
        commandId,
        threadId: thread.id,
        modelSelection: input.modelSelection,
      })
      .pipe(Effect.mapError(dispatchFailure));
    return { sequence: result.sequence };
  });
  return ThreadConfigurationMcpService.of({ configure });
});

export const layer = Layer.effect(ThreadConfigurationMcpService, make);
