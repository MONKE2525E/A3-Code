import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import { fetchEnvironmentGrokBotAvatarEngine } from "./grokBotAvatarEngineHttp.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("avatar-environment"),
  label: "Avatar environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
};
const digest = "a".repeat(64);
const metadata = {
  apiVersion: 1,
  version: "0.68.1",
  sha256: digest,
  modulePath: `/api/grok-bot/avatar-engine/${digest}.mjs`,
};
const source = "export function createEngine(React, jsxRuntime) { return {}; }";
const available = { _tag: "Available", version: metadata.version, sha256: digest, source };

function harness(reply: (url: string, index: number) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (request, init) => {
    const url = String(request);
    calls.push({ url, init: init ?? {} });
    return reply(url, calls.length);
  };
  return { calls, layer: RpcHttp.layerRemoteHttpClient(fetchFn) };
}
const replyAvailable = (url: string) =>
  url.endsWith(".mjs")
    ? new Response(source, { headers: { "content-type": "text/javascript" } })
    : Response.json(metadata);

describe("Grok Bot avatar authenticated transport", () => {
  it.effect.each([
    { name: "cookie", authorization: null },
    { name: "bearer", authorization: { _tag: "Bearer" as const, token: "avatar-token" } },
  ])("loads metadata and text with $name authentication", ({ authorization }) =>
    Effect.gen(function* () {
      const h = harness(replyAvailable);
      const result = yield* fetchEnvironmentGrokBotAvatarEngine({
        prepared: { ...prepared, httpAuthorization: authorization },
        signer: Option.none(),
      }).pipe(Effect.provide(h.layer));
      expect(result).toEqual(available);
      expect(h.calls.map((call) => call.url)).toEqual([
        "https://environment.example.test/api/grok-bot/avatar-engine",
        `https://environment.example.test/api/grok-bot/avatar-engine/${digest}.mjs`,
      ]);
      for (const call of h.calls) {
        expect(call.init.method).toBe("GET");
        expect(call.init.credentials).toBe(authorization === null ? "include" : undefined);
        expect(new Headers(call.init.headers).get("authorization")).toBe(
          authorization === null ? null : "Bearer avatar-token",
        );
      }
    }),
  );

  it.effect("renews rejected relay credentials and signs each exact metadata/module URL", () =>
    Effect.gen(function* () {
      const proofs: ManagedRelay.ManagedRelayDpopProofInput[] = [];
      const authorizations: { rejectedAccessToken?: string }[] = [];
      let renewed = false;
      const relayTarget = new RelayConnectionTarget({
        environmentId: target.environmentId,
        label: target.label,
      });
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("avatar-key"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return `proof-${proofs.length}`;
          }),
      });
      const authorization = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("Unexpected bearer preparation"),
        authorizeDpop: () => Effect.die("Unexpected socket preparation"),
        authorizeDpopHttp: (input) =>
          Effect.sync(() => {
            authorizations.push(input);
            if (input.rejectedAccessToken) renewed = true;
            return {
              environmentId: target.environmentId,
              label: target.label,
              httpBaseUrl: renewed ? "https://renewed.example.test" : "https://relay.example.test",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: renewed ? "renewed-token" : "current-token",
                expiresAtEpochMs: 3_600_000,
              },
            };
          }),
      });
      const h = harness((url, index) =>
        index === 1
          ? Response.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "avatar-auth",
              },
              { status: 401 },
            )
          : replyAvailable(url),
      );
      const result = yield* fetchEnvironmentGrokBotAvatarEngine({
        prepared: {
          ...prepared,
          target: relayTarget,
          httpAuthorization: { _tag: "Dpop", accessToken: "expired-token", expiresAtEpochMs: 0 },
        },
        signer: Option.some(signer),
        remoteAuthorization: Option.some(authorization),
      }).pipe(Effect.provide(h.layer));
      expect(result).toEqual(available);
      expect(authorizations).toHaveLength(3);
      expect(authorizations[1]).toMatchObject({ rejectedAccessToken: "current-token" });
      expect(proofs.map(({ method, url, accessToken }) => ({ method, url, accessToken }))).toEqual([
        {
          method: "GET",
          url: "https://relay.example.test/api/grok-bot/avatar-engine",
          accessToken: "current-token",
        },
        {
          method: "GET",
          url: "https://renewed.example.test/api/grok-bot/avatar-engine",
          accessToken: "renewed-token",
        },
        {
          method: "GET",
          url: `https://renewed.example.test/api/grok-bot/avatar-engine/${digest}.mjs`,
          accessToken: "renewed-token",
        },
      ]);
      for (const [index, call] of h.calls.entries()) {
        expect(call.url).toBe(proofs[index]!.url);
        expect(new Headers(call.init.headers).get("dpop")).toBe(`proof-${index + 1}`);
        expect(call.init.credentials).toBeUndefined();
      }
    }),
  );

  it.effect.each([false, true])(
    "returns Missing for an absent local asset (module=%s)",
    (missingModule) =>
      Effect.gen(function* () {
        const h = harness((url) =>
          missingModule && !url.endsWith(".mjs")
            ? Response.json(metadata)
            : Response.json(
                {
                  _tag: "EnvironmentResourceNotFoundError",
                  code: "not_found",
                  reason: "grok_bot_avatar_engine_not_found",
                  traceId: "avatar-missing",
                },
                { status: 404 },
              ),
        );
        expect(
          yield* fetchEnvironmentGrokBotAvatarEngine({ prepared, signer: Option.none() }).pipe(
            Effect.provide(h.layer),
          ),
        ).toEqual({ _tag: "Missing" });
        expect(h.calls).toHaveLength(missingModule ? 2 : 1);
      }),
  );

  it.effect("returns Missing for an older server without the optional route", () =>
    Effect.gen(function* () {
      const h = harness(() => new Response("Not Found", { status: 404 }));
      expect(
        yield* fetchEnvironmentGrokBotAvatarEngine({ prepared, signer: Option.none() }).pipe(
          Effect.provide(h.layer),
        ),
      ).toEqual({ _tag: "Missing" });
    }),
  );

  it.effect("returns Unavailable for a damaged local installation", () =>
    Effect.gen(function* () {
      const h = harness(() =>
        Response.json(
          {
            _tag: "EnvironmentInternalError",
            code: "internal_error",
            reason: "grok_bot_avatar_engine_unavailable",
            traceId: "avatar-unavailable",
          },
          { status: 500 },
        ),
      );
      expect(
        yield* fetchEnvironmentGrokBotAvatarEngine({ prepared, signer: Option.none() }).pipe(
          Effect.provide(h.layer),
        ),
      ).toEqual({ _tag: "Unavailable" });
    }),
  );

  it.effect("preserves permission denials for the caller", () =>
    Effect.gen(function* () {
      const h = harness(() =>
        Response.json(
          {
            _tag: "EnvironmentScopeRequiredError",
            code: "insufficient_scope",
            requiredScope: "orchestration:read",
            traceId: "avatar-denied",
          },
          { status: 403 },
        ),
      );
      const error = yield* fetchEnvironmentGrokBotAvatarEngine({
        prepared,
        signer: Option.none(),
      }).pipe(Effect.provide(h.layer), Effect.flip);
      expect(error._tag).toBe("EnvironmentScopeRequiredError");
      expect(h.calls).toHaveLength(1);
    }),
  );
});
