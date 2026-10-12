import {
  GrokBotCompleteTurnInput,
  GrokBotCompleteTurnResult,
  GrokBotCompletionError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as GrokBotTurnCompletion from "../../../grokBot/GrokBotTurnCompletion.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

export const toolkit = Toolkit.make(
  Tool.make("grok_bot_complete_turn", {
    parameters: GrokBotCompleteTurnInput,
    success: GrokBotCompleteTurnResult,
    failure: Schema.Union([GrokBotCompletionError, OrchestratorMcpFailure]),
    failureMode: "return",
    description:
      "Declare your own native Grok Bot T3-managed turn finished. finalText is the complete final answer published in T3 before the run settles. Call this as your last T3 action after required child results. Only the authenticated bot's exact active run attempt may call it. Optional managedSkillHash acknowledges the expected T3 protocol hash only after your native Read tool read the specified workflow SKILL.md and you verified its protocol body and hash metadata. Omit it if the file is missing, different, or unreadable. Acceptance does not report native workflow success or stop cloud execution. Retry only the same finalText and hash after a lost response.",
    dependencies: [
      GrokBotTurnCompletion.GrokBotTurnCompletion,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
  }),
);

export const layer = McpToolAccess.toLayer(toolkit, {
  grok_bot_complete_turn: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(GrokBotTurnCompletion.GrokBotTurnCompletion, (service) =>
      service.complete(input),
    ),
  ),
});
