import {
  GrokBot,
  GrokBotConversation,
  GrokBotError,
  GrokBotOrchestratorError,
  GrokBotThreadError,
  GrokBotStatus,
  GrokBotReadInput,
  GrokBotSendInput,
  GrokBotSendResult,
  GrokBotUpdateInput,
  GrokBotLinkInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as GrokBotService from "../../../grokBot/GrokBotService.ts";
import * as BotThreads from "../../../grokBot/GrokBotThreadService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([
    GrokBotError,
    GrokBotThreadError,
    GrokBotOrchestratorError,
    OrchestratorMcpFailure,
  ]),
  failureMode: "return" as const,
  dependencies: [
    GrokBotService.GrokBotService,
    BotThreads.GrokBotThreadService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};
export const GrokBotToolkit = Toolkit.make(
  Tool.make("grok_bots_status", {
    ...shared,
    description:
      "Check whether this environment has a Grok Bot CLI bridge and a desktop session. No credentials are returned.",
    success: GrokBotStatus,
  }).annotate(Tool.Readonly, true),
  Tool.make("grok_bots_setup", {
    ...shared,
    description:
      "Install the pinned unofficial Grok Bot bridge inside this T3 instance's home. Requires full access. Uses the Grok Bot desktop app's existing sign-in.",
    success: GrokBotStatus,
  }),
  Tool.make("grok_bots_list", {
    ...shared,
    description:
      "Discover named persistent bots (for example CEO). Use this, not your own session list, to find a bot by name. Lists the signed-in account's real persistent Grok Bots and their T3 pin, featured, and PR associations.",
    success: Schema.Array(GrokBot),
  }).annotate(Tool.Readonly, true),
  Tool.make("grok_bot_read", {
    ...shared,
    description:
      "Read a bot's bounded recent conversation. Merged PR associations are removed without settling the bot.",
    parameters: GrokBotReadInput,
    success: GrokBotConversation,
  }).annotate(Tool.Readonly, true),
  Tool.make("grok_bot_send", {
    ...shared,
    description:
      "Send a message to a named persistent bot (find it with grok_bots_list) through its persistent T3 thread. Requires full access. Queues behind active work and returns thread/message/run IDs for t3_thread_read or t3_thread_wait. Reuse clientRequestId when retrying the same message; do not resend with a new key after an uncertain response. Use t3_thread_send_attachments on this thread for prepared attachments.",
    parameters: GrokBotSendInput,
    success: GrokBotSendResult,
  }),
  Tool.make("grok_bot_update", {
    ...shared,
    description:
      "Update a bot's real profile or notifications, or its T3 pin/featured preference. Omitted fields are preserved.",
    parameters: GrokBotUpdateInput,
    success: GrokBot,
  }),
  Tool.make("grok_bot_link_pull_request", {
    ...shared,
    description:
      "Associate a PR with a bot, or remove it with remove=true. A confirmed merge removes only that association; the bot stays persistent.",
    parameters: GrokBotLinkInput,
    success: GrokBot,
  }),
);
