import * as Effect from "effect/Effect";
import * as Invocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Service from "./service.ts";
import { MuseAgentToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(MuseAgentToolkit, {
  muse_agent_discover: McpToolAccess.reads(() =>
    Effect.flatMap(Service.MuseAgentMcpService, (service) => service.discover).pipe(
      Effect.provide(Service.layer),
    ),
  ),
  muse_agent_send: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      const service = yield* Service.MuseAgentMcpService;
      return yield* service.send(scope, input, check.pipe(Effect.asVoid));
    }).pipe(Effect.provide(Service.layer)),
  ),
});
