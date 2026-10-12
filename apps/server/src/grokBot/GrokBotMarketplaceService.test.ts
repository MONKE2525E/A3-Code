// @effect-diagnostics nodeBuiltinImport:off - occupies loopback ports to prove a busy port is skipped, never taken over
import * as NodeNet from "node:net";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as TestClock from "effect/testing/TestClock";
import * as Native from "./GrokBotNativeService.ts";
import * as Marketplace from "./GrokBotMarketplaceService.ts";

const listing = (shareId: string, overrides: object = {}) => ({
  slug: `slug-${shareId}`,
  name: `Bot ${shareId}`,
  description: "d",
  category: "Work",
  categories: ["Work"],
  shareId,
  creator: { name: "Ada", profilePhotoUrl: null },
  ...overrides,
});

const fakeNative = (options: {
  readonly marketplace: (
    input: Record<string, unknown>,
    method: string,
    binding: string,
  ) => unknown;
  readonly readMcp?: (input: Record<string, unknown>, method: string, binding: string) => unknown;
  readonly blob?: unknown;
  readonly binding?: () => string;
}) =>
  Layer.succeed(Native.GrokBotNativeService, {
    accountBinding: Effect.sync(options.binding ?? (() => "account-1")),
    marketplaceRequest: (binding: string, request: { method: string; input: object }) =>
      Effect.sync(() =>
        options.marketplace(request.input as Record<string, unknown>, request.method, binding),
      ),
    readMcp: (binding: string, request: { method: string; input: object }) =>
      Effect.sync(() =>
        options.readMcp?.(request.input as Record<string, unknown>, request.method, binding),
      ),
    templateBlob: () => Effect.sync(() => options.blob),
  } as unknown as Native.GrokBotNativeService["Service"]);

const run = <A, E>(
  options: Parameters<typeof fakeNative>[0],
  effect: Effect.Effect<A, E, Marketplace.GrokBotMarketplaceService>,
) => effect.pipe(Effect.provide(Marketplace.layer.pipe(Layer.provide(fakeNative(options)))));

it.effect("walks every page with the page token and dedupes listings across pages", () => {
  const tokens: (string | undefined)[] = [];
  return run(
    {
      marketplace: (input) => {
        tokens.push(input.pageToken as string | undefined);
        assert.strictEqual(input.pageSize, 100);
        if (input.pageToken === undefined)
          return {
            featuredListings: [listing("f1")],
            listings: [listing("a"), listing("b")],
            nextPageToken: "page-2",
            allCategoriesOrder: ["Work", "Fun"],
          };
        return { listings: [listing("b"), listing("c", { category: "Fun", categories: ["Fun"] })] };
      },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const result = yield* service.list({});
      assert.deepStrictEqual(tokens, [undefined, "page-2"]);
      assert.deepStrictEqual(
        result.listings.map((entry) => entry.shareId),
        ["a", "b", "c"],
      );
      assert.deepStrictEqual(
        result.featured.map((entry) => entry.shareId),
        ["f1"],
      );
      assert.deepStrictEqual(result.categories, ["Work", "Fun"]);
    }),
  );
});

it.effect("drops malformed listings and stops if the native API repeats a page token", () => {
  let calls = 0;
  return run(
    {
      marketplace: () => {
        calls += 1;
        return {
          listings: [listing("ok"), { name: "no slug or share id" }],
          nextPageToken: "same",
        };
      },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const result = yield* service.list({});
      assert.deepStrictEqual(
        result.listings.map((entry) => entry.shareId),
        ["ok"],
      );
      assert.strictEqual(calls, 2);
    }),
  );
});

it.effect("previews a recipe blob, skipping malformed entries", () =>
  run(
    {
      marketplace: () => ({
        blobGetUrl: "https://storage.example.com/recipe.json",
        expectedActiveVersion: 4,
        creatorDisplayName: "Ada",
      }),
      blob: {
        profile: { name: "Scout", description: "Watches things" },
        memory: [{ kind: "fact", createdAt: 5, content: "Likes tea" }, { kind: "x" }],
        skills: [{ name: "triage", description: "Sort", content: "Steps" }, { description: "x" }],
        routines: [{ name: "Morning", content: "Check inbox" }],
        plugins: [{ name: "Calendar", pluginId: "cal" }, { name: "no id" }],
      },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const template = yield* service.template({ shareId: "share-1" });
      assert.strictEqual(template.profile.name, "Scout");
      assert.strictEqual(template.creatorDisplayName, "Ada");
      assert.strictEqual(template.expectedActiveVersion, 4);
      assert.deepStrictEqual(template.memories, [
        { kind: "fact", createdAt: "5", content: "Likes tea" },
        { kind: "x", content: "" },
      ]);
      assert.strictEqual(template.skills.length, 1);
      assert.strictEqual(template.routines[0]?.slug, "Morning");
      assert.deepStrictEqual(template.plugins, [{ name: "Calendar", pluginId: "cal" }]);
    }),
  ),
);

it.effect(
  "reports a bounded unavailable error when the native response is not a listing page",
  () =>
    run(
      { marketplace: () => "not a page" },
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        const error = yield* service.list({}).pipe(Effect.flip);
        assert.strictEqual(error.reason, "unavailable");
      }),
    ),
);

it.effect("imports a template with the previewed version and reports the setup flags", () => {
  const requests: Record<string, unknown>[] = [];
  return run(
    {
      marketplace: (input) => {
        requests.push(input);
        return {
          agent: { agentId: "bot-1" },
          setupHandledByServer: false,
          conversationalSetupEnabled: true,
        };
      },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const result = yield* service.importTemplate({
        shareId: "share-1",
        agentId: "bot-1",
        expectedActiveVersion: 4,
      });
      assert.deepStrictEqual(result, {
        agentId: "bot-1",
        setupHandledByServer: false,
        conversationalSetupEnabled: true,
      });
      assert.deepStrictEqual(requests, [
        {
          shareId: "share-1",
          agentId: "bot-1",
          expectedActiveVersion: 4,
          setupDelegationSupported: false,
        },
      ]);
    }),
  );
});

it.effect("reports a bounded import error when the native response has no agent", () =>
  run(
    { marketplace: () => ({}) },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const error = yield* service
        .importTemplate({ shareId: "share-1", agentId: "bot-1", expectedActiveVersion: 1 })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "import_failed");
    }),
  ),
);

it.effect("fails the import when the account changed while it ran", () => {
  let calls = 0;
  return run(
    {
      marketplace: () => ({ agent: { agentId: "bot-1" } }),
      binding: () => (++calls === 1 ? "account-1" : "account-2"),
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const error = yield* service
        .importTemplate({ shareId: "share-1", agentId: "bot-1", expectedActiveVersion: 1 })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "account_changed");
    }),
  );
});

it.effect("drops listings whose ids the contract would reject instead of failing the list", () =>
  run(
    {
      marketplace: () => ({
        listings: [listing("ok"), listing("  "), listing("x".repeat(300))],
      }),
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const result = yield* service.list({});
      assert.deepStrictEqual(
        result.listings.map((entry) => entry.shareId),
        ["ok"],
      );
    }),
  ),
);

it.effect(
  "maps listing and creator images and the default avatar look, ignoring non-http URLs",
  () =>
    run(
      {
        marketplace: () => ({
          listings: [
            listing("img", {
              iconUrl: "https://cdn.example/icon.png",
              creator: { displayName: "Ada", photoUrl: "https://cdn.example/ada.png" },
            }),
            listing("look", {
              imageUrl: "/relative.png",
              defaultAvatar: { shape: "cloud", color: "blue" },
            }),
          ],
        }),
      },
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        const [withImage, withLook] = (yield* service.list({})).listings;
        assert.strictEqual(withImage?.imageUrl, "https://cdn.example/icon.png");
        assert.strictEqual(withImage?.creatorName, "Ada");
        assert.strictEqual(withImage?.creatorPhotoUrl, "https://cdn.example/ada.png");
        assert.strictEqual(withLook?.imageUrl, null);
        assert.strictEqual(withLook?.avatarShape, "cloud");
        assert.strictEqual(withLook?.avatarColor, "blue");
      }),
    ),
);

it.effect("lists catalog plugins across pages, dropping deprecated ones and skill bodies", () => {
  const tokens: (string | undefined)[] = [];
  return run(
    {
      marketplace: (input) => {
        tokens.push(input.pageToken as string | undefined);
        if (input.pageToken === undefined)
          return {
            plugins: [
              {
                id: "7",
                name: "gmail",
                displayName: "Gmail",
                description: "Mail",
                logoUrl: "https://cdn.example/gmail.png",
                curatedCategoryKeys: ["PRODUCTIVITY"],
                publisher: { displayName: "Google", websiteUrl: "https://google.com" },
                skills: [{ name: "triage", description: "Sort mail", content: "BIG BODY" }],
                mcpServers: [{ name: "gmail" }],
                popularityRank: 3,
              },
              { id: "8", name: "old", isDeprecated: true },
            ],
            nextPageToken: "p2",
          };
        return { plugins: [{ id: 9, name: "plain" }] };
      },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const { plugins } = yield* service.plugins({});
      assert.deepStrictEqual(tokens, [undefined, "p2"]);
      assert.deepStrictEqual(
        plugins.map((plugin) => plugin.id),
        ["7", "9"],
      );
      const [gmail, plain] = plugins;
      assert.strictEqual(gmail?.displayName, "Gmail");
      assert.strictEqual(gmail?.publisherName, "Google");
      assert.strictEqual(gmail?.connectorCount, 1);
      assert.deepStrictEqual(gmail?.skills, [{ name: "triage", description: "Sort mail" }]);
      assert.strictEqual(gmail?.popularityRank, 3);
      assert.strictEqual(plain?.displayName, "plain");
      assert.strictEqual(plain?.logoUrl, null);
    }),
  );
});

it.effect(
  "asks for the whole catalog, hides rule-only plugins, and reads install-time variables",
  () => {
    const inputs: Record<string, unknown>[] = [];
    return run(
      {
        marketplace: (input) => {
          inputs.push(input);
          return {
            plugins: [
              {
                id: "1",
                name: "tool",
                mcpServers: [{ name: "tool" }],
                variables: {
                  properties: {
                    API_KEY: { type: "string", title: "API key" },
                    region: { type: "string", enum: ["us", "eu"] },
                  },
                  required: ["API_KEY"],
                },
              },
              { id: "2", name: "rules-only", rules: [{ name: "r" }] },
            ],
          };
        },
      },
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        const { plugins } = yield* service.plugins({});
        assert.deepStrictEqual(inputs, [{ excludeCloudAgentPlugins: true }]);
        assert.deepStrictEqual(
          plugins.map((plugin) => plugin.id),
          ["1"],
        );
        assert.deepStrictEqual(plugins[0]?.variables, [
          { key: "API_KEY", label: "API key", description: "", required: true, secret: true },
        ]);
        // The unsupported `region` is optional, so the plugin stays installable here.
        assert.strictEqual(plugins[0]?.needsAppSetup, false);
      }),
    );
  },
);

it.effect("reads installed plugin ids and sends install and uninstall by int64 string id", () => {
  const sent: { method?: unknown; input: Record<string, unknown> }[] = [];
  return Effect.gen(function* () {
    const native = Layer.succeed(Native.GrokBotNativeService, {
      accountBinding: Effect.succeed("account-1"),
      marketplaceRequest: (_binding: string, request: { method: string; input: object }) =>
        Effect.sync(() => {
          sent.push({ method: request.method, input: request.input as Record<string, unknown> });
          return request.method === "GetEffectiveUserPlugins"
            ? { plugins: [{ plugin: { id: "7" } }, { plugin: { id: 9 } }, {}] }
            : {};
        }),
    } as unknown as Native.GrokBotNativeService["Service"]);
    const service = yield* Marketplace.GrokBotMarketplaceService.pipe(
      Effect.provide(Marketplace.layer.pipe(Layer.provide(native))),
    );
    assert.deepStrictEqual((yield* service.installedPlugins({})).pluginIds, ["7", "9"]);
    assert.deepStrictEqual(sent[0], {
      method: "GetEffectiveUserPlugins",
      input: { excludeConfiguredVariables: true },
    });
    yield* service.installPlugin({ pluginId: "12", variables: { API_KEY: "k" } });
    yield* service.uninstallPlugin({ pluginId: "12" });
    const failure = yield* service.installPlugin({ pluginId: "not-a-number" }).pipe(Effect.flip);
    assert.strictEqual(failure.reason, "plugin_change_failed");
    assert.deepStrictEqual(sent.slice(1), [
      { method: "InstallUserPlugin", input: { pluginId: "12", variables: { API_KEY: "k" } } },
      { method: "UninstallUserPlugin", input: { pluginId: "12" } },
    ]);
  });
});

it.effect("uses the publisher's logo for a plugin without its own", () =>
  run(
    {
      marketplace: () => ({
        plugins: [
          {
            id: "5",
            name: "ctx",
            mcpServers: [{ name: "ctx" }],
            publisher: { displayName: "Upstash", logoUrl: "https://cdn.example/upstash.png" },
          },
        ],
      }),
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const [plugin] = (yield* service.plugins({})).plugins;
      assert.strictEqual(plugin?.logoUrl, "https://cdn.example/upstash.png");
    }),
  ),
);

const oauthServer = { id: 7, name: "Calendar", pluginId: "12", url: "https://mcp.example.com" };
const oauthInput = {
  serverId: 7,
  accountKey: "work",
  redirectUri: "http://localhost:5173/settings/marketplace",
};
const oauthStatus = {
  statuses: [
    { id: 7, requiresAuth: true, authUrl: "https://login.example.com/authorize?state=state-1" },
  ],
};

it.effect("uses native connector status per account instead of stored credential presence", () =>
  run(
    {
      marketplace: () => ({}),
      readMcp: (input, method, binding) => {
        assert.strictEqual(binding, "account-1");
        if (method === "ListSandMcpTools") {
          assert.deepStrictEqual(input, {
            serverIdentifiers: ["supabase", "calendar", "unknown", "loading"],
          });
          return {
            servers: [
              { serverIdentifier: "supabase", status: "needsAuth" },
              {
                serverIdentifier: "calendar-work",
                rowServerIdentifier: "calendar",
                accountLabel: "work",
                status: "connected",
              },
              {
                serverIdentifier: "calendar-personal",
                rowServerIdentifier: "calendar",
                accountLabel: "personal",
                status: "error",
              },
              { serverIdentifier: "loading", status: "loading" },
              { serverIdentifier: "unrelated", status: "connected" },
            ],
          };
        }
        assert.strictEqual(method, "GetAvailableMcpServers");
        assert.deepStrictEqual(input, {});
        return {
          servers: [
            {
              ...oauthServer,
              serverIdentifier: "supabase",
              hasStaticCredentialHeaders: true,
              userHasAccessToken: true,
            },
            {
              ...oauthServer,
              id: 8,
              serverIdentifier: "calendar",
              accounts: [
                { accountKey: "work", userHasAccessToken: false },
                { accountKey: "personal", userHasAccessToken: false },
              ],
            },
            { ...oauthServer, id: 9, serverIdentifier: "unknown", userHasAccessToken: true },
            { ...oauthServer, id: 10, serverIdentifier: "loading" },
            { id: 11, name: "Local", pluginId: 12 },
            { ...oauthServer, id: 99, pluginId: "other" },
          ],
        };
      },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      assert.deepStrictEqual((yield* service.connections({ pluginId: "12" })).servers, [
        {
          id: 7,
          name: "Calendar",
          supportsOAuth: true,
          accounts: [{ accountKey: "default", authenticated: false, status: "needsAuth" }],
        },
        {
          id: 8,
          name: "Calendar",
          supportsOAuth: true,
          accounts: [
            { accountKey: "work", authenticated: true, status: "connected" },
            { accountKey: "personal", authenticated: false, status: "needsAuth" },
          ],
        },
        {
          id: 9,
          name: "Calendar",
          supportsOAuth: true,
          accounts: [{ accountKey: "default", authenticated: false, status: "error" }],
        },
        {
          id: 10,
          name: "Calendar",
          supportsOAuth: true,
          accounts: [{ accountKey: "default", authenticated: false, status: "initializing" }],
        },
        {
          id: 11,
          name: "Local",
          supportsOAuth: false,
          accounts: [{ accountKey: "default", authenticated: false, status: "error" }],
        },
      ]);
    }),
  ),
);

it.effect(
  "keeps missing discovery status unavailable rather than assuming an account is connected",
  () =>
    run(
      {
        marketplace: () => ({}),
        readMcp: (_input, method) =>
          method === "GetAvailableMcpServers"
            ? {
                servers: [
                  {
                    ...oauthServer,
                    serverIdentifier: "calendar",
                    accounts: [],
                    hasStaticCredentialHeaders: true,
                  },
                ],
              }
            : {},
      },
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        const [server] = (yield* service.connections({ pluginId: "12" })).servers;
        assert.deepStrictEqual(server?.accounts, [
          { accountKey: "default", authenticated: false, status: "error" },
        ]);
        assert.strictEqual(server?.supportsOAuth, true);
      }),
    ),
);

it.effect(
  "allows native OAuth for a connector whose stored headers no longer authenticate it",
  () =>
    run(
      {
        readMcp: () => ({ servers: [{ ...oauthServer, hasStaticCredentialHeaders: true }] }),
        marketplace: () => oauthStatus,
      },
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        assert.strictEqual((yield* service.authenticate(oauthInput)).authenticated, false);
      }),
    ),
);

it.effect("does not treat omitted native authentication state as a successful connection", () =>
  run(
    {
      readMcp: () => ({ servers: [oauthServer] }),
      marketplace: () => ({ statuses: [{ id: 7, isAvailable: true }] }),
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const failure = yield* service.authenticate(oauthInput).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "plugin_auth_failed");
    }),
  ),
);

it.effect(
  "sends the selected account and callback URI to native OAuth and consumes completion once",
  () => {
    const requests: { binding: string; method: string; input: Record<string, unknown> }[] = [];
    return run(
      {
        readMcp: () => ({ servers: [oauthServer] }),
        marketplace: (input, method, binding) => {
          requests.push({ binding, method, input });
          return method === "CheckHttpMcpStatus" ? oauthStatus : { accountKey: "work" };
        },
      },
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        assert.deepStrictEqual(yield* service.authenticate(oauthInput), {
          authenticated: false,
          authorizationUrl: "https://login.example.com/authorize?state=state-1",
          stateId: "state-1",
          loopbackPort: null,
        });
        assert.deepStrictEqual(
          yield* service.completeAuth({ stateId: "state-1", code: "code-1" }),
          { accountKey: "work" },
        );
        const replay = yield* service
          .completeAuth({ stateId: "state-1", code: "code-2" })
          .pipe(Effect.flip);
        assert.strictEqual(replay.reason, "plugin_auth_failed");
        assert.deepStrictEqual(requests, [
          {
            binding: "account-1",
            method: "CheckHttpMcpStatus",
            input: {
              serverIds: [7],
              oauthRedirectUri: oauthInput.redirectUri,
              accountKey: "work",
              forceReauth: false,
            },
          },
          {
            binding: "account-1",
            method: "CompleteMcpOAuth",
            input: { stateId: "state-1", authorizationCode: "code-1" },
          },
        ]);
      }),
    );
  },
);

it.effect("rejects unknown states and states created for another native account", () => {
  let binding = "account-1";
  const methods: string[] = [];
  return run(
    {
      binding: () => binding,
      readMcp: () => ({ servers: [oauthServer] }),
      marketplace: (_input, method) => {
        methods.push(method);
        return oauthStatus;
      },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const unknown = yield* service
        .completeAuth({ stateId: "unknown", code: "code" })
        .pipe(Effect.flip);
      assert.strictEqual(unknown.reason, "plugin_auth_failed");
      yield* service.authenticate(oauthInput);
      binding = "account-2";
      const changed = yield* service
        .completeAuth({ stateId: "state-1", code: "code" })
        .pipe(Effect.flip);
      assert.strictEqual(changed.reason, "plugin_auth_failed");
      assert.deepStrictEqual(methods, ["CheckHttpMcpStatus"]);
    }),
  );
});

it.effect("rejects unsafe callback redirects before contacting native APIs", () =>
  run(
    {
      readMcp: () => {
        assert.fail("Unsafe redirects must not read MCP servers");
      },
      marketplace: () => {
        assert.fail("Unsafe redirects must not start OAuth");
      },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      for (const redirectUri of [
        "http://remote.example.com/settings/marketplace",
        "https://example.com/settings/other",
        "https://user:password@example.com/settings/marketplace",
        "javascript:alert(1)",
        "not a URL",
      ]) {
        const error = yield* service.authenticate({ ...oauthInput, redirectUri }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "plugin_auth_failed");
      }
    }),
  ),
);

it.effect(
  "returns authenticated status without an OAuth flow and defaults a completed account",
  () => {
    let authenticated = true;
    return run(
      {
        readMcp: () => ({ servers: [oauthServer] }),
        marketplace: (_input, method) =>
          method === "CompleteMcpOAuth"
            ? {}
            : authenticated
              ? { statuses: [{ id: 7, isAvailable: true, requiresAuth: false }] }
              : oauthStatus,
      },
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        assert.deepStrictEqual(yield* service.authenticate(oauthInput), {
          authenticated: true,
          authorizationUrl: null,
          stateId: null,
          loopbackPort: null,
        });
        authenticated = false;
        yield* service.authenticate(oauthInput);
        assert.deepStrictEqual(yield* service.completeAuth({ stateId: "state-1", code: "code" }), {
          accountKey: "work",
        });
      }),
    );
  },
);

it.effect("consumes the OAuth state before an in-flight native completion can be replayed", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let completions = 0;
    const native = Layer.succeed(Native.GrokBotNativeService, {
      accountBinding: Effect.succeed("account-1"),
      readMcp: () => Effect.succeed({ servers: [oauthServer] }),
      marketplaceRequest: (_binding: string, request: { method: string; input: object }) =>
        request.method === "CheckHttpMcpStatus"
          ? Effect.succeed(oauthStatus)
          : Effect.gen(function* () {
              completions += 1;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return { accountKey: "work" };
            }),
    } as unknown as Native.GrokBotNativeService["Service"]);
    const service = yield* Marketplace.GrokBotMarketplaceService.pipe(
      Effect.provide(Marketplace.layer.pipe(Layer.provide(native))),
    );
    yield* service.authenticate(oauthInput);
    const first = yield* service
      .completeAuth({ stateId: "state-1", code: "code-1" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const replay = yield* service
      .completeAuth({ stateId: "state-1", code: "code-2" })
      .pipe(Effect.flip);
    assert.strictEqual(replay.reason, "plugin_auth_failed");
    assert.strictEqual(completions, 1);
    yield* Deferred.succeed(release, undefined);
    assert.deepStrictEqual(yield* Fiber.join(first), { accountKey: "work" });
  }),
);

it.effect("keeps OAuth state consumed when the native completion fails", () => {
  let completions = 0;
  return run(
    {
      readMcp: () => ({ servers: [oauthServer] }),
      marketplace: (_input, method) => {
        if (method === "CheckHttpMcpStatus") return oauthStatus;
        completions += 1;
        return "invalid completion response";
      },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      yield* service.authenticate(oauthInput);
      const failed = yield* service
        .completeAuth({ stateId: "state-1", code: "code-1" })
        .pipe(Effect.flip);
      assert.strictEqual(failed.reason, "plugin_auth_failed");
      const replay = yield* service
        .completeAuth({ stateId: "state-1", code: "code-2" })
        .pipe(Effect.flip);
      assert.strictEqual(replay.reason, "plugin_auth_failed");
      assert.strictEqual(completions, 1);
    }),
  );
});

it.effect("rejects a completion that native attributes to a different account key", () =>
  run(
    {
      readMcp: () => ({ servers: [oauthServer] }),
      marketplace: (_input, method) =>
        method === "CheckHttpMcpStatus" ? oauthStatus : { accountKey: "personal" },
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      yield* service.authenticate(oauthInput);
      const failure = yield* service
        .completeAuth({ stateId: "state-1", code: "code" })
        .pipe(Effect.flip);
      assert.strictEqual(failure.reason, "plugin_auth_failed");
    }),
  ),
);

const relayAuthUrl = (state: string) =>
  `https://login.example.com/authorize?redirect_uri=${encodeURIComponent(
    "https://www.cursor.com/agents/mcp/oauth/callback",
  )}&state=${state}`;

const relayOptions = (state: string, completions: unknown[] = []) => ({
  marketplace: (input: Record<string, unknown>, method: string) => {
    if (method === "CheckHttpMcpStatus")
      return { statuses: [{ id: 7, requiresAuth: true, authUrl: relayAuthUrl(state) }] };
    completions.push(input);
    return { accountKey: "work" };
  },
  readMcp: () => ({ servers: [oauthServer] }),
});

const loopbackRun = <A, E>(
  options: Parameters<typeof fakeNative>[0],
  effect: Effect.Effect<A, E, Marketplace.GrokBotMarketplaceService>,
  ports: readonly number[] = [0],
) =>
  effect.pipe(
    Effect.provide(Marketplace.layerWithPorts(ports).pipe(Layer.provide(fakeNative(options)))),
  );

/** A real HTTP request to the receiver. 0 means nothing is listening. */
const callback = (host: string, port: number, query: string) =>
  HttpClient.get(`http://${host}:${port}/callback?${query}`).pipe(
    Effect.map((response) => response.status),
    Effect.orElseSucceed(() => 0),
    Effect.provide(FetchHttpClient.layer),
  );

const occupy = (port: number, host: string) =>
  Effect.promise(
    () =>
      new Promise<{ readonly port: number; readonly close: () => Promise<void> } | null>(
        (resolve) => {
          const server = NodeNet.createServer();
          server.once("error", () => resolve(null));
          server.listen(port, host, () =>
            resolve({
              port: (server.address() as NodeNet.AddressInfo).port,
              close: () => new Promise<void>((done) => server.close(() => done())),
            }),
          );
        },
      ),
  );

it.effect(
  "completes a relayed sign-in through the loopback listener, once, with its own account",
  () => {
    const completions: unknown[] = [];
    return loopbackRun(
      relayOptions("s1.tgd", completions),
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        const started = yield* service.authenticate(oauthInput);
        const port = started.loopbackPort;
        assert.ok(port !== null);
        assert.strictEqual(
          new URL(started.authorizationUrl!).searchParams.get("state"),
          `s1.tgd${port}`,
        );
        assert.strictEqual(started.stateId, "s1.tgd");
        assert.strictEqual(yield* callback("127.0.0.1", port, `state=s1.tgd${port}&code=x`), 200);
        assert.deepStrictEqual(completions, [{ stateId: "s1.tgd", authorizationCode: "x" }]);
        // The idle listener has closed, so a replay never reaches the exchange.
        assert.strictEqual(yield* callback("127.0.0.1", port, `state=s1.tgd${port}&code=x`), 0);
        assert.strictEqual(completions.length, 1);
      }),
    );
  },
);

it.effect("rejects unknown state and provider errors without exchanging a code", () => {
  const completions: unknown[] = [];
  return loopbackRun(
    relayOptions("s2.tgd", completions),
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const port = (yield* service.authenticate(oauthInput)).loopbackPort!;
      assert.strictEqual(yield* callback("127.0.0.1", port, "state=other.tgd&code=x"), 400);
      assert.strictEqual(
        yield* callback("127.0.0.1", port, `state=s2.tgd${port}&error=access_denied`),
        400,
      );
      // The refused flow is gone, so the listener closed and a late code finds nothing.
      assert.strictEqual(yield* callback("127.0.0.1", port, `state=s2.tgd${port}&code=x`), 0);
      assert.deepStrictEqual(completions, []);
    }),
  );
});

it.effect("does not bind a loopback listener for a remote browser origin", () =>
  loopbackRun(
    relayOptions("s3.tgd"),
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const started = yield* service.authenticate({
        ...oauthInput,
        redirectUri: "https://t3.example.com/settings/marketplace",
      });
      assert.strictEqual(started.loopbackPort, null);
      assert.strictEqual(started.stateId, "s3.tgd");
    }),
  ),
);

it.effect("concurrent sign-ins share one listener", () => {
  let issued = 0;
  return loopbackRun(
    {
      marketplace: (_input, method) =>
        method === "CheckHttpMcpStatus"
          ? {
              statuses: [{ id: 7, requiresAuth: true, authUrl: relayAuthUrl(`c${++issued}.tgd`) }],
            }
          : { accountKey: "work" },
      readMcp: () => ({ servers: [oauthServer] }),
    },
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const started = yield* Effect.all(
        Array.from({ length: 5 }, () => service.authenticate(oauthInput)),
        { concurrency: "unbounded" },
      );
      const ports = new Set(started.map((s) => s.loopbackPort));
      assert.strictEqual(ports.size, 1);
      const [port] = [...ports];
      assert.ok(port !== null && port !== undefined);
      // Finishing one flow leaves the listener up for the others.
      const first = started[0]!;
      assert.strictEqual(
        yield* callback("127.0.0.1", port, `state=${first.stateId}${port}&code=x`),
        200,
      );
      assert.strictEqual(
        yield* callback("127.0.0.1", port, `state=${started[1]!.stateId}${port}&code=x`),
        200,
      );
    }),
  );
});

it.effect("skips a busy port and retries once the ports free up", () =>
  Effect.gen(function* () {
    const busy = yield* occupy(0, "127.0.0.1");
    assert.ok(busy);
    yield* loopbackRun(
      relayOptions("s4.tgd"),
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        const blocked = yield* service.authenticate(oauthInput);
        // Nothing to bind: the sign-in still starts, without a receiver.
        assert.strictEqual(blocked.loopbackPort, null);
        assert.strictEqual(blocked.authorizationUrl, relayAuthUrl("s4.tgd"));
        yield* Effect.promise(busy.close);
        const retried = yield* service.authenticate(oauthInput);
        assert.strictEqual(retried.loopbackPort, busy.port);
      }),
      [busy.port],
    );
  }),
);

it.effect("skips a port another process owns on ::1", () =>
  Effect.gen(function* () {
    const v6 = yield* occupy(0, "::1");
    // Hosts without IPv6 have no such conflict to prove.
    if (!v6) return;
    yield* loopbackRun(
      relayOptions("s5.tgd"),
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        const started = yield* service.authenticate(oauthInput);
        assert.ok(started.loopbackPort !== null);
        assert.notStrictEqual(started.loopbackPort, v6.port);
        // The IPv4 side of the skipped port was released, not kept.
        const v4 = yield* occupy(v6.port, "127.0.0.1");
        assert.ok(v4);
        yield* Effect.promise(v4.close);
      }),
      [v6.port, 0],
    ).pipe(Effect.ensuring(Effect.promise(v6.close)));
  }),
);

it.effect("serves ::1 as well when the host has it", () =>
  Effect.gen(function* () {
    const probe = yield* occupy(0, "::1");
    if (!probe) return;
    yield* Effect.promise(probe.close);
    yield* loopbackRun(
      relayOptions("s6.tgd"),
      Effect.gen(function* () {
        const service = yield* Marketplace.GrokBotMarketplaceService;
        const port = (yield* service.authenticate(oauthInput)).loopbackPort!;
        assert.strictEqual(yield* callback("[::1]", port, "state=nope.tgd&code=x"), 400);
      }),
    );
  }),
);

it.effect("closes the listener of an abandoned sign-in when the flow expires", () => {
  const completions: unknown[] = [];
  return loopbackRun(
    relayOptions("s7.tgd", completions),
    Effect.gen(function* () {
      const service = yield* Marketplace.GrokBotMarketplaceService;
      const port = (yield* service.authenticate(oauthInput)).loopbackPort!;
      yield* TestClock.adjust(Duration.minutes(16));
      assert.strictEqual(yield* callback("127.0.0.1", port, `state=s7.tgd${port}&code=x`), 0);
      const late = yield* service.completeAuth({ stateId: "s7.tgd", code: "x" }).pipe(Effect.flip);
      assert.strictEqual(late.reason, "plugin_auth_failed");
      assert.deepStrictEqual(completions, []);
    }),
  );
});

it.effect("closes the listener when the layer shuts down", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      Marketplace.layerWithPorts([0]).pipe(Layer.provide(fakeNative(relayOptions("s8.tgd")))),
      scope,
    );
    const service = Context.get(context, Marketplace.GrokBotMarketplaceService);
    const port = (yield* service.authenticate(oauthInput)).loopbackPort!;
    assert.strictEqual(yield* callback("127.0.0.1", port, "state=nope.tgd&code=x"), 400);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(yield* callback("127.0.0.1", port, "state=nope.tgd&code=x"), 0);
  }),
);
