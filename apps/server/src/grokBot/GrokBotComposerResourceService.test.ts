import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Native from "./GrokBotNativeService.ts";
import * as Resources from "./GrokBotComposerResourceService.ts";

const fakeNative = (
  respond: (method: string, input: Record<string, unknown>) => unknown,
  binding = () => "account-1",
) =>
  Layer.succeed(Native.GrokBotNativeService, {
    accountBinding: Effect.sync(binding),
    runtimeRequest: (_binding: string, method: string, input: object) =>
      Effect.suspend(() => {
        const value = respond(method, input as Record<string, unknown>);
        return value instanceof Error ? Effect.fail(value) : Effect.succeed(value);
      }),
    marketplaceRequest: (
      _binding: string,
      request: { method: string; input: Record<string, unknown> },
    ) =>
      Effect.suspend(() => {
        const value = respond(request.method, request.input);
        return value instanceof Error ? Effect.fail(value) : Effect.succeed(value);
      }),
    gatewaySkills: (_binding: string, botId: string) =>
      Effect.sync(() => respond("getAgentWorkflows", { id: botId })),
  } as unknown as Native.GrokBotNativeService["Service"]);

const run = <A, E>(
  respond: (method: string, input: Record<string, unknown>) => unknown,
  effect: Effect.Effect<A, E, Resources.GrokBotComposerResourceService>,
  binding?: () => string,
) => effect.pipe(Effect.provide(Resources.layer.pipe(Layer.provide(fakeNative(respond, binding)))));

it.effect("lists user-own workflow skills, bots, and connectors without bodies or MCP config", () =>
  run(
    (method, input) => {
      if (method === "GetEffectiveUserPlugins") return { plugins: [] };
      if (method === "getAgentWorkflows") return [];
      if (method === "ListGrokBotAgents") {
        return {
          agents: [
            { agentId: "bot-1", name: "Current" },
            { agentId: "bot-2", name: "Alice" },
            { agentId: "bot-hidden", name: "Hidden", hiddenFromSidebar: true },
          ],
        };
      }
      if (method === "ListGrokBotAgentSkills") {
        assert.isUndefined((input as { includeMcpConfig?: unknown }).includeMcpConfig);
        if (input.agentId === "bot-1") {
          return {
            skills: [
              {
                id: "sand-workflow:review-pr",
                name: "review-pr",
                description: "Review a PR",
                body: "do the review",
                source: "workflow",
              },
              {
                id: "team-recipe",
                name: "Team Recipe",
                description: "Shared",
                body: "",
                source: "team",
              },
              {
                id: "sand-workflow:t3-code-managed-turn-v1",
                name: "t3-code-managed-turn-v1",
                body: "internal",
                source: "workflow",
              },
              { name: "broken" },
            ],
          };
        }
        return {
          skills: [
            {
              id: "sand-workflow:personal-note",
              name: "personal-note",
              body: "user store skill on another bot",
              source: "workflow",
            },
            {
              id: "other-team",
              name: "Other Team",
              body: "should not leak as an agent recipe",
              source: "team",
            },
          ],
        };
      }
      assert.strictEqual(method, "GetGrokBotAgentPlugins");
      assert.strictEqual(input.agentId, "bot-1");
      assert.strictEqual(input.includeMcpConfig, false);
      return {
        plugins: [
          {
            pluginId: 42,
            name: "linear",
            displayName: "Linear",
            description: "Issues",
            connectorType: "USER",
            mcpConfigJson: '{"mcpServers":{"secret":{"url":"https://hidden.example"}}}',
          },
          { pluginId: "nope", name: "bad" },
        ],
      };
    },
    Effect.gen(function* () {
      const service = yield* Resources.GrokBotComposerResourceService;
      const result = yield* service.list({ botId: "bot-1" as never });
      assert.deepStrictEqual(
        result.skills.map((skill) => `${skill.origin}:${skill.id}`),
        ["user:sand-workflow:review-pr", "agent:team-recipe", "user:sand-workflow:personal-note"],
      );
      assert.isFalse(result.skills.some((skill) => "body" in skill));
      assert.deepStrictEqual(
        result.bots.map((bot) => bot.id),
        ["bot-2"],
      );
      assert.deepStrictEqual(result.connectors, [
        {
          pluginId: "42",
          name: "linear",
          displayName: "Linear",
          description: "Issues",
          connectorType: "user",
        },
      ]);
      assert.isFalse(JSON.stringify(result).includes("mcpConfig"));
      assert.isFalse(JSON.stringify(result).includes("hidden.example"));
      assert.isFalse(JSON.stringify(result).includes("do the review"));
    }),
  ),
);

it.effect(
  "discovers the shared native library and installed account plugins for a bot with no attached skills",
  () =>
    run(
      (method, input) => {
        if (method === "ListGrokBotAgents")
          return {
            agents: [
              { agentId: "bot-1", name: "Current" },
              { agentId: "bot-2", name: "Alice", avatarShape: "house", avatarColor: "pink" },
            ],
          };
        if (method === "ListGrokBotAgentSkills") return { skills: [] };
        if (method === "GetGrokBotAgentPlugins") return {};
        if (method === "getAgentWorkflows") {
          assert.strictEqual(input.id, "bot-1");
          return [
            { id: "review-pr", name: "Review PR", source: "workflow" },
            { id: "native-plugin-skill", name: "Plugin skill", source: "plugin" },
            { id: "second-plugin-skill", name: "Plugin skill", source: "plugin" },
            { id: "t3-code-managed-turn-v1", name: "t3-code-managed-turn-v1", source: "workflow" },
          ];
        }
        assert.strictEqual(method, "GetEffectiveUserPlugins");
        assert.strictEqual(input.excludeConfiguredVariables, true);
        return {
          plugins: [
            {
              isEnabled: true,
              installMode: "EFFECTIVE_PLUGIN_INSTALL_MODE_USER",
              plugin: {
                id: "42",
                name: "linear",
                displayName: "Linear",
                skills: [{ name: "no-workflow-id" }],
              },
            },
            { isEnabled: false, plugin: { id: "43", name: "disabled" } },
          ],
        };
      },
      Effect.gen(function* () {
        const service = yield* Resources.GrokBotComposerResourceService;
        const result = yield* service.list({ botId: "bot-1" as never });
        assert.deepStrictEqual(
          result.skills.map((skill) => [skill.id, skill.origin]),
          [
            ["review-pr", "user"],
            ["native-plugin-skill", "agent"],
            ["second-plugin-skill", "agent"],
          ],
        );
        assert.strictEqual(result.skills[2]?.chipName, "plugin-skill-2");
        assert.deepStrictEqual(
          result.connectors.map((plugin) => plugin.pluginId),
          ["42"],
        );
        assert.deepStrictEqual(result.bots, [
          { id: "bot-2", name: "Alice", avatarShape: "house", avatarColor: "pink" },
        ]);
      }),
    ),
);

it.effect("fails with a bounded error when the account changes mid-request", () => {
  let reads = 0;
  return run(
    (method) => {
      if (method === "ListGrokBotAgents")
        return { agents: [{ agentId: "bot-1", name: "Current" }] };
      if (method === "ListGrokBotAgentSkills") return { skills: [] };
      return { plugins: [] };
    },
    Effect.gen(function* () {
      const service = yield* Resources.GrokBotComposerResourceService;
      const error = yield* service.list({ botId: "bot-1" as never }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "account_changed");
    }),
    () => (reads++ === 0 ? "account-1" : "account-2"),
  );
});

it.effect("keeps other skills, bots, and plugins when one native entry is malformed", () =>
  run(
    (method, input) => {
      if (method === "ListGrokBotAgents") {
        return {
          agents: [
            { agentId: "bot-1", name: "Current" },
            { agentId: "bot-2", name: "Alice", client: "not-an-object" },
            null,
          ],
        };
      }
      if (method === "ListGrokBotAgentSkills") {
        if (input.agentId === "bot-1") {
          return {
            skills: [
              { id: "sand-workflow:numeric-source", name: "numeric-source", source: 7, body: "" },
              { id: ["bad"], name: "bad-id" },
              { id: "sand-workflow:ok", name: "ok", source: "workflow", body: "x" },
            ],
          };
        }
        return {
          skills: [
            { id: "sand-workflow:alice-note", name: "alice-note", source: "workflow", body: "x" },
          ],
        };
      }
      return {
        plugins: [
          { pluginId: 7, name: "weird", connectorType: { nested: true } },
          { pluginId: 8, name: "linear", connectorType: 2 },
          "not-a-plugin",
        ],
      };
    },
    Effect.gen(function* () {
      const service = yield* Resources.GrokBotComposerResourceService;
      const result = yield* service.list({ botId: "bot-1" as never });
      assert.deepStrictEqual(
        result.skills.map((skill) => `${skill.origin}:${skill.id}`),
        [
          "agent:sand-workflow:numeric-source",
          "user:sand-workflow:ok",
          "user:sand-workflow:alice-note",
        ],
      );
      assert.deepStrictEqual(
        result.bots.map((bot) => bot.id),
        ["bot-2"],
      );
      assert.deepStrictEqual(
        result.connectors.map((connector) => [connector.pluginId, connector.connectorType]),
        [
          ["7", "unspecified"],
          ["8", "team"],
        ],
      );
    }),
  ),
);

it.effect(
  "includes plugin skills and still lists other resources when the current bot's skills fail",
  () =>
    run(
      (method) => {
        if (method === "ListGrokBotAgents")
          return { agents: [{ agentId: "bot-1", name: "Current" }] };
        if (method === "ListGrokBotAgentSkills") return new Error("native skill list unavailable");
        return {
          plugins: [
            {
              pluginId: 42,
              name: "linear",
              skills: [
                { name: "triage", description: "Triage issues" },
                { id: "plugin-native", name: "native" },
              ],
            },
          ],
        };
      },
      Effect.gen(function* () {
        const service = yield* Resources.GrokBotComposerResourceService;
        const result = yield* service.list({ botId: "bot-1" as never });
        assert.deepStrictEqual(
          result.skills.map((skill) => `${skill.origin}:${skill.id}:${skill.name}`),
          ["agent:plugin-native:native"],
        );
        assert.deepStrictEqual(
          result.connectors.map((connector) => connector.pluginId),
          ["42"],
        );
      }),
    ),
);
