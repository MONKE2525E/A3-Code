import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Service from "./MuseAgentConnectorService.ts";
import * as Transport from "./MuseAgentTransport.ts";

const binding = "a".repeat(64);
const connector = {
  id: "calendar",
  name: "Calendar",
  state: "connected",
  supports_multiple_accounts: true,
};
const nativeAccounts = {
  accounts: [
    { account_id: "one", display_name: "First", is_default: true },
    { account_id: "two", display_name: "Second", is_default: false },
  ],
};
const fixture = (
  responses: Readonly<Record<string, unknown>> = {},
  respond?: (
    method: string,
    params: Record<string, unknown>,
  ) => Effect.Effect<unknown, Transport.MuseAgentTransportError> | undefined,
  selectedConnector = connector,
) => {
  let current = binding;
  const calls: { method: string; params: Record<string, unknown>; write: boolean }[] = [];
  const transport = Transport.MuseAgentTransport.of({
    acquireTurn: () => Effect.succeed(Effect.void),
    releaseOwned: () => Effect.void,
    connect: Effect.sync(() => current),
    request: (_binding, method, params, write = false) =>
      Effect.suspend(() => {
        calls.push({ method, params, write });
        return (
          respond?.(method, params) ??
          Effect.succeed(
            method === "connectors.list" ? { connectors: [selectedConnector] } : responses[method],
          )
        );
      }),
    watch: () => Effect.die("unused watch"),
    connectionId: () => Effect.die("unused connectionId"),
    readAvatar: () => Effect.die("unused readAvatar"),
    openComputerStream: () => Effect.die("unused openComputerStream"),
    readComputerPreview: () => Effect.die("unused readComputerPreview"),
    cancelOwned: () => Effect.die("unused cancelOwned"),
    registerTools: () => Effect.die("unused registerTools"),
    unregisterTools: () => Effect.die("unused unregisterTools"),
  });
  return {
    calls,
    changeAccount: () => {
      current = "b".repeat(64);
    },
    layer: Service.layer.pipe(
      Layer.provide(Layer.succeed(Transport.MuseAgentTransport, transport)),
    ),
  };
};

it.effect(
  "reads native connector details and OAuth authorization with the selected session",
  () => {
    const f = fixture({
      "connectors.get": { ...connector, privateToken: "synthetic-secret" },
      "connectors.connect_info": {
        action: { type: "oauth", url: "https://authorize.example.test/flow?state=synthetic" },
      },
    });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentConnectorService;
      expect(yield* service.get(binding, "calendar", "primary")).toEqual({
        id: "calendar",
        name: "Calendar",
        description: "",
        state: "connected",
        supportsMultipleAccounts: true,
      });
      expect(yield* service.connectInfo(binding, "calendar", "primary")).toEqual({
        connectorId: "calendar",
        action: {
          type: "oauth",
          authorizationUrl: "https://authorize.example.test/flow?state=synthetic",
        },
      });
      expect(f.calls.filter((call) => call.method !== "connectors.list")).toEqual([
        {
          method: "connectors.get",
          params: { id: "calendar", session_id: "primary" },
          write: false,
        },
        {
          method: "connectors.connect_info",
          params: { id: "calendar", session_id: "primary" },
          write: false,
        },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["api_key", "consent_only", "messenger", "whatsapp", "foa_auth", "none"] as const)(
  "returns the native $0 descriptor without dispatching an unsupported authentication callback",
  (type) => {
    const f = fixture({
      "connectors.connect_info": { action: { type, key: "synthetic-private" } },
    });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentConnectorService;
      expect(yield* service.connectInfo(binding, "calendar")).toEqual({
        connectorId: "calendar",
        action: { type },
      });
      expect(f.calls.every((call) => !call.write)).toBe(true);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([
  "javascript:alert(1)",
  "http://authorize.example.test/",
  "data:text/html,test",
  "https://user:password@authorize.example.test/",
  "https://authorize.example.test/\nflow",
  "not a URL",
])("rejects unsafe native authorization links: $0", (url) => {
  const f = fixture({ "connectors.connect_info": { action: { type: "oauth", url } } });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    const error = yield* Effect.flip(service.connectInfo(binding, "calendar"));
    expect(error.code).toBe("invalid_response");
    expect(error.message).not.toContain(url);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "rejects unknown connector IDs before requesting details or dispatching mutations",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentConnectorService;
      expect((yield* Effect.flip(service.disconnect(binding, "missing"))).code).toBe(
        "invalid_request",
      );
      expect((yield* Effect.flip(service.connectInfo(binding, "constructor"))).code).toBe(
        "invalid_request",
      );
      expect((yield* Effect.flip(service.get(binding, "../credentials"))).code).toBe(
        "invalid_request",
      );
      expect(f.calls.every((call) => call.method === "connectors.list")).toBe(true);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("validates the returned connector identity and supported action discriminant", () => {
  const f = fixture({
    "connectors.get": { id: "other" },
    "connectors.connect_info": { action: { type: "unknown", url: "https://example.test" } },
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    expect((yield* Effect.flip(service.get(binding, "calendar"))).code).toBe("invalid_response");
    expect((yield* Effect.flip(service.connectInfo(binding, "calendar"))).code).toBe(
      "invalid_response",
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "disconnects once with an optional native session and ignores the unused native body",
  () => {
    const f = fixture({ "connectors.disconnect": null });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentConnectorService;
      yield* service.disconnect(binding, "calendar", "primary");
      expect(f.calls.filter((call) => call.write)).toEqual([
        {
          method: "connectors.disconnect",
          params: { id: "calendar", session_id: "primary" },
          write: true,
        },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([
  "connectors.disconnect",
  "connectors.accounts_link",
  "connectors.accounts_unlink",
  "connectors.scope_link",
] as const)("never retries an ambiguous $0 mutation", (method) => {
  const f = fixture({}, (name) => {
    if (name === method)
      return Effect.fail(
        new Transport.MuseAgentTransportError({
          kind: "uncertain",
          cause: "synthetic-private-error",
        }),
      );
    return Effect.succeed(
      name === "connectors.list"
        ? { connectors: [connector] }
        : name === "connectors.accounts"
          ? nativeAccounts
          : name === "connectors.permissions"
            ? { sections: [{ groups: [{ methods: [{ key: "read_events" }] }] }] }
            : {},
    );
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    const operation =
      method === "connectors.disconnect"
        ? service.disconnect(binding, "calendar")
        : method === "connectors.accounts_link"
          ? service.linkAccount(binding, "calendar")
          : method === "connectors.accounts_unlink"
            ? service.unlinkAccount(binding, "calendar", "one")
            : service.scopeLink(binding, "calendar", "read_events", "one");
    const error = yield* Effect.flip(operation);
    expect(error.code).toBe("write_uncertain");
    expect(error.message).not.toContain("synthetic-private-error");
    expect(f.calls.filter((call) => call.write)).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("fences account changes after selecting a connector", () => {
  const f = fixture({}, () =>
    Effect.sync(() => {
      f.changeAccount();
      return { connectors: [connector] };
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    expect((yield* Effect.flip(service.disconnect(binding, "calendar"))).code).toBe(
      "account_changed",
    );
    expect(f.calls.filter((call) => call.write)).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("lists linked accounts with default first and drops unrelated private fields", () => {
  const f = fixture({
    "connectors.accounts": {
      accounts: [
        {
          account_id: "two",
          display_name: "Second",
          is_default: false,
          email: "synthetic-private",
        },
        { account_id: "one", display_name: "First", is_default: true },
      ],
    },
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    expect(yield* service.accounts(binding, "calendar")).toEqual({
      supported: true,
      accounts: [
        { accountId: "one", displayName: "First", isDefault: true },
        { accountId: "two", displayName: "Second", isDefault: false },
      ],
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "treats the documented accounts 404 as unsupported but rejects malformed successful responses",
  () => {
    const f = fixture({}, (method) =>
      method === "connectors.accounts"
        ? Effect.fail(
            new Transport.MuseAgentTransportError({ kind: "protocol", cause: { httpStatus: 404 } }),
          )
        : Effect.succeed({ connectors: [connector] }),
    );
    const invalid = fixture({ "connectors.accounts": null });
    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const service = yield* Service.MuseAgentConnectorService;
        return yield* service.accounts(binding, "calendar");
      }).pipe(Effect.provide(f.layer));
      expect(result).toEqual({ supported: false, accounts: [] });
      yield* Effect.gen(function* () {
        const service = yield* Service.MuseAgentConnectorService;
        expect((yield* Effect.flip(service.accounts(binding, "calendar"))).code).toBe(
          "invalid_response",
        );
      }).pipe(Effect.provide(invalid.layer));
    });
  },
);

it.effect(
  "requires a native-owned account before unlink and validates the native acknowledgement",
  () => {
    const f = fixture({
      "connectors.accounts": nativeAccounts,
      "connectors.accounts_unlink": { unlinked: true },
    });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentConnectorService;
      expect((yield* Effect.flip(service.unlinkAccount(binding, "calendar", "foreign"))).code).toBe(
        "invalid_request",
      );
      yield* service.unlinkAccount(binding, "calendar", "one");
      expect(f.calls.filter((call) => call.write)).toEqual([
        {
          method: "connectors.accounts_unlink",
          params: { id: "calendar", account_id: "one" },
          write: true,
        },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([{ unlinked: false }, {}])(
  "handles refused or malformed unlink acknowledgement: $0",
  (response) => {
    const f = fixture({
      "connectors.accounts": nativeAccounts,
      "connectors.accounts_unlink": response,
    });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentConnectorService;
      expect((yield* Effect.flip(service.unlinkAccount(binding, "calendar", "one"))).code).toBe(
        "unlinked" in response ? "refused" : "write_uncertain",
      );
      expect(f.calls.filter((call) => call.write)).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "validates account-link URLs after the native mutation and never exposes an unsafe result",
  () => {
    const f = fixture({
      "connectors.accounts_link": { link_url: " https://authorize.example.test/account " },
    });
    const bad = fixture({
      "connectors.accounts_link": { link_url: "http://authorize.example.test" },
    });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* Service.MuseAgentConnectorService;
        expect(yield* service.linkAccount(binding, "calendar")).toEqual({
          authorizationUrl: "https://authorize.example.test/account",
        });
      }).pipe(Effect.provide(f.layer));
      yield* Effect.gen(function* () {
        const service = yield* Service.MuseAgentConnectorService;
        expect((yield* Effect.flip(service.linkAccount(binding, "calendar"))).code).toBe(
          "write_uncertain",
        );
        expect(bad.calls.filter((call) => call.write)).toHaveLength(1);
      }).pipe(Effect.provide(bad.layer));
    });
  },
);

it.effect(
  "limits scope authorization to current native permissions and native-owned account",
  () => {
    const f = fixture({
      "connectors.permissions": {
        permissions: { sections: [{ groups: [{ methods: [{ key: "read_events" }] }] }] },
      },
      "connectors.accounts": nativeAccounts,
      "connectors.scope_link": { link_url: "https://authorize.example.test/scope" },
    });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentConnectorService;
      expect((yield* Effect.flip(service.scopeLink(binding, "calendar", "unknown"))).code).toBe(
        "invalid_request",
      );
      expect(
        (yield* Effect.flip(service.scopeLink(binding, "calendar", "read_events", "foreign"))).code,
      ).toBe("invalid_request");
      expect(yield* service.scopeLink(binding, "calendar", "read_events", "one")).toEqual({
        authorizationUrl: "https://authorize.example.test/scope",
      });
      expect(f.calls.filter((call) => call.write)).toEqual([
        {
          method: "connectors.scope_link",
          params: { id: "calendar", method: "read_events", account_id: "one" },
          write: true,
        },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "refuses account linking when the current native connector does not advertise multiple accounts",
  () => {
    const f = fixture({}, () =>
      Effect.succeed({ connectors: [{ ...connector, supports_multiple_accounts: false }] }),
    );
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentConnectorService;
      expect((yield* Effect.flip(service.linkAccount(binding, "calendar"))).code).toBe(
        "unavailable",
      );
      expect(f.calls.filter((call) => call.write)).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("rejects duplicate native account IDs rather than unlinking an ambiguous account", () => {
  const f = fixture({
    "connectors.accounts": { accounts: [{ account_id: "one" }, { account_id: "one" }] },
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    expect((yield* Effect.flip(service.unlinkAccount(binding, "calendar", "one"))).code).toBe(
      "invalid_response",
    );
    expect(f.calls.filter((call) => call.write)).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("preserves refused account access rather than calling it unsupported", () => {
  const f = fixture({}, (method) =>
    method === "connectors.accounts"
      ? Effect.fail(
          new Transport.MuseAgentTransportError({ kind: "protocol", cause: { httpStatus: 403 } }),
        )
      : Effect.succeed({ connectors: [connector] }),
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    expect((yield* Effect.flip(service.accounts(binding, "calendar"))).code).toBe("refused");
  }).pipe(Effect.provide(f.layer));
});

it.effect("fences a native account replacement before unlink dispatch", () => {
  const f = fixture({}, (method) =>
    Effect.sync(() => {
      if (method === "connectors.accounts") {
        f.changeAccount();
        return nativeAccounts;
      }
      return { connectors: [connector] };
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    expect((yield* Effect.flip(service.unlinkAccount(binding, "calendar", "one"))).code).toBe(
      "account_changed",
    );
    expect(f.calls.filter((call) => call.write)).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("submits API keys directly to native auth and never accepts a mismatched action", () => {
  const f = fixture({ "connectors.connect_info": { action: { type: "api_key" } } });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    yield* service.authenticate(binding, "calendar", "api_key", "synthetic-key");
    expect(f.calls.at(-1)).toEqual({
      method: "api_key_auth.callback",
      params: { provider: "calendar", key: "synthetic-key" },
      write: true,
    });
    const rejected = yield* Effect.result(
      service.authenticate(binding, "calendar", "consent_only"),
    );
    expect(rejected._tag).toBe("Failure");
    expect(f.calls.filter((call) => call.write)).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("submits native consent without a secret", () => {
  const f = fixture({ "connectors.connect_info": { action: { type: "consent_only" } } });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    yield* service.authenticate(binding, "calendar", "consent_only");
    expect(f.calls.at(-1)).toEqual({
      method: "consent_auth.callback",
      params: { provider: "calendar" },
      write: true,
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "uses Meta Business native connect and falls back only on its definite missing-ACL rejection",
  () => {
    const native = { ...connector, id: "meta_business" };
    const f = fixture(
      { "connectors.connect_info": { action: { type: "consent_only" } } },
      (method) =>
        method === "connectors.connect"
          ? Effect.fail(
              new Transport.MuseAgentTransportError({
                kind: "uncertain",
                cause: { missingEndpointAcl: true },
              }),
            )
          : undefined,
      native,
    );
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentConnectorService;
      yield* service.authenticate(binding, "meta_business", "consent_only");
      expect(f.calls.filter((call) => call.write).map((call) => call.method)).toEqual([
        "connectors.connect",
        "consent_auth.callback",
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("validates Meta Business native success without sending a second consent request", () => {
  const f = fixture(
    {
      "connectors.connect_info": { action: { type: "consent_only" } },
      "connectors.connect": { ok: true, connected: true, id: "meta_business" },
    },
    undefined,
    { ...connector, id: "meta_business" },
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    yield* service.authenticate(binding, "meta_business", "consent_only");
    expect(f.calls.filter((call) => call.write).map((call) => call.method)).toEqual([
      "connectors.connect",
    ]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("does not retry Meta Business consent after a refusal", () => {
  const f = fixture(
    { "connectors.connect_info": { action: { type: "consent_only" } } },
    (method) =>
      method === "connectors.connect"
        ? Effect.fail(
            new Transport.MuseAgentTransportError({
              kind: "uncertain",
              cause: { status: 403 },
            }),
          )
        : undefined,
    { ...connector, id: "meta_business" },
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentConnectorService;
    expect(
      (yield* service.authenticate(binding, "meta_business", "consent_only").pipe(Effect.flip))
        .code,
    ).toBe("refused");
    expect(f.calls.filter((call) => call.write).map((call) => call.method)).toEqual([
      "connectors.connect",
    ]);
  }).pipe(Effect.provide(f.layer));
});
