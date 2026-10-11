import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Hex from "effect/encoding/Hex";
import { HttpRouter } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import { EnvironmentHttpApi } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GrokBotAvatarEngine from "./GrokBotAvatarEngine.ts";

const DEV_TOKEN = "local-avatar-test-auth-token-long-enough";
class AvatarEngineTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.grokBotAvatarEngine,
) {}
const source =
  "export function createEngine(React, jsxRuntime) { return { React, jsxRuntime }; }\n";
const fixture = Effect.fnUntraced(function* (denyScope = false) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-avatar-engine-" });
  const directory = `${root}/integrations/grokbot`;
  const sha256 = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(source))
    .pipe(Effect.map(Hex.encode));
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(DEV_TOKEN),
      };
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), root)));
  const authLayer = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(configLayer),
  );
  const scopedAuthLayer = denyScope
    ? Layer.effect(
        EnvironmentAuth.EnvironmentAuth,
        Effect.gen(function* () {
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          return {
            ...auth,
            authenticateHttpRequest: (request) =>
              auth
                .authenticateHttpRequest(request)
                .pipe(Effect.map((session) => ({ ...session, scopes: [] }))),
          } satisfies EnvironmentAuth.EnvironmentAuth["Service"];
        }),
      ).pipe(Layer.provide(authLayer))
    : authLayer;
  const routes = HttpApiBuilder.layer(AvatarEngineTestApi).pipe(
    Layer.provide(ServerHttp.layerGrokBotAvatarEngineRoute),
    Layer.provideMerge(GrokBotAvatarEngine.layer),
    Layer.provideMerge(scopedAuthLayer),
    Layer.provide(configLayer),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Etag.layerWeak),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const app = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    (app) => Effect.promise(() => app.dispose()),
  );
  const get = (suffix = "", authenticated = true) =>
    Effect.promise(() =>
      app.handler(
        new Request(`http://127.0.0.1/api/grok-bot/avatar-engine${suffix}`, {
          headers: authenticated ? { authorization: `Bearer ${DEV_TOKEN}` } : {},
        }),
      ),
    );
  const install = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(`${directory}/${sha256}.mjs`, source);
    yield* fs.writeFileString(
      `${directory}/manifest.json`,
      JSON.stringify({ apiVersion: 1, version: "0.68.1", sha256 }),
    );
  });
  return { fs, directory, sha256, get, install };
});

it.effect("requires authentication before exposing installation state or module source", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const rejected = yield* f.get("", false);
    expect(rejected.status).toBe(401);
    expect(yield* Effect.promise(() => rejected.json())).toMatchObject({
      _tag: "EnvironmentAuthInvalidError",
      reason: "missing_credential",
    });
    expect((yield* f.get(`/${f.sha256}.mjs`, false)).status).toBe(401);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("requires orchestration read scope before exposing local assets", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    yield* f.install;
    expect((yield* f.get()).status).toBe(403);
    expect((yield* f.get(`/${f.sha256}.mjs`)).status).toBe(403);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a missing local engine and serves only the installed digest", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect((yield* f.get()).status).toBe(404);
    yield* f.install;
    const metadata = yield* f.get();
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("cache-control")).toBe("private, no-store");
    expect(yield* Effect.promise(() => metadata.json())).toEqual({
      apiVersion: 1,
      version: "0.68.1",
      sha256: f.sha256,
      modulePath: `/api/grok-bot/avatar-engine/${f.sha256}.mjs`,
    });
    const module = yield* f.get(`/${f.sha256}.mjs`);
    expect(module.status).toBe(200);
    expect(module.headers.get("content-type")).toContain("text/javascript");
    expect(module.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(yield* Effect.promise(() => module.text())).toBe(source);
    expect((yield* f.get(`/${"a".repeat(64)}.mjs`)).status).toBe(404);
    expect((yield* f.get("/manifest.json")).status).toBe(400);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects modified and oversized local modules", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.install;
    yield* f.fs.writeFileString(`${f.directory}/${f.sha256}.mjs`, "changed");
    expect((yield* f.get(`/${f.sha256}.mjs`)).status).toBe(500);
    yield* f.fs.writeFileString(`${f.directory}/${f.sha256}.mjs`, " ".repeat(2 * 1024 * 1024 + 1));
    expect((yield* f.get()).status).toBe(500);
  }).pipe(Effect.provide(NodeServices.layer)),
);
