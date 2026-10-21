import {
  NativeAgentError,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Native from "../../../nativeAgents/NativeAgentService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../OrchestratorMcpService.ts";

export class MuseAgentMcpService extends Context.Service<
  MuseAgentMcpService,
  {
    readonly discover: Effect.Effect<
      {
        readonly available: boolean;
        readonly reference: {
          readonly providerInstanceId: ProviderInstanceId;
          readonly agentId: "muse";
          readonly source: "muse-agent";
        } | null;
      },
      NativeAgentError
    >;
    readonly send: <R = never>(
      scope: McpInvocationScope,
      input: {
        readonly providerInstanceId: ProviderInstanceId;
        readonly sessionId?: string | undefined;
        readonly message: OrchestratorMcpThreadSendInput["message"];
        readonly clientRequestId: string;
      },
      authorize?: Effect.Effect<void, OrchestratorMcpFailure, R>,
    ) => Effect.Effect<
      OrchestratorMcpThreadSendResult,
      NativeAgentError | OrchestratorMcpFailure,
      R
    >;
  }
>()("t3/mcp/toolkits/museAgent/service/MuseAgentMcpService") {}

const make = Effect.gen(function* () {
  const native = yield* Native.NativeAgentService;
  const orchestration = yield* Orchestrator.OrchestratorMcpService;
  const discover = native.status.pipe(
    Effect.map((status) => ({
      available: status.ready,
      reference:
        status.provider === null
          ? null
          : {
              source: "muse-agent" as const,
              agentId: "muse" as const,
              providerInstanceId: status.provider.instanceId,
            },
    })),
  );
  const send = Effect.fn("MuseAgentMcpService.send")(function* <R = never>(
    scope: McpInvocationScope,
    input: Parameters<MuseAgentMcpService["Service"]["send"]>[1],
    authorize?: Effect.Effect<void, OrchestratorMcpFailure, R>,
  ) {
    const target = yield* native.openAuthorized(
      {
        source: "muse-agent",
        agentId: "muse",
        providerInstanceId: input.providerInstanceId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      },
      authorize ?? Effect.void,
    );
    if (scope.thread?.threadId === target.threadId || scope.call?.threadId === target.threadId)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Use the current Muse conversation for this response instead of messaging itself.",
      });
    // The shared service validates caller liveness, mode ceilings and idempotency before dispatch.
    return yield* orchestration.sendToThread(scope, {
      threadId: target.threadId,
      message: input.message,
      mode: "queue",
      clientRequestId: input.clientRequestId,
    });
  });
  return MuseAgentMcpService.of({ discover, send });
});
export const layer = Layer.effect(MuseAgentMcpService, make);
