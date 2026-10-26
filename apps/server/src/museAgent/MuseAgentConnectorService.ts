import * as Features from "@t3tools/contracts/museAgentFeatures";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { MuseAgentFeatureError } from "./MuseAgentFeatureService.ts";
import * as Transport from "./MuseAgentTransport.ts";

const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
);
const Binding = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Text = Schema.String.check(Schema.isMaxLength(8192));
const NativeConnector = Schema.Struct({
  id: Id,
  name: Schema.optionalKey(Schema.NullOr(Text)),
  description: Schema.optionalKey(Schema.NullOr(Text)),
  state: Schema.optionalKey(Schema.NullOr(Text)),
  supports_multiple_accounts: Schema.optionalKey(Schema.Boolean),
  is_custom: Schema.optionalKey(Schema.Boolean),
});
const NativeAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("oauth"),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  }),
  Schema.Struct({
    type: Schema.Literals(["api_key", "consent_only", "messenger", "whatsapp", "foa_auth", "none"]),
  }),
]);
const NativeAccount = Schema.Struct({
  account_id: Id,
  display_name: Schema.optionalKey(Schema.NullOr(Text)),
  is_default: Schema.optionalKey(Schema.Boolean),
});
const NativePermissions = Schema.Struct({
  sections: Schema.Array(
    Schema.Struct({
      groups: Schema.Array(Schema.Struct({ methods: Schema.Array(Schema.Struct({ key: Id })) })),
    }),
  ),
});
const NativeError = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  httpStatus: Schema.optionalKey(Schema.Int),
  status: Schema.optionalKey(Schema.Int),
});
const isNativeError = Schema.is(NativeError);
const isMissingEndpointAcl = Schema.is(Schema.Struct({ missingEndpointAcl: Schema.Literal(true) }));
const MetaBusinessConnected = Schema.Struct({
  ok: Schema.Literal(true),
  connected: Schema.Literal(true),
  id: Schema.Literal("meta_business"),
});
const UrlControlCharacters = /[\u0000-\u0020\u007f]/;

export class MuseAgentConnectorService extends Context.Service<
  MuseAgentConnectorService,
  {
    readonly authenticate: (
      binding: string,
      connectorId: string,
      authType: "api_key" | "consent_only",
      secret?: string,
    ) => Effect.Effect<void, MuseAgentFeatureError>;
    readonly get: (
      binding: string,
      connectorId: string,
      sessionId?: string,
    ) => Effect.Effect<Features.MuseAgentConnector, MuseAgentFeatureError>;
    readonly connectInfo: (
      binding: string,
      connectorId: string,
      sessionId?: string,
    ) => Effect.Effect<Features.MuseAgentConnectorConnectInfo, MuseAgentFeatureError>;
    readonly disconnect: (
      binding: string,
      connectorId: string,
      sessionId?: string,
    ) => Effect.Effect<void, MuseAgentFeatureError>;
    readonly accounts: (
      binding: string,
      connectorId: string,
    ) => Effect.Effect<Features.MuseAgentConnectorAccounts, MuseAgentFeatureError>;
    readonly linkAccount: (
      binding: string,
      connectorId: string,
    ) => Effect.Effect<Features.MuseAgentConnectorAuthorization, MuseAgentFeatureError>;
    readonly unlinkAccount: (
      binding: string,
      connectorId: string,
      accountId: string,
    ) => Effect.Effect<void, MuseAgentFeatureError>;
    readonly scopeLink: (
      binding: string,
      connectorId: string,
      method: string,
      accountId?: string,
    ) => Effect.Effect<Features.MuseAgentConnectorAuthorization, MuseAgentFeatureError>;
  }
>()("t3/museAgent/MuseAgentConnectorService") {}

const make = Effect.gen(function* () {
  const transport = yield* Transport.MuseAgentTransport;
  const failure = (error: Transport.MuseAgentTransportError) => {
    if (error.kind === "account_changed")
      return new MuseAgentFeatureError({ feature: "connectors", code: "account_changed" });
    const native = isNativeError(error.cause) ? error.cause : undefined;
    const status = native?.httpStatus ?? native?.status;
    return new MuseAgentFeatureError({
      feature: "connectors",
      code:
        status === 403
          ? "refused"
          : status === 404 ||
              status === 501 ||
              ["method_not_found", "unknown_method", "unsupported_method"].includes(
                native?.code ?? "",
              )
            ? "unavailable"
            : error.kind === "uncertain"
              ? "write_uncertain"
              : error.kind === "protocol"
                ? "invalid_response"
                : "connection_unavailable",
    });
  };
  const validate = <S extends Schema.Top>(schema: S, input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(
        () => new MuseAgentFeatureError({ feature: "connectors", code: "invalid_request" }),
      ),
    );
  const decode = <S extends Schema.Top>(schema: S, input: unknown, write = false) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(
        () =>
          new MuseAgentFeatureError({
            feature: "connectors",
            code: write ? "write_uncertain" : "invalid_response",
          }),
      ),
    );
  const request = Effect.fnUntraced(function* (
    binding: string,
    method: string,
    params: Record<string, unknown>,
    write = false,
  ) {
    yield* validate(Binding, binding);
    const current = yield* transport.connect.pipe(Effect.mapError(failure));
    if (current !== binding)
      return yield* new MuseAgentFeatureError({ feature: "connectors", code: "account_changed" });
    return yield* transport.request(binding, method, params, write).pipe(Effect.mapError(failure));
  });
  const select = Effect.fnUntraced(function* (
    binding: string,
    connectorId: string,
    sessionId?: string,
  ) {
    yield* validate(Id, connectorId);
    if (sessionId !== undefined) yield* validate(Id, sessionId);
    const catalog = yield* decode(
      Schema.Struct({ connectors: Schema.Array(NativeConnector) }),
      yield* request(binding, "connectors.list", { surface: "settings" }),
    );
    const connector = catalog.connectors.find((entry) => entry.id === connectorId);
    if (!connector)
      return yield* new MuseAgentFeatureError({ feature: "connectors", code: "invalid_request" });
    return connector;
  });
  const authorization = Effect.fnUntraced(function* (value: string, write = false) {
    const invalid = new MuseAgentFeatureError({
      feature: "connectors",
      code: write ? "write_uncertain" : "invalid_response",
    });
    // Authorization links are returned for an explicit client action, never opened or logged here.
    const url = yield* Effect.try({ try: () => new URL(value), catch: () => invalid });
    if (
      UrlControlCharacters.test(value) ||
      value.length > 8192 ||
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== ""
    )
      return yield* invalid;
    return { authorizationUrl: url.href };
  });
  const accounts = Effect.fnUntraced(function* (binding: string, connectorId: string) {
    yield* select(binding, connectorId);
    const result = yield* request(binding, "connectors.accounts", { id: connectorId }).pipe(
      Effect.map((value) => ({ supported: true as const, value })),
      Effect.catchTags({
        MuseAgentFeatureError: (error) =>
          error.code === "unavailable"
            ? Effect.succeed({ supported: false as const })
            : Effect.fail(error),
      }),
    );
    if (!result.supported) return { supported: false, accounts: [] };
    const native = yield* decode(
      Schema.Struct({ accounts: Schema.Array(NativeAccount).check(Schema.isMaxLength(256)) }),
      result.value,
    );
    if (
      new Set(native.accounts.map((account) => account.account_id)).size !== native.accounts.length
    )
      return yield* new MuseAgentFeatureError({ feature: "connectors", code: "invalid_response" });
    return {
      supported: true,
      accounts: [...native.accounts]
        .sort(
          (a, b) =>
            Number(b.is_default === true) - Number(a.is_default === true) ||
            (a.display_name?.trim() ?? "").localeCompare(b.display_name?.trim() ?? "") ||
            a.account_id.localeCompare(b.account_id),
        )
        .map((account) => ({
          accountId: account.account_id,
          ...(account.display_name == null ? {} : { displayName: account.display_name }),
          ...(account.is_default === undefined ? {} : { isDefault: account.is_default }),
        })),
    };
  });
  return MuseAgentConnectorService.of({
    authenticate: Effect.fnUntraced(function* (binding, connectorId, authType, secret) {
      yield* select(binding, connectorId);
      const info = yield* decode(
        Schema.Struct({ action: NativeAction }),
        yield* request(binding, "connectors.connect_info", { id: connectorId }),
      );
      if (
        info.action.type !== authType ||
        (authType === "api_key" && (!secret || Buffer.byteLength(secret, "utf8") > 65536))
      )
        return yield* new MuseAgentFeatureError({ feature: "connectors", code: "invalid_request" });
      if (connectorId === "meta_business" && authType === "consent_only") {
        yield* transport.request(binding, "connectors.connect", { id: connectorId }, true).pipe(
          Effect.map((value) => ({ kind: "connected" as const, value })),
          Effect.catchIf(
            (error) => isMissingEndpointAcl(error.cause),
            () =>
              request(binding, "consent_auth.callback", { provider: connectorId }, true).pipe(
                Effect.as({ kind: "fallback" as const }),
              ),
          ),
          Effect.mapError((error) =>
            error._tag === "MuseAgentTransportError" ? failure(error) : error,
          ),
          Effect.flatMap((result) =>
            result.kind === "fallback"
              ? Effect.void
              : decode(MetaBusinessConnected, result.value, true).pipe(Effect.asVoid),
          ),
        );
        return;
      }
      yield* request(
        binding,
        authType === "api_key" ? "api_key_auth.callback" : "consent_auth.callback",
        { provider: connectorId, ...(authType === "api_key" ? { key: secret } : {}) },
        true,
      );
    }),
    get: Effect.fnUntraced(function* (binding, connectorId, sessionId) {
      yield* select(binding, connectorId, sessionId);
      const native = yield* decode(
        NativeConnector,
        yield* request(binding, "connectors.get", {
          id: connectorId,
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
        }),
      );
      if (native.id !== connectorId)
        return yield* new MuseAgentFeatureError({
          feature: "connectors",
          code: "invalid_response",
        });
      return {
        id: native.id,
        name: native.name ?? native.id,
        description: native.description ?? "",
        state:
          native.state === "connected" ||
          native.state === "coming_soon" ||
          native.state === "disconnected"
            ? native.state
            : "unknown",
        ...(native.supports_multiple_accounts === undefined
          ? {}
          : { supportsMultipleAccounts: native.supports_multiple_accounts }),
        ...(native.is_custom === undefined ? {} : { isCustom: native.is_custom }),
      };
    }),
    connectInfo: Effect.fnUntraced(function* (binding, connectorId, sessionId) {
      yield* select(binding, connectorId, sessionId);
      const native = yield* decode(
        Schema.Struct({ action: NativeAction }),
        yield* request(binding, "connectors.connect_info", {
          id: connectorId,
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
        }),
      );
      const action =
        native.action.type === "oauth"
          ? { type: "oauth" as const, ...(yield* authorization(native.action.url)) }
          : native.action;
      return { connectorId, action };
    }),
    disconnect: Effect.fnUntraced(function* (binding, connectorId, sessionId) {
      yield* select(binding, connectorId, sessionId);
      yield* request(
        binding,
        "connectors.disconnect",
        { id: connectorId, ...(sessionId === undefined ? {} : { session_id: sessionId }) },
        true,
      );
    }),
    accounts,
    linkAccount: Effect.fnUntraced(function* (binding, connectorId) {
      const selected = yield* select(binding, connectorId);
      if (!selected.supports_multiple_accounts)
        return yield* new MuseAgentFeatureError({ feature: "connectors", code: "unavailable" });
      const native = yield* decode(
        Schema.Struct({ link_url: Schema.String.check(Schema.isMaxLength(8192)) }),
        yield* request(binding, "connectors.accounts_link", { id: connectorId }, true),
        true,
      );
      return yield* authorization(native.link_url.trim(), true);
    }),
    unlinkAccount: Effect.fnUntraced(function* (binding, connectorId, accountId) {
      yield* validate(Id, accountId);
      const current = yield* accounts(binding, connectorId);
      if (!current.supported)
        return yield* new MuseAgentFeatureError({ feature: "connectors", code: "unavailable" });
      if (!current.accounts.some((account) => account.accountId === accountId))
        return yield* new MuseAgentFeatureError({ feature: "connectors", code: "invalid_request" });
      const native = yield* decode(
        Schema.Struct({ unlinked: Schema.Boolean }),
        yield* request(
          binding,
          "connectors.accounts_unlink",
          { id: connectorId, account_id: accountId },
          true,
        ),
        true,
      );
      if (!native.unlinked)
        return yield* new MuseAgentFeatureError({ feature: "connectors", code: "refused" });
    }),
    scopeLink: Effect.fnUntraced(function* (binding, connectorId, method, accountId) {
      yield* select(binding, connectorId);
      yield* validate(Id, method);
      const result = yield* request(binding, "connectors.permissions", { id: connectorId });
      const permissions = yield* decode(
        Schema.Union([Schema.Struct({ permissions: NativePermissions }), NativePermissions]),
        result,
      );
      const sections =
        "permissions" in permissions ? permissions.permissions.sections : permissions.sections;
      if (
        !sections.some((section) =>
          section.groups.some((group) => group.methods.some((entry) => entry.key === method)),
        )
      )
        return yield* new MuseAgentFeatureError({ feature: "connectors", code: "invalid_request" });
      if (accountId !== undefined) {
        yield* validate(Id, accountId);
        const current = yield* accounts(binding, connectorId);
        if (
          !current.supported ||
          !current.accounts.some((account) => account.accountId === accountId)
        )
          return yield* new MuseAgentFeatureError({
            feature: "connectors",
            code: "invalid_request",
          });
      }
      const native = yield* decode(
        Schema.Struct({ link_url: Schema.String.check(Schema.isMaxLength(8192)) }),
        yield* request(
          binding,
          "connectors.scope_link",
          {
            id: connectorId,
            method,
            ...(accountId === undefined ? {} : { account_id: accountId }),
          },
          true,
        ),
        true,
      );
      return yield* authorization(native.link_url.trim(), true);
    }),
  });
});
export const layer = Layer.effect(MuseAgentConnectorService, make);
