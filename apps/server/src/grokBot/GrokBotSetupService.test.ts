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
import * as Bots from "./GrokBotService.ts";
import * as Setup from "./GrokBotSetupService.ts";
import * as Binding from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";

const fixtureWith = (
  options: { installed?: boolean; sendFails?: boolean; conversation?: boolean } = {},
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
          runtimeRequest: (_binding, method) =>
            Effect.succeed(
              method === "GetGrokBotUserRuntimeSettings"
                ? { settings: { mainAgentId: "actual-primary" } }
                : {
                    agents: [
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
        Layer.mock(Bots.GrokBotService)({
          status: Effect.succeed({
            installed: options.installed ?? true,
            managed: true,
            sessionPresent: true,
          }),
          send: (input) =>
            Effect.gen(function* () {
              sends++;
              assert.equal(input.botId, "actual-primary");
              yield* Deferred.succeed(sent, input.message);
              if (options.sendFails)
                return yield* new GrokBotError({ reason: "native_unavailable" });
              return { accepted: true };
            }),
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
                      text: "https://dev.example.test/oauth/mcp/authorize?state=setup",
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
  it.effect("reports bridge installation failure without sending a message", () =>
    Effect.gen(function* () {
      const f = yield* fixtureWith({ installed: false });
      yield* f.service.send;
      yield* Deferred.await(f.persisted);
      const status = yield* f.service.status;
      assert.equal(status.phase, "failed");
      assert.include(status.error!, "CLI bridge");
      assert.equal(f.sends(), 0);
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
