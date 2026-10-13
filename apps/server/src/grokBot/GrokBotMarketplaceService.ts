import {
  GrokBotPluginConnectionsInput,
  GrokBotPluginConnectionsResult,
  GrokBotPluginAuthenticateInput,
  GrokBotPluginAuthenticateResult,
  GrokBotPluginCompleteAuthInput,
  GrokBotPluginCompleteAuthResult,
  GrokBotMarketplaceError,
  GrokBotMarketplaceListing,
  type GrokBotMarketplaceImportInput,
  type GrokBotMarketplaceImportResult,
  type GrokBotMarketplaceListingsInput,
  type GrokBotMarketplaceListingsResult,
  type GrokBotMarketplaceInstalledPluginsInput,
  type GrokBotMarketplaceInstalledPluginsResult,
  type GrokBotMarketplacePlugin,
  type GrokBotMarketplacePluginChangeResult,
  type GrokBotMarketplacePluginInstallInput,
  type GrokBotMarketplacePluginUninstallInput,
  type GrokBotMarketplacePluginsInput,
  type GrokBotMarketplacePluginsResult,
  type GrokBotMarketplaceTemplate,
  type GrokBotMarketplaceTemplateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as Semaphore from "effect/Semaphore";
import {
  baseStateId,
  isLoopbackHostname,
  LOOPBACK_PORTS,
  retargetAuthorizationUrl,
  startLoopbackListener,
  usesLoopbackRelay,
  type LoopbackCallback,
  type LoopbackListener,
} from "./GrokBotOAuthLoopback.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Native from "./GrokBotNativeService.ts";

type Listing = (typeof GrokBotMarketplaceListingsResult.Type)["listings"][number];
type Template = typeof GrokBotMarketplaceTemplate.Type;
type Plugin = typeof GrokBotMarketplacePlugin.Type;

const PAGE_SIZE = 100;
// Bounds the walk if the native API keeps returning tokens. 50 pages covers far more than the marketplace holds.
const MAX_PAGES = 50;
const PLUGIN_MAX_PAGES = 50;

// Native payloads are decoded per entry, so one malformed listing or recipe item never hides the rest.
const OptionalString = Schema.optionalKey(Schema.String);
const OptionalUrl = Schema.optionalKey(Schema.NullOr(Schema.String));
// The public API's image field names are not documented, so the usual spellings are all accepted.
const NativeListing = Schema.Struct({
  slug: GrokBotMarketplaceListing.fields.slug,
  name: OptionalString,
  description: OptionalString,
  imageUrl: OptionalUrl,
  iconUrl: OptionalUrl,
  avatarUrl: OptionalUrl,
  thumbnailUrl: OptionalUrl,
  avatarShape: OptionalString,
  avatarColor: OptionalString,
  defaultAvatar: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        shape: OptionalString,
        color: OptionalString,
        avatarShape: OptionalString,
        avatarColor: OptionalString,
      }),
    ),
  ),
  category: OptionalString,
  categories: Schema.optionalKey(Schema.Array(Schema.String)),
  shareId: GrokBotMarketplaceListing.fields.shareId,
  creator: Schema.optionalKey(
    Schema.Struct({
      name: OptionalString,
      displayName: OptionalString,
      profilePhotoUrl: OptionalUrl,
      photoUrl: OptionalUrl,
      avatarUrl: OptionalUrl,
    }),
  ),
});
const NativeListingsPage = Schema.Struct({
  featuredListings: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  listings: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  nextPageToken: Schema.optionalKey(Schema.NullOr(Schema.String)),
  allCategoriesOrder: Schema.optionalKey(Schema.Array(Schema.String)),
});
const NativeDescriptor = Schema.Struct({ name: OptionalString, description: OptionalString });
const NativeCatalogPlugin = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  name: OptionalString,
  displayName: OptionalString,
  description: OptionalString,
  logoUrl: OptionalUrl,
  primaryColor: OptionalUrl,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  curatedCategoryKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  repositoryUrl: OptionalUrl,
  publisher: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        name: OptionalString,
        displayName: OptionalString,
        logoUrl: OptionalUrl,
        websiteUrl: OptionalUrl,
      }),
    ),
  ),
  skills: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  mcpServers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  commands: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  subagents: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  hooks: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  rules: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  /** A JSON schema (`properties`, `required`) for the values asked for at install time. */
  variables: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  popularityRank: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  isDeprecated: Schema.optionalKey(Schema.Boolean),
});
const NativeEffectivePlugins = Schema.Struct({
  plugins: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        plugin: Schema.optionalKey(
          Schema.Struct({ id: Schema.Union([Schema.String, Schema.Number]) }),
        ),
      }),
    ),
  ),
});
const NativePluginsPage = Schema.Struct({
  plugins: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  nextPageToken: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const NativeServers = Schema.Struct({
  servers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.Int,
        name: Schema.String,
        pluginId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
        type: OptionalString,
        url: OptionalString,
        serverIdentifier: OptionalString,
        hasStaticCredentialHeaders: Schema.optionalKey(Schema.Boolean),
        userHasAccessToken: Schema.optionalKey(Schema.Boolean),
        accounts: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              accountKey: Schema.String,
              userHasAccessToken: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        ),
      }),
    ),
  ),
});
const NativeAuthStatus = Schema.Struct({
  statuses: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.Int,
        isAvailable: Schema.optionalKey(Schema.Boolean),
        requiresAuth: Schema.optionalKey(Schema.Boolean),
        hasValidToken: Schema.optionalKey(Schema.Boolean),
        authUrl: OptionalString,
      }),
    ),
  ),
});
const NativeConnectorStatuses = Schema.Struct({
  servers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        serverIdentifier: Schema.String,
        rowServerIdentifier: OptionalString,
        accountLabel: OptionalString,
        status: OptionalString,
      }),
    ),
  ),
});
const NativeAuthComplete = Schema.Struct({ accountKey: OptionalString });
const NativeTemplateDetails = Schema.Struct({
  blobGetUrl: Schema.String,
  expectedActiveVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  creatorDisplayName: OptionalString,
});
const NativeImportResponse = Schema.Struct({
  agent: Schema.Struct({ agentId: Schema.String }),
  setupHandledByServer: Schema.optionalKey(Schema.Boolean),
  conversationalSetupEnabled: Schema.optionalKey(Schema.Boolean),
});
const NativeRecipe = Schema.Struct({
  profile: Schema.Struct({
    name: Schema.String,
    description: OptionalString,
    avatarShape: OptionalString,
    avatarColor: OptionalString,
  }),
  memory: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  skills: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  routines: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  plugins: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const NativeMemory = Schema.Struct({
  kind: OptionalString,
  createdAt: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  content: OptionalString,
});
const NativeSkill = Schema.Struct({
  name: Schema.String,
  description: OptionalString,
  content: OptionalString,
});
const NativeRoutine = Schema.Struct({
  name: Schema.String,
  slug: OptionalString,
  description: OptionalString,
  content: OptionalString,
});
const NativePlugin = Schema.Struct({
  name: Schema.String,
  description: OptionalString,
  pluginId: Schema.String,
});

const decodeEntries = <A>(
  decode: (input: unknown) => Option.Option<A>,
  entries: readonly unknown[] | undefined,
): readonly A[] => (entries ?? []).flatMap((entry) => Option.toArray(decode(entry)));

/** Only absolute http(s) URLs can render in an `<img>`; anything else falls back to a drawn avatar. */
const imageUrlOf = (...candidates: readonly (string | null | undefined)[]): string | null =>
  candidates.find(
    (value) => value !== undefined && value !== null && /^https?:\/\//i.test(value),
  ) ?? null;

const NativeVariableSchema = Schema.Struct({
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
});
const NativeVariable = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  format: Schema.optionalKey(Schema.NullOr(Schema.String)),
  writeOnly: Schema.optionalKey(Schema.Boolean),
  enum: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const SIMPLE_VARIABLE_TYPES = new Set(["string", "number", "integer", "boolean"]);
const SECRET_NAME_PARTS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL"];

/** Install-time values T3 can collect: plain text, number, or yes/no. Anything else sends the user to the app. */
const toVariables = (raw: unknown): Pick<Plugin, "variables" | "needsAppSetup"> => {
  const schema = Option.getOrUndefined(Schema.decodeUnknownOption(NativeVariableSchema)(raw));
  const required = new Set(schema?.required ?? []);
  const variables: Plugin["variables"][number][] = [];
  let needsAppSetup = false;
  for (const [key, value] of Object.entries(schema?.properties ?? {})) {
    const field = Option.getOrUndefined(Schema.decodeUnknownOption(NativeVariable)(value));
    if (field === undefined || !SIMPLE_VARIABLE_TYPES.has(field.type ?? "") || field.enum) {
      // An optional value T3 cannot collect is skipped; only a required one sends the user to the app.
      if (required.has(key)) needsAppSetup = true;
      continue;
    }
    variables.push({
      key,
      label: field.title || key.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()),
      description: field.description || "",
      required: required.has(key),
      secret:
        field.format === "password" ||
        field.writeOnly === true ||
        key
          .replace(/([a-z\d])([A-Z])/g, "$1_$2")
          .toUpperCase()
          .split(/[^A-Z\d]+/)
          .some((part) => SECRET_NAME_PARTS.includes(part)),
    });
  }
  return { variables, needsAppSetup };
};

/** Plugins made only of rules or hooks have nothing to connect, so the app's catalog hides them too. */
const isInstallable = (entry: typeof NativeCatalogPlugin.Type): boolean => {
  const connectors = (entry.mcpServers?.length ?? 0) + (entry.skills?.length ?? 0);
  const other =
    (entry.rules?.length ?? 0) +
    (entry.hooks?.length ?? 0) +
    (entry.commands?.length ?? 0) +
    (entry.subagents?.length ?? 0);
  return connectors > 0 || other === 0;
};

const toPlugin = (entry: typeof NativeCatalogPlugin.Type): Plugin => ({
  id: String(entry.id),
  name: entry.name ?? "",
  displayName: entry.displayName || entry.name || "",
  description: entry.description ?? "",
  // The publisher's logo is the one the catalog fills in; the plugin's own is rarely set.
  logoUrl: imageUrlOf(entry.publisher?.logoUrl, entry.logoUrl),
  primaryColor: entry.primaryColor || null,
  tags: entry.tags ?? [],
  categoryKeys: entry.curatedCategoryKeys ?? [],
  publisherName: entry.publisher?.displayName || entry.publisher?.name || "",
  websiteUrl: imageUrlOf(entry.publisher?.websiteUrl),
  repositoryUrl: imageUrlOf(entry.repositoryUrl),
  connectorCount: entry.mcpServers?.length ?? 0,
  commandCount: entry.commands?.length ?? 0,
  // Skill bodies are large and never shown in the catalog, so only names and descriptions are kept.
  skills: decodeEntries(Schema.decodeUnknownOption(NativeDescriptor), entry.skills).map(
    (skill) => ({ name: skill.name ?? "", description: skill.description ?? "" }),
  ),
  ...toVariables(entry.variables),
  popularityRank:
    entry.popularityRank === null ||
    entry.popularityRank === undefined ||
    !Number.isSafeInteger(entry.popularityRank)
      ? null
      : entry.popularityRank,
});

const toListing = (
  entry: typeof NativeListing.Type,
  categoriesOrder: readonly string[],
): Listing => {
  const category = entry.category ?? "";
  const look = entry.defaultAvatar;
  const avatarShape = entry.avatarShape ?? look?.shape ?? look?.avatarShape;
  const avatarColor = entry.avatarColor ?? look?.color ?? look?.avatarColor;
  return {
    slug: entry.slug,
    name: entry.name ?? "",
    description: entry.description ?? "",
    imageUrl: imageUrlOf(entry.imageUrl, entry.iconUrl, entry.avatarUrl, entry.thumbnailUrl),
    category: category || (categoriesOrder[0] ?? ""),
    categories: entry.categories ?? (category ? [category] : []),
    shareId: entry.shareId,
    creatorName: entry.creator?.name ?? entry.creator?.displayName ?? "",
    creatorPhotoUrl: imageUrlOf(
      entry.creator?.profilePhotoUrl,
      entry.creator?.photoUrl,
      entry.creator?.avatarUrl,
    ),
    ...(avatarShape ? { avatarShape } : {}),
    ...(avatarColor ? { avatarColor } : {}),
  };
};

export class GrokBotMarketplaceService extends Context.Service<
  GrokBotMarketplaceService,
  {
    readonly list: (
      input: typeof GrokBotMarketplaceListingsInput.Type,
    ) => Effect.Effect<typeof GrokBotMarketplaceListingsResult.Type, GrokBotMarketplaceError>;
    readonly plugins: (
      input: typeof GrokBotMarketplacePluginsInput.Type,
    ) => Effect.Effect<typeof GrokBotMarketplacePluginsResult.Type, GrokBotMarketplaceError>;
    readonly installedPlugins: (
      input: typeof GrokBotMarketplaceInstalledPluginsInput.Type,
    ) => Effect.Effect<
      typeof GrokBotMarketplaceInstalledPluginsResult.Type,
      GrokBotMarketplaceError
    >;
    readonly installPlugin: (
      input: typeof GrokBotMarketplacePluginInstallInput.Type,
    ) => Effect.Effect<typeof GrokBotMarketplacePluginChangeResult.Type, GrokBotMarketplaceError>;
    readonly uninstallPlugin: (
      input: typeof GrokBotMarketplacePluginUninstallInput.Type,
    ) => Effect.Effect<typeof GrokBotMarketplacePluginChangeResult.Type, GrokBotMarketplaceError>;
    readonly connections: (
      input: typeof GrokBotPluginConnectionsInput.Type,
    ) => Effect.Effect<typeof GrokBotPluginConnectionsResult.Type, GrokBotMarketplaceError>;
    readonly authenticate: (
      input: typeof GrokBotPluginAuthenticateInput.Type,
    ) => Effect.Effect<typeof GrokBotPluginAuthenticateResult.Type, GrokBotMarketplaceError>;
    readonly completeAuth: (
      input: typeof GrokBotPluginCompleteAuthInput.Type,
    ) => Effect.Effect<typeof GrokBotPluginCompleteAuthResult.Type, GrokBotMarketplaceError>;
    readonly template: (
      input: typeof GrokBotMarketplaceTemplateInput.Type,
    ) => Effect.Effect<Template, GrokBotMarketplaceError>;
    readonly importTemplate: (
      input: typeof GrokBotMarketplaceImportInput.Type,
    ) => Effect.Effect<typeof GrokBotMarketplaceImportResult.Type, GrokBotMarketplaceError>;
  }
>()("t3/grokBot/GrokBotMarketplaceService") {}

const make = (ports: readonly number[]) =>
  Effect.gen(function* () {
    const native = yield* Native.GrokBotNativeService;
    const account = native.accountBinding.pipe(
      Effect.mapError(() => new GrokBotMarketplaceError({ reason: "provider_not_ready" })),
    );
    const unavailable = () => new GrokBotMarketplaceError({ reason: "unavailable" });
    const sameAccount = (binding: string) =>
      account.pipe(
        Effect.flatMap((current) =>
          current === binding
            ? Effect.void
            : Effect.fail(new GrokBotMarketplaceError({ reason: "account_changed" })),
        ),
      );

    // A flow is bound to the account, connector, and account key that started it, so a callback
    // that lands on another account or returns a different key cannot attach the credential there.
    const pendingAuth = new Map<
      string,
      {
        binding: string;
        serverId: number;
        accountKey: string;
        expiresAt: number;
        expiry: Fiber.Fiber<void>;
      }
    >();
    // The relayed sign-in lands on a loopback listener of this server. It exists only while a flow
    // that started from a loopback origin (browser and server on one machine) is pending. Flows and
    // the listener change together under one lock so concurrent sign-ins share one listener and an
    // idle close cannot race a flow that is being registered.
    const lock = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    let listener: LoopbackListener | undefined;
    const dropFlow = (stateId: string) => {
      const flow = pendingAuth.get(stateId);
      if (flow) {
        pendingAuth.delete(stateId);
        // Non-blocking, so it is safe while holding the lock the expiry fiber may be waiting on.
        flow.expiry.interruptUnsafe();
      }
      return flow;
    };
    // Called with the lock held. Never awaits the socket close, so a request handler can call it.
    const releaseIfIdle = () => {
      if (pendingAuth.size > 0 || !listener) return;
      const closing = listener;
      listener = undefined;
      closing.release();
    };
    const FLOW_TTL = Duration.minutes(15);
    // An abandoned sign-in expires on its own, so its listener never outlives the flow.
    const expireFlow = (stateId: string) =>
      Effect.sleep(FLOW_TTL).pipe(
        Effect.andThen(
          lock.withPermits(1)(
            Effect.sync(() => {
              // This fiber is the expiry itself, so it is deleted without interrupting it.
              pendingAuth.delete(stateId);
              releaseIfIdle();
            }),
          ),
        ),
      );
    const authFailed = () => new GrokBotMarketplaceError({ reason: "plugin_auth_failed" });
    const readServers = (binding: string) =>
      native
        .readMcp(binding, { method: "GetAvailableMcpServers", input: {} })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(NativeServers)),
          Effect.mapError(unavailable),
        );
    const connections = Effect.fn("GrokBotMarketplaceService.connections")(function* (
      input: typeof GrokBotPluginConnectionsInput.Type,
    ) {
      const binding = yield* account;
      const result = yield* readServers(binding);
      const servers = (result.servers ?? []).filter((s) =>
        input.serverId === undefined
          ? String(s.pluginId) === input.pluginId
          : s.id === input.serverId,
      );
      const identifiers = servers.flatMap((s) =>
        s.url && s.serverIdentifier ? [s.serverIdentifier] : [],
      );
      const statuses = identifiers.length
        ? yield* native
            .readMcp(binding, {
              method: "ListSandMcpTools",
              input: { serverIdentifiers: identifiers },
            })
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(NativeConnectorStatuses)),
              Effect.map((response) => response.servers ?? []),
              Effect.orElseSucceed(() => []),
            )
        : [];
      yield* sameAccount(binding);
      return {
        servers: servers.map((s) => ({
          id: s.id,
          name: s.name,
          supportsOAuth: Boolean(s.url),
          accounts: (s.accounts?.length
            ? s.accounts
            : [{ accountKey: "default", userHasAccessToken: s.userHasAccessToken }]
          ).map((a) => {
            const accountKey = a.accountKey || "default";
            const reported = statuses.find(
              (status) =>
                (status.rowServerIdentifier || status.serverIdentifier) === s.serverIdentifier &&
                (status.accountLabel || "default") === accountKey,
            )?.status;
            // Native account listings use discovery status; stored headers or tokens can be stale.
            const status: (typeof GrokBotPluginConnectionsResult.Type.servers)[number]["accounts"][number]["status"] =
              reported === "connected"
                ? "connected"
                : reported === "needsAuth" || a.userHasAccessToken === false
                  ? "needsAuth"
                  : reported === "loading"
                    ? "initializing"
                    : "error";
            return { accountKey, authenticated: status === "connected", status };
          }),
        })),
      };
    });
    const authenticate = Effect.fn("GrokBotMarketplaceService.authenticate")(function* (
      input: typeof GrokBotPluginAuthenticateInput.Type,
    ) {
      const binding = yield* account;
      const redirect = yield* Effect.try({
        try: () => new URL(input.redirectUri),
        catch: authFailed,
      });
      if (
        redirect.username ||
        redirect.password ||
        redirect.pathname !== "/settings/marketplace" ||
        (redirect.protocol !== "https:" &&
          !(
            redirect.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)
          ))
      )
        return yield* authFailed();
      const servers = yield* readServers(binding);
      if (!(servers.servers ?? []).some((s) => s.id === input.serverId && s.url))
        return yield* authFailed();
      const status = yield* native
        .marketplaceRequest(binding, {
          method: "CheckHttpMcpStatus",
          input: {
            serverIds: [input.serverId],
            oauthRedirectUri: redirect.href,
            accountKey: input.accountKey,
            forceReauth: false,
          },
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(NativeAuthStatus)),
          Effect.mapError(authFailed),
        );
      yield* sameAccount(binding);
      const server = status.statuses?.find((s) => s.id === input.serverId);
      if (server?.isAvailable === true && server.requiresAuth === false)
        return { authenticated: true, authorizationUrl: null, stateId: null, loopbackPort: null };
      if (!server?.requiresAuth || !server.authUrl) return yield* authFailed();
      const url = yield* Effect.try({ try: () => new URL(server.authUrl!), catch: authFailed });
      const stateId = url.searchParams.get("state");
      if (url.protocol !== "https:" || url.username || url.password || !stateId)
        return yield* authFailed();
      const relayed = usesLoopbackRelay(url) && isLoopbackHostname(redirect.hostname);
      // The flow is registered before the listener can hand out a port, so no callback can arrive
      // ahead of it. A listener that could not bind is not remembered; the next sign-in retries.
      const started = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          for (const [key, flow] of pendingAuth) if (flow.expiresAt <= now) dropFlow(key);
          if (pendingAuth.size >= 100) return yield* authFailed();
          dropFlow(stateId);
          const expiry = yield* Effect.forkIn(expireFlow(stateId), scope);
          pendingAuth.set(stateId, {
            binding,
            serverId: input.serverId,
            accountKey: input.accountKey,
            expiresAt: now + Duration.toMillis(FLOW_TTL),
            expiry,
          });
          if (!relayed) return { url, loopbackPort: null };
          listener ??=
            (yield* Effect.uninterruptible(
              Effect.promise(() => startLoopbackListener({ ports, handle: handleLoopback })),
            )) ?? undefined;
          const retargeted = listener ? retargetAuthorizationUrl(url, listener.port) : null;
          return retargeted && listener
            ? { url: retargeted, loopbackPort: listener.port }
            : { url, loopbackPort: null };
        }),
      );
      return {
        authenticated: false,
        authorizationUrl: started.url.href,
        stateId,
        loopbackPort: started.loopbackPort,
      };
    });
    const completeAuth = Effect.fn("GrokBotMarketplaceService.completeAuth")(function* (
      input: typeof GrokBotPluginCompleteAuthInput.Type,
    ) {
      const binding = yield* account;
      const stateId = baseStateId(input.stateId);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      // Single use: a replayed or concurrent callback finds no flow.
      const flow = yield* lock.withPermits(1)(
        Effect.sync(() => {
          const found = pendingAuth.get(stateId);
          if (!found || found.binding !== binding || found.expiresAt <= now) return undefined;
          dropFlow(stateId);
          releaseIfIdle();
          return found;
        }),
      );
      if (!flow) return yield* authFailed();
      const result = yield* native
        .marketplaceRequest(binding, {
          method: "CompleteMcpOAuth",
          input: { stateId, authorizationCode: input.code },
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(NativeAuthComplete)),
          Effect.mapError(authFailed),
        );
      yield* sameAccount(binding);
      if (result.accountKey && result.accountKey !== flow.accountKey) return yield* authFailed();
      return { accountKey: flow.accountKey };
    });
    // Runs outside any request fiber, so it carries its own copy of the service context.
    const services = yield* Effect.context<never>();
    const handleLoopback = (callback: LoopbackCallback) =>
      Effect.runPromiseWith(services)(
        Effect.gen(function* () {
          if (!callback.state) return false;
          if (callback.error || !callback.code) {
            // The provider refused: the flow is over and nothing is exchanged.
            const state = baseStateId(callback.state);
            yield* lock.withPermits(1)(
              Effect.sync(() => {
                dropFlow(state);
                releaseIfIdle();
              }),
            );
            return false;
          }
          return yield* completeAuth({ stateId: callback.state, code: callback.code }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        }),
      );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const flow of pendingAuth.values()) flow.expiry.interruptUnsafe();
        pendingAuth.clear();
        const closing = listener;
        listener = undefined;
        await closing?.close();
      }),
    );

    const list = Effect.fn("GrokBotMarketplaceService.list")(function* (
      _input: typeof GrokBotMarketplaceListingsInput.Type,
    ) {
      const binding = yield* account;
      const featured = new Map<string, Listing>();
      const listings = new Map<string, Listing>();
      let categoriesOrder: readonly string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const value = yield* native
          .marketplaceRequest(binding, {
            method: "ListPublicGrokBotMarketplaceListings",
            input: { pageSize: PAGE_SIZE, ...(pageToken === undefined ? {} : { pageToken }) },
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(NativeListingsPage)),
            Effect.mapError(unavailable),
          );
        if (page === 0) {
          categoriesOrder = value.allCategoriesOrder ?? [];
          for (const entry of decodeEntries(
            Schema.decodeUnknownOption(NativeListing),
            value.featuredListings,
          )) {
            featured.set(entry.shareId, toListing(entry, categoriesOrder));
          }
        }
        for (const entry of decodeEntries(
          Schema.decodeUnknownOption(NativeListing),
          value.listings,
        )) {
          listings.set(entry.shareId, toListing(entry, categoriesOrder));
        }
        const next = value.nextPageToken ?? undefined;
        if (next === undefined || next === "" || next === pageToken) break;
        pageToken = next;
      }
      yield* sameAccount(binding);
      const categories = [
        ...new Set(
          categoriesOrder.length > 0
            ? categoriesOrder
            : [...listings.values()].flatMap((listing) => listing.categories),
        ),
      ];
      return {
        featured: [...featured.values()],
        listings: [...listings.values()],
        categories,
      };
    });

    // Plugin pages carry skill bodies, so they are kept small. A catalog bigger than the cap is truncated.
    const plugins = Effect.fn("GrokBotMarketplaceService.plugins")(function* (
      _input: typeof GrokBotMarketplacePluginsInput.Type,
    ) {
      const binding = yield* account;
      const catalog = new Map<string, Plugin>();
      let pageToken: string | undefined;
      for (let page = 0; page < PLUGIN_MAX_PAGES; page++) {
        const value = yield* native
          .marketplaceRequest(binding, {
            method: "ListMarketplacePlugins",
            input: {
              excludeCloudAgentPlugins: true,
              ...(pageToken === undefined ? {} : { pageToken }),
            },
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(NativePluginsPage)),
            Effect.mapError(unavailable),
          );
        for (const entry of decodeEntries(
          Schema.decodeUnknownOption(NativeCatalogPlugin),
          value.plugins,
        )) {
          if (entry.isDeprecated === true || !isInstallable(entry)) continue;
          const plugin = toPlugin(entry);
          catalog.set(plugin.id, plugin);
        }
        const next = value.nextPageToken ?? undefined;
        if (next === undefined || next === "" || next === pageToken) break;
        pageToken = next;
      }
      yield* sameAccount(binding);
      return { plugins: [...catalog.values()] };
    });

    const installedPlugins = Effect.fn("GrokBotMarketplaceService.installedPlugins")(function* (
      _input: typeof GrokBotMarketplaceInstalledPluginsInput.Type,
    ) {
      const binding = yield* account;
      const value = yield* native
        .marketplaceRequest(binding, {
          method: "GetEffectiveUserPlugins",
          input: { excludeConfiguredVariables: true },
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(NativeEffectivePlugins)),
          Effect.mapError(unavailable),
        );
      yield* sameAccount(binding);
      return {
        pluginIds: (value.plugins ?? []).flatMap((entry) =>
          entry.plugin === undefined ? [] : [String(entry.plugin.id)],
        ),
      };
    });

    const changePlugin = (
      method: "InstallUserPlugin" | "UninstallUserPlugin",
      input: { readonly pluginId: string; readonly variables?: Readonly<Record<string, string>> },
    ) =>
      Effect.gen(function* () {
        const failed = () => new GrokBotMarketplaceError({ reason: "plugin_change_failed" });
        if (!/^\d{1,19}$/.test(input.pluginId)) return yield* failed();
        const binding = yield* account;
        yield* native
          .marketplaceRequest(
            binding,
            method === "InstallUserPlugin"
              ? {
                  method,
                  input: {
                    pluginId: input.pluginId,
                    ...(input.variables === undefined ? {} : { variables: input.variables }),
                  },
                }
              : { method, input: { pluginId: input.pluginId } },
          )
          .pipe(Effect.mapError(failed));
        yield* sameAccount(binding);
        return { pluginId: input.pluginId };
      });
    const installPlugin = Effect.fn("GrokBotMarketplaceService.installPlugin")(
      (input: typeof GrokBotMarketplacePluginInstallInput.Type) =>
        changePlugin("InstallUserPlugin", input),
    );
    const uninstallPlugin = Effect.fn("GrokBotMarketplaceService.uninstallPlugin")(
      (input: typeof GrokBotMarketplacePluginUninstallInput.Type) =>
        changePlugin("UninstallUserPlugin", input),
    );

    // Previews the recipe only. The blob is never imported or written anywhere.
    const template = Effect.fn("GrokBotMarketplaceService.template")(function* (
      input: typeof GrokBotMarketplaceTemplateInput.Type,
    ) {
      const binding = yield* account;
      const details = yield* native
        .marketplaceRequest(binding, {
          method: "GetGrokBotTemplateImportDetails",
          input: { shareId: input.shareId },
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(NativeTemplateDetails)),
          Effect.mapError(unavailable),
        );
      const recipe = yield* native
        .templateBlob(binding, details.blobGetUrl)
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(NativeRecipe)),
          Effect.mapError(unavailable),
        );
      yield* sameAccount(binding);
      return {
        shareId: input.shareId,
        creatorDisplayName: details.creatorDisplayName ?? "",
        expectedActiveVersion: details.expectedActiveVersion,
        profile: {
          name: recipe.profile.name,
          description: recipe.profile.description ?? "",
          ...(recipe.profile.avatarShape === undefined
            ? {}
            : { avatarShape: recipe.profile.avatarShape }),
          ...(recipe.profile.avatarColor === undefined
            ? {}
            : { avatarColor: recipe.profile.avatarColor }),
        },
        memories: decodeEntries(Schema.decodeUnknownOption(NativeMemory), recipe.memory).map(
          (memory) => ({
            kind: memory.kind ?? "",
            ...(memory.createdAt === undefined ? {} : { createdAt: String(memory.createdAt) }),
            content: memory.content ?? "",
          }),
        ),
        skills: decodeEntries(Schema.decodeUnknownOption(NativeSkill), recipe.skills).map(
          (skill) => ({
            name: skill.name,
            description: skill.description ?? "",
            content: skill.content ?? "",
          }),
        ),
        routines: decodeEntries(Schema.decodeUnknownOption(NativeRoutine), recipe.routines).map(
          (routine) => ({
            name: routine.name,
            slug: routine.slug ?? routine.name,
            description: routine.description ?? "",
            content: routine.content ?? "",
          }),
        ),
        plugins: decodeEntries(Schema.decodeUnknownOption(NativePlugin), recipe.plugins).map(
          (plugin) => ({
            name: plugin.name,
            ...(plugin.description === undefined ? {} : { description: plugin.description }),
            pluginId: plugin.pluginId,
          }),
        ),
      };
    });

    // Creates the bot only. The account reports whether it ran setup; plugin installs are not attempted.
    const importTemplate = Effect.fn("GrokBotMarketplaceService.importTemplate")(function* (
      input: typeof GrokBotMarketplaceImportInput.Type,
    ) {
      const binding = yield* account;
      const created = yield* native
        .marketplaceRequest(binding, {
          method: "CreateGrokBotAgentFromTemplate",
          input: {
            shareId: input.shareId,
            agentId: input.agentId,
            expectedActiveVersion: input.expectedActiveVersion,
            setupDelegationSupported: false,
          },
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(NativeImportResponse)),
          Effect.mapError(() => new GrokBotMarketplaceError({ reason: "import_failed" })),
        );
      yield* sameAccount(binding);
      return {
        agentId: created.agent.agentId || input.agentId,
        setupHandledByServer: created.setupHandledByServer ?? false,
        conversationalSetupEnabled: created.conversationalSetupEnabled ?? false,
      };
    });

    return GrokBotMarketplaceService.of({
      list,
      plugins,
      installedPlugins,
      installPlugin,
      uninstallPlugin,
      connections,
      authenticate,
      completeAuth,
      template,
      importTemplate,
    });
  });

export const layerWithPorts = (ports: readonly number[]) =>
  Layer.effect(GrokBotMarketplaceService, make(ports));
export const layer = layerWithPorts(LOOPBACK_PORTS);
