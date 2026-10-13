import { GrokBotError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import * as Endpoint from "../cloud/ManagedEndpointAddress.ts";
import * as Native from "./GrokBotNativeService.ts";
import * as Runtime from "./GrokBotNativeRuntimeService.ts";
import * as Bots from "./GrokBotService.ts";
import * as Setup from "./GrokBotSetupService.ts";
import * as Marketplace from "./GrokBotMarketplaceService.ts";
import * as Binding from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import { resolveGrokBotOAuthRedirect } from "../../../web/src/components/grokBot/grokBotSetupFlow.ts";

const fixtureWith = (
  options: {
    installed?: boolean;
    sendFails?: boolean;
    conversation?: boolean;
    connector?: boolean;
    connectorAuthenticated?: boolean;
    primaryMissing?: boolean;
    noPrimary?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const account = yield* Ref.make("account-a");
    const publicOrigin = yield* Ref.make("https://dev.example.test/");
    const sent = yield* Deferred.make<string>();
    const persisted = yield* Deferred.make<void>();
    let sends = 0;
    const layer = Setup.layer.pipe(
      Layer.provide(
        Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              yield* fs.rename(from, to);
              const saved = JSON.parse(yield* fs.readFileString(to));
              if (saved.status.phase === "verifying" || saved.status.phase === "failed")
                yield* Deferred.succeed(persisted, undefined);
            }),
        }),
      ),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(Config.layerTest(root, root)),
      Layer.provide(
        Layer.mock(Native.GrokBotNativeService)({
          accountBinding: Ref.get(account),
          readMcp: () =>
            Effect.succeed({
              servers: options.connector
                ? [
                    { id: 8, url: "https://other.example.test/mcp", userHasAccessToken: false },
                    {
                      id: 7,
                      url: "https://dev.example.test/mcp",
                      userHasAccessToken: options.connectorAuthenticated ?? false,
                    },
                  ]
                : [],
            }),
          runtimeRequest: (_binding, method) =>
            Effect.succeed(
              method === "GetGrokBotUserRuntimeSettings"
                ? { settings: options.noPrimary ? {} : { mainAgentId: "actual-primary" } }
                : {
                    agents: options.primaryMissing
                      ? []
                      : [
                          { agentId: "other-bot", name: "Other" },
                          { agentId: "actual-primary", name: "Primary" },
                        ],
                  },
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(Endpoint.ManagedEndpointAddress)({
          read: Ref.get(publicOrigin).pipe(
            Effect.map((origin) => ({
              httpBaseUrl: origin,
              wsBaseUrl: origin.replace("https:", "wss:"),
              providerKind: "manual" as const,
            })),
          ),
        }),
      ),
      Layer.provide(
        Layer.mock(Runtime.GrokBotNativeRuntimeService)({
          startTurn: (input) =>
            Effect.gen(function* () {
              sends++;
              assert.equal(input.botId, "actual-primary");
              assert.equal(input.sessionId, "");
              assert.isUndefined(input.mcpConfig);
              assert.isUndefined(input.taskId);
              yield* Deferred.succeed(sent, input.text);
              if (options.sendFails)
                return yield* new Runtime.NativeRuntimeError({ kind: "uncertain" });
              return { delivery: "accepted" as const };
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(Bots.GrokBotService)({
          status: Effect.succeed({
            installed: options.installed ?? true,
            managed: true,
            sessionPresent: true,
          }),
          send: () => Effect.die("Setup must not require the desktop gateway"),
          read: () =>
            options.conversation
              ? Effect.map(Deferred.await(sent), (prompt) => ({
                  bot: {
                    id: "actual-primary",
                    name: "Primary",
                    label: "",
                    description: "",
                    avatarShape: "",
                    avatarColor: "",
                    notificationEnabled: true,
                    hidden: false,
                    pinned: false,
                    featured: false,
                    pullRequests: [],
                  },
                  messages: [
                    {
                      id: "user-setup",
                      role: "user" as const,
                      sender: { kind: "user" as const },
                      text: prompt,
                      timestampMs: 0,
                      streaming: false,
                    },
                    {
                      role: "assistant" as const,
                      id: "oauth-link",
                      sender: { kind: "bot" as const, id: "actual-primary", name: "Primary" },
                      timestampMs: 1,
                      streaming: false,
                      text: options.connector
                        ? "Approve the new connector card."
                        : "https://dev.example.test/oauth/mcp/authorize?state=setup",
                    },
                  ],
                }))
              : Effect.fail(new GrokBotError({ reason: "native_unavailable" })),
        }),
      ),
    );
    const context = yield* Layer.build(layer);
    const service = Context.get(context, Setup.GrokBotSetupService);
    return { service, account, publicOrigin, sent, persisted, root, fs, sends: () => sends };
  });
const fixture = fixtureWith();

it.layer(NodeServices.layer)("guided GrokBot setup", (it) => {
  it.effect(
    "distinguishes an absent primary selection from a missing starred bot without sending",
    () =>
      Effect.gen(function* () {
        const missing = yield* fixtureWith({ primaryMissing: true });
        const status = yield* missing.service.send;
        assert.equal(status.phase, "needs_prerequisite");
        assert.include(status.error ?? "", "starred primary bot was not found");
        assert.equal(missing.sends(), 0);
        const unselected = yield* fixtureWith({ noPrimary: true });
        assert.equal((yield* unselected.service.send).phase, "needs_primary");
        assert.equal(unselected.sends(), 0);
      }),
  );
  it.effect("offers authorization only for this environment's native connector", () =>
    Effect.gen(function* () {
      const f = yield* fixtureWith({ conversation: true, connector: true });
      yield* f.service.send;
      yield* Deferred.await(f.persisted);
      const status = yield* f.service.status;
      assert.equal(status.phase, "awaiting_authorization");
      assert.equal(status.connectorServerId, 7);
      assert.equal(status.authorizationUrl, null);
      assert.equal(status.complete, false);
    }),
  );
  it.effect("offers the matching connector when the native transcript is unavailable", () =>
    Effect.gen(function* () {
      const f = yield* fixtureWith({ connector: true, conversation: false });
      yield* f.service.send;
      yield* Deferred.await(f.persisted);
      const status = yield* f.service.status;
      assert.equal(status.phase, "awaiting_authorization");
      assert.equal(status.connectorServerId, 7);
      assert.equal(status.authorizationUrl, null);
      assert.equal(status.complete, false);
    }),
  );
  it.effect("accepts UI-generated callbacks for remote and loopback environment routes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const published = (yield* f.service.status).mcpUrl;
      const redirects: string[] = [];
      const context = yield* Layer.build(
        Marketplace.layer.pipe(
          Layer.provide(
            Layer.mock(Native.GrokBotNativeService)({
              accountBinding: Ref.get(f.account),
              readMcp: () => Effect.succeed({ servers: [{ id: 7, name: "T3", url: published }] }),
              marketplaceRequest: (_binding, request) =>
                Effect.sync(() => {
                  if (request.method !== "CheckHttpMcpStatus")
                    assert.fail("Callback validation should only check the native OAuth status");
                  redirects.push(request.input.oauthRedirectUri);
                  return { statuses: [{ id: 7, isAvailable: true, requiresAuth: false }] };
                }),
            }),
          ),
        ),
      );
      const marketplace = Context.get(context, Marketplace.GrokBotMarketplaceService);
      for (const route of [
        "http://192.168.1.10:3773",
        "http://100.64.0.2:3773",
        "http://127.0.0.1:3773",
        "https://direct.example.test",
      ]) {
        const redirectUri = resolveGrokBotOAuthRedirect("t3code://app", route, published);
        assert.isNotNull(redirectUri);
        assert.equal(
          (yield* marketplace.authenticate({
            serverId: 7,
            accountKey: "default",
            redirectUri: redirectUri!,
          })).authenticated,
          true,
        );
      }
      assert.deepEqual(redirects, [
        "https://dev.example.test/settings/marketplace?grokBotOAuth=1",
        "https://dev.example.test/settings/marketplace?grokBotOAuth=1",
        "http://127.0.0.1:3773/settings/marketplace?grokBotOAuth=1",
        "https://direct.example.test/settings/marketplace?grokBotOAuth=1",
      ]);
    }),
  );
  it.effect("waits for verification after connector authorization", () =>
    Effect.gen(function* () {
      const f = yield* fixtureWith({
        conversation: true,
        connector: true,
        connectorAuthenticated: true,
      });
      yield* f.service.send;
      yield* Deferred.await(f.persisted);
      const status = yield* f.service.status;
      assert.equal(status.phase, "verifying");
      assert.equal(status.connectorServerId, undefined);
      assert.equal(status.complete, false);
    }),
  );
  it.effect("finds this setup's OAuth reply through Check again", () =>
    Effect.gen(function* () {
      const f = yield* fixtureWith({ conversation: true });
      yield* f.service.send;
      yield* Deferred.await(f.persisted);
      const status = yield* f.service.status;
      assert.equal(status.phase, "awaiting_authorization");
      assert.equal(
        status.authorizationUrl,
        "https://dev.example.test/oauth/mcp/authorize?state=setup",
      );
      assert.equal(status.complete, false);
    }),
  );
  it.effect("sends setup directly without an installed CLI bridge", () =>
    Effect.gen(function* () {
      const f = yield* fixtureWith({ installed: false });
      yield* f.service.send;
      yield* Deferred.await(f.persisted);
      const status = yield* f.service.status;
      assert.equal(status.phase, "verifying");
      assert.equal(status.error, null);
      assert.equal(f.sends(), 1);
    }),
  );
  it.effect("reports an unconfirmed native send", () =>
    Effect.gen(function* () {
      const f = yield* fixtureWith({ sendFails: true });
      yield* f.service.send;
      yield* Deferred.await(f.persisted);
      assert.equal((yield* f.service.status).phase, "failed");
    }),
  );
  it.effect(
    "discovers the native primary, sends once, and completes only with the current MCP challenge",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.equal((yield* f.service.status).phase, "needs_setup");
        assert.equal((yield* f.service.send).complete, false);
        const prompt = yield* Deferred.await(f.sent);
        assert.include(prompt, "https://dev.example.test/mcp");
        assert.include(prompt, "grok_bot_verify_setup");
        assert.notInclude(prompt, "Default to Claude");
        const nonce = prompt.match(/with nonce ([a-f0-9]{64})/)![1]!;
        const hash = prompt.match(/managedSkillHash ([a-f0-9]{64})/)![1]!;
        yield* f.service.send;
        assert.equal(f.sends(), 1);
        const wrong = yield* f.service
          .verify({ nonce: "0".repeat(64), managedSkillHash: hash })
          .pipe(Effect.result);
        assert.equal(wrong._tag, "Failure");
        assert.equal((yield* f.service.status).complete, false);
        assert.deepEqual(yield* f.service.verify({ nonce, managedSkillHash: hash }), {
          verified: true,
        });
        assert.equal((yield* f.service.status).complete, true);
        yield* f.service.send;
        assert.equal(f.sends(), 1);
        yield* Ref.set(f.publicOrigin, "https://another.example.test/");
        assert.equal((yield* f.service.status).complete, false);
      }),
  );
  it.effect("a corrupt saved status can be repaired by an explicit new setup", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.makeDirectory(`${f.root}/userdata`, { recursive: true });
      yield* f.fs.writeFileString(`${f.root}/userdata/grokbot-setup.json`, "invalid-json");
      assert.equal((yield* f.service.status).phase, "needs_setup");
      yield* f.service.send;
      const prompt = yield* Deferred.await(f.sent);
      assert.include(prompt, "grok_bot_verify_setup");
      assert.equal(f.sends(), 1);
    }),
  );
  it.effect("expires stalled setup and rejects its old challenge", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.send;
      const prompt = yield* Deferred.await(f.sent);
      const nonce = prompt.match(/with nonce ([a-f0-9]{64})/)![1]!;
      const hash = prompt.match(/managedSkillHash ([a-f0-9]{64})/)![1]!;
      yield* TestClock.adjust("16 minutes");
      assert.equal((yield* f.service.status).phase, "stalled");
      assert.equal(
        (yield* f.service.verify({ nonce, managedSkillHash: hash }).pipe(Effect.result))._tag,
        "Failure",
      );
    }),
  );
  it.effect("invalidates completion after account or skill changes", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.send;
      const prompt = yield* Deferred.await(f.sent);
      const nonce = prompt.match(/with nonce ([a-f0-9]{64})/)![1]!;
      const hash = prompt.match(/managedSkillHash ([a-f0-9]{64})/)![1]!;
      assert.include(prompt, Binding.GROK_BOT_MANAGED_SKILL_BODY);
      yield* Ref.set(f.account, "account-b");
      assert.equal((yield* f.service.status).phase, "needs_setup");
      assert.equal(
        (yield* f.service.verify({ nonce, managedSkillHash: hash }).pipe(Effect.result))._tag,
        "Failure",
      );
    }),
  );
});

it("only exposes authorization URLs following this setup echo, without relying on clock agreement", () => {
  const nonce = "nonce-of-this-setup";
  const fresh = "https://dev.example.test/oauth/mcp/authorize?state=fresh";
  const messages = [
    { role: "assistant" as const, text: "https://dev.example.test/oauth/mcp/authorize?state=old" },
    { role: "user" as const, text: `Set up with nonce ${nonce}` },
    {
      role: "assistant" as const,
      text: "https://another.example.test/oauth/mcp/authorize?state=wrong",
    },
    { role: "assistant" as const, text: `Open [authorization](${fresh}).` },
  ];
  assert.equal(
    Setup.grokBotSetupAuthorizationUrl(messages, nonce, "https://dev.example.test/mcp"),
    fresh,
  );
  assert.equal(
    Setup.grokBotSetupAuthorizationUrl(messages, "another-nonce", "https://dev.example.test/mcp"),
    null,
  );
  assert.equal(
    Setup.grokBotSetupAuthorizationUrl(messages, nonce, "https://different.example.test/mcp"),
    null,
  );
});
