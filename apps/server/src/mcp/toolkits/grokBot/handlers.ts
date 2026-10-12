import * as Effect from "effect/Effect";
import * as GrokBotService from "../../../grokBot/GrokBotService.ts";
import * as BotThreads from "../../../grokBot/GrokBotThreadService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GrokBotToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(GrokBotToolkit, {
  grok_bots_status: McpToolAccess.reads(() =>
    Effect.flatMap(GrokBotService.GrokBotService, (service) => service.status),
  ),
  grok_bots_setup: McpToolAccess.writesEnvironment(() =>
    Effect.flatMap(GrokBotService.GrokBotService, (service) => service.setup),
  ),
  grok_bots_list: McpToolAccess.reads(() =>
    Effect.flatMap(GrokBotService.GrokBotService, (service) => service.list),
  ),
  grok_bot_read: McpToolAccess.reads((input) =>
    Effect.flatMap(GrokBotService.GrokBotService, (service) => service.read(input.botId)),
  ),
  grok_bot_send: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* BotThreads.GrokBotThreadService;
      const caller = yield* Invocation.McpInvocationContext;
      return yield* service.send(input, {
        requestNamespace: caller.requestNamespace,
        ...(caller.thread === undefined ? {} : { senderThreadId: caller.thread.threadId }),
      });
    }),
  ),
  grok_bot_update: McpToolAccess.writesEnvironment((input) =>
    Effect.flatMap(GrokBotService.GrokBotService, (service) => service.update(input)),
  ),
  grok_bot_link_pull_request: McpToolAccess.writes((input) =>
    Effect.flatMap(GrokBotService.GrokBotService, (service) => service.link(input)),
  ),
});
