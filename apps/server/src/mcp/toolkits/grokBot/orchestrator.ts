import {
  GrokBotError,
  GrokBotOrchestratorConfig,
  GrokBotOrchestratorError,
  GrokBotOrchestratorStatusInput,
  GrokBotOpenThreadInput,
  GrokBotOpenThreadResult,
  GrokBotThreadError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as GrokBotOrchestratorService from "../../../grokBot/GrokBotOrchestratorService.ts";
import * as GrokBotThreadService from "../../../grokBot/GrokBotThreadService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

const shared = {
  parameters: GrokBotOrchestratorStatusInput,
  success: GrokBotOrchestratorConfig,
  failure: Schema.Union([GrokBotError, GrokBotOrchestratorError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [GrokBotOrchestratorService.GrokBotOrchestratorService],
};
export const toolkit = Toolkit.make(
  Tool.make("grok_bot_open_thread", {
    parameters: GrokBotOpenThreadInput,
    success: GrokBotOpenThreadResult,
    failure: Schema.Union([
      GrokBotError,
      GrokBotOrchestratorError,
      GrokBotThreadError,
      OrchestratorMcpFailure,
    ]),
    failureMode: "return",
    description:
      "Open or reuse the selected native account's persistent Grok Bot project thread. Restores an archived match and imports the bot's initial pin. Requires full access because creation uses project runtime settings and may create Scratch. Does not enable a provider or send a message. Pass projectId when Scratch is unavailable.",
    dependencies: [
      GrokBotThreadService.GrokBotThreadService,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
  }),
  Tool.make("grok_bot_orchestrator_config", {
    ...shared,
    description:
      "Inspect native Grok Bot Orchestrator V2 setup, actual provider models, and public endpoint readiness. Uses the selected native account. Missing T3 Connect blocks execution; this read does not change provider settings.",
  }).annotate(Tool.Readonly, true),
  Tool.make("grok_bot_orchestrator_setup", {
    ...shared,
    description:
      "Enable the native Grok Bot V2 provider for the selected account and refresh its bot models. Requires full access. Repeated setup is idempotent and refuses a different account binding. Choose a bot as the model in a normal project thread. Creates no threads and sends no bot messages.",
    dependencies: [
      ...shared.dependencies,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
  }),
);

export const layer = McpToolAccess.toLayer(toolkit, {
  grok_bot_open_thread: McpToolAccess.writesEnvironment((input) =>
    Effect.flatMap(GrokBotThreadService.GrokBotThreadService, (service) => service.open(input)),
  ),
  grok_bot_orchestrator_config: McpToolAccess.reads((input) =>
    Effect.flatMap(GrokBotOrchestratorService.GrokBotOrchestratorService, (service) =>
      service.inspect({ ...input, action: "status" }),
    ),
  ),
  grok_bot_orchestrator_setup: McpToolAccess.writesEnvironment((input) =>
    Effect.flatMap(GrokBotOrchestratorService.GrokBotOrchestratorService, (service) =>
      service.setup(input),
    ),
  ),
});
