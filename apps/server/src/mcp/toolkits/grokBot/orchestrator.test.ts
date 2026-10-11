import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  type AuthMcpClientAccess,
  type GrokBotOrchestratorConfig,
  GrokBot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as Service from "../../../grokBot/GrokBotOrchestratorService.ts";
import * as BotThreads from "../../../grokBot/GrokBotThreadService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Http from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Orchestrator from "./orchestrator.ts";
import * as BotService from "../../../grokBot/GrokBotService.ts";
import * as Handlers from "./handlers.ts";
import { GrokBotToolkit } from "./tools.ts";

const result: typeof GrokBotOrchestratorConfig.Type = {
  bridge: { installed: true, managed: true, sessionPresent: true },
  botIds: [],
  provider: null,
  state: "not_configured",
  authentication: "native_account",
  directDelegationSupported: true,
  publicEndpointReadiness: { ready: false, reason: "T3 Connect is required." },
  instructions: "Choose a bot in a project thread.",
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope = (access: AuthMcpClientAccess): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "test-client",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  client: { access, sessionId: "client", label: "fixture" },
});
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Schema.String),
      threadId: Schema.optionalKey(ThreadId),
    }),
  ),
);
const decodeRoster = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(GrokBot)));
const call = (name: string, access: AuthMcpClientAccess, args: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const response = yield* (yield* McpServer.McpServer).callTool({ name, arguments: args });
    return yield* decode(
      response.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    );
  }).pipe(
    Effect.provideService(Invocation.McpInvocationContext, scope(access)),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect(
  "advertises bot discovery and messaging and reads the native roster without peer sessions",
  () => {
    const roster: readonly GrokBot[] = [
      {
        id: "persistent-bot",
        name: "Coordinator",
        label: "Coordinator",
        description: "",
        avatarShape: "blob",
        avatarColor: "green",
        notificationEnabled: true,
        hidden: false,
        pinned: false,
        featured: false,
        pullRequests: [],
      },
    ];
    const layer = Http.toolkitRegistration(GrokBotToolkit, Handlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Threads.ThreadManagementService)({}),
          Layer.mock(BotThreads.GrokBotThreadService)({}),
          Layer.mock(BotService.GrokBotService)({ list: Effect.succeed(roster) }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      assert.include(names, "grok_bots_list");
      assert.include(names, "grok_bot_send");
      const response = yield* server.callTool({ name: "grok_bots_list", arguments: {} });
      const decoded = yield* decodeRoster(
        response.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      );
      assert.deepEqual(decoded, roster);
    }).pipe(
      Effect.provideService(Invocation.McpInvocationContext, scope("read-only")),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(layer),
    );
  },
);

it.effect(
  "agent send uses the managed thread service and refuses clients below full access",
  () => {
    let sends = 0;
    const layer = Http.toolkitRegistration(GrokBotToolkit, Handlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Threads.ThreadManagementService)({}),
          Layer.mock(BotService.GrokBotService)({
            send: () => Effect.die("legacy CLI must not send"),
          }),
          Layer.mock(BotThreads.GrokBotThreadService)({
            send: (input, caller) => {
              sends++;
              assert.equal(input.clientRequestId, "retry-key");
              assert.equal(caller.requestNamespace, "test-client");
              return Effect.succeed({
                accepted: true,
                threadId: ThreadId.make("bot-thread"),
                delivery: "queued" as const,
              });
            },
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const args = { botId: "bot", message: "proof", clientRequestId: "retry-key" };
      for (const access of ["read-only", "approval-required"] as const) {
        assert.isDefined((yield* call("grok_bot_send", access, args)).code);
        assert.equal(sends, 0);
      }
      assert.equal((yield* call("grok_bot_send", "full-access", args)).threadId, "bot-thread");
      assert.equal(sends, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("readonly status cannot request setup and settings writes require full access", () => {
  let setups = 0;
  let opens = 0;
  let inspectedAction: string | undefined;
  const layer = Http.toolkitRegistration(Orchestrator.toolkit, Orchestrator.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.mock(BotThreads.GrokBotThreadService)({
          open: () => {
            opens++;
            return Effect.succeed({
              threadId: ThreadId.make("bot-thread"),
              providerInstanceId: ProviderInstanceId.make("grok-bot"),
            });
          },
        }),
        Layer.mock(Service.GrokBotOrchestratorService)({
          inspect: (input) => {
            inspectedAction = input.action;
            return Effect.succeed(result);
          },
          setup: () => {
            setups++;
            return Effect.succeed(result);
          },
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const status = yield* call("grok_bot_orchestrator_config", "read-only", { action: "setup" });
    assert.equal(status.state, "not_configured");
    assert.equal(inspectedAction, "status");
    assert.equal(setups, 0);
    for (const access of ["read-only", "approval-required"] as const) {
      const refusal = yield* call("grok_bot_orchestrator_setup", access);
      assert.isDefined(refusal.code);
      assert.equal(setups, 0);
      const deniedOpen = yield* call("grok_bot_open_thread", access, { botId: "bot" });
      assert.isDefined(deniedOpen.code);
      assert.equal(opens, 0);
    }
    assert.equal(
      (yield* call("grok_bot_orchestrator_setup", "full-access")).state,
      "not_configured",
    );
    assert.equal(setups, 1);
    assert.equal(
      (yield* call("grok_bot_open_thread", "full-access", { botId: "bot" })).threadId,
      "bot-thread",
    );
    assert.equal(opens, 1);
  }).pipe(Effect.provide(layer));
});
