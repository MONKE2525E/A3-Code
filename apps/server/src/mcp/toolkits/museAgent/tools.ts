import {
  NativeAgentError,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  ProviderInstanceId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Native from "../../../nativeAgents/NativeAgentService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../OrchestratorMcpService.ts";

const shared = {
  failure: Schema.Union([NativeAgentError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    Native.NativeAgentService,
    ThreadManagement.ThreadManagementService,
    Invocation.McpInvocationContext,
    Orchestrator.OrchestratorMcpService,
  ],
};
export const MuseAgentToolkit = Toolkit.make(
  Tool.make("muse_agent_discover", {
    ...shared,
    description:
      "Discover the configured Muse native agent in this environment. Returns its opaque provider reference and readiness without account credentials. Muse is separate from persistent Grok Bots; never use its ID with grok_bot_send. Does not connect or message Muse.",
    success: Schema.Struct({
      available: Schema.Boolean,
      reference: Schema.NullOr(
        Schema.Struct({
          source: Schema.Literal("muse-agent"),
          agentId: Schema.Literal("muse"),
          providerInstanceId: ProviderInstanceId,
        }),
      ),
    }),
  }).annotate(Tool.Readonly, true),
  Tool.make("muse_agent_send", {
    ...shared,
    description:
      "Message the configured Muse through its account-bound canonical T3 conversation. Discover providerInstanceId with muse_agent_discover. Omit sessionId for Main chat. Requires full access. Queues behind active work and returns IDs for t3_thread_read/t3_thread_wait. Reuse clientRequestId after an uncertain reply; never send a second key to retry the same message. This is messaging a persistent agent, not delegation. Refuses self-messaging.",
    parameters: Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      sessionId: Schema.optionalKey(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
      ),
      message: OrchestratorMcpThreadSendInput.fields.message,
      clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    }),
    success: OrchestratorMcpThreadSendResult,
  }).annotate(Tool.Destructive, true),
);
