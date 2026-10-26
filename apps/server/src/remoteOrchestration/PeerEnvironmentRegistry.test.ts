import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ServerConfig as ClientConfig, WsRpcGroup } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/rpc/RpcClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as PeerEnvironmentRegistry from "./PeerEnvironmentRegistry.ts";
import * as RemoteEnvironmentClient from "./RemoteEnvironmentClient.ts";

const localId = EnvironmentId.make("local-fixture");
const peerId = EnvironmentId.make("remote-fixture");
const decodeClientConfig = Schema.decodeEffect(ClientConfig);
const pairing = {
  environmentId: peerId,
  pairingUrl: "https://remote.example/pair#token=one-time-secret",
  maxRuntimeMode: "approval-required",
} satisfies Parameters<PeerEnvironmentRegistry.PeerEnvironmentRegistry["Service"]["pair"]>[0];

const fixture = Effect.fn("PeerEnvironmentRegistryTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-registry-test-" });
  const dependencies = yield* Layer.build(
    ServerSecretStore.layer.pipe(Layer.provideMerge(configLayer)),
  );
  const config = Context.get(dependencies, ServerConfig.ServerConfig);
  const state = {
    environmentId: peerId,
    label: "Remote fixture",
    accessToken: "private-access-token",
    rejectExchange: false,
    rejectConnect: false,
    closed: 0,
  };
  const exchanges: Parameters<
    RemoteEnvironmentClient.RemoteEnvironmentClient["Service"]["exchangePairing"]
  >[0][] = [];
  const connections: Parameters<
    RemoteEnvironmentClient.RemoteEnvironmentClient["Service"]["connect"]
  >[0][] = [];
  const discoveries: string[] = [];
  const descriptor = () =>
    ({
      environmentId: state.environmentId,
      label: state.label,
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: false },
    }) as const;
  const clientConfig = yield* decodeClientConfig({
    environment: descriptor(),
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "fixture",
    },
    cwd: "/fixture",
    keybindingsConfigPath: "/fixture/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    settings: {},
    observability: {
      logsDirectoryPath: "/fixture/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
  });
  const { client } = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
    onFromClient: () => Effect.die("Registry must not send orchestration commands while pairing"),
  });
  const remote = RemoteEnvironmentClient.RemoteEnvironmentClient.of({
    descriptor: ({ httpBaseUrl }) =>
      Effect.sync(() => {
        discoveries.push(httpBaseUrl);
        return descriptor();
      }),
    exchangePairing: (input) =>
      Effect.gen(function* () {
        exchanges.push(input);
        if (state.rejectExchange)
          return yield* new RemoteEnvironmentClient.RemoteEnvironmentError({
            reason: "unauthorized",
          });
        return { accessToken: state.accessToken, expiresInSeconds: 3600 };
      }),
    connect: (input) =>
      Effect.gen(function* () {
        connections.push(input);
        if (state.rejectConnect)
          return yield* new RemoteEnvironmentClient.RemoteEnvironmentError({
            reason: "unauthorized",
          });
        return yield* Effect.acquireRelease(Effect.succeed({ client, config: clientConfig }), () =>
          Effect.sync(() => {
            state.closed += 1;
          }),
        );
      }),
  });
  const reopen = PeerEnvironmentRegistry.PeerEnvironmentRegistry.pipe(
    Effect.provide(PeerEnvironmentRegistry.layer),
    Effect.provideService(RemoteEnvironmentClient.RemoteEnvironmentClient, remote),
    Effect.provideService(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(localId),
      getDescriptor: Effect.succeed({ ...descriptor(), environmentId: localId }),
    }),
    Effect.provide(dependencies),
  );
  return {
    registry: yield* reopen,
    reopen,
    fs,
    config,
    state,
    exchanges,
    connections,
    discoveries,
    metadataPath: path.join(config.stateDir, "peer-environments.json"),
    secretFiles: fs.readDirectory(config.secretsDir),
    secretPath: (name: string) => path.join(config.secretsDir, name),
  };
});

it.layer(NodeServices.layer)("PeerEnvironmentRegistry", (it) => {
  it.effect("persists routing separately from private credentials and reloads both", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.registry.list()).toEqual([]);
      const peer = yield* f.registry.pair(pairing);
      expect(peer).toEqual({
        environmentId: peerId,
        label: "Remote fixture",
        httpBaseUrl: "https://remote.example/",
        maxRuntimeMode: "approval-required",
      });
      const metadata = yield* f.fs.readFileString(f.metadataPath);
      expect(JSON.parse(metadata)).toEqual([peer]);
      for (const secret of ["one-time-secret", f.state.accessToken, "bearerToken"])
        expect(metadata).not.toContain(secret);
      const files = yield* f.secretFiles;
      expect(files).toHaveLength(1);
      const file = files[0];
      expect(file).toBeDefined();
      if (!file) throw new Error("Expected a persisted secret file");
      expect(yield* f.fs.readFileString(f.secretPath(file))).toBe(f.state.accessToken);
      expect((yield* f.fs.stat(f.secretPath(file))).mode & 0o777).toBe(0o600);
      expect((yield* f.fs.stat(f.config.secretsDir)).mode & 0o777).toBe(0o700);
      const reopened = yield* f.reopen;
      expect(yield* reopened.list()).toEqual([peer]);
      expect(yield* reopened.get(peerId)).toEqual({ ...peer, bearerToken: f.state.accessToken });
      expect(f.exchanges).toEqual([
        { httpBaseUrl: peer.httpBaseUrl, credential: "one-time-secret" },
      ]);
      expect(f.connections).toEqual([
        { environmentId: peerId, httpBaseUrl: peer.httpBaseUrl, bearerToken: f.state.accessToken },
      ]);
      expect(f.state.closed).toBe(1);
    }),
  );

  it.effect(
    "rejects mistaken and local identities before consuming a one-time pairing credential",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.state.environmentId = EnvironmentId.make("unexpected-box");
        expect((yield* f.registry.pair(pairing).pipe(Effect.flip)).reason).toBe(
          "identity_mismatch",
        );
        expect(
          (yield* f.registry.pair({ ...pairing, environmentId: localId }).pipe(Effect.flip)).reason,
        ).toBe("identity_mismatch");
        expect(f.discoveries).toEqual(["https://remote.example/"]);
        expect(f.exchanges).toEqual([]);
        expect(f.connections).toEqual([]);
        expect(yield* f.registry.list()).toEqual([]);
        expect(yield* f.secretFiles).toEqual([]);
        f.state.environmentId = peerId;
        yield* f.registry.pair(pairing);
        expect(f.exchanges).toHaveLength(1);
      }),
  );

  it.effect.each(["exchange", "connect"] as const)(
    "does not persist a peer or token after %s authorization fails",
    (stage) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.state.rejectExchange = stage === "exchange";
        f.state.rejectConnect = stage === "connect";
        const error = yield* f.registry.pair(pairing).pipe(Effect.flip);
        expect(error.reason).toBe("invalid_pairing");
        expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(f.state.accessToken);
        expect(yield* f.registry.list()).toEqual([]);
        expect(yield* f.secretFiles).toEqual([]);
        expect(yield* f.fs.exists(f.metadataPath)).toBe(false);
        expect((yield* f.registry.get(peerId).pipe(Effect.flip)).reason).toBe("not_paired");
      }),
  );

  it.effect("removes routing and credentials durably without returning a token", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.registry.pair(pairing);
      expect(yield* f.registry.remove(peerId)).toBeUndefined();
      expect(yield* f.secretFiles).toEqual([]);
      expect(JSON.parse(yield* f.fs.readFileString(f.metadataPath))).toEqual([]);
      const reopened = yield* f.reopen;
      expect(yield* reopened.list()).toEqual([]);
      const error = yield* reopened.get(peerId).pipe(Effect.flip);
      expect(error.reason).toBe("not_paired");
      expect(JSON.stringify(error)).not.toContain(f.state.accessToken);
      yield* reopened.remove(peerId);
    }),
  );

  it.effect("keeps peer credentials isolated when another peer is paired and removed", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.registry.pair(pairing);
      const otherId = EnvironmentId.make("second-remote-fixture");
      f.state.environmentId = otherId;
      f.state.accessToken = "second-peer-private-token";
      const other = yield* f.registry.pair({
        ...pairing,
        environmentId: otherId,
        pairingUrl: "https://second.example/pair#token=second-pairing-secret",
      });
      const reopened = yield* f.reopen;
      expect(yield* reopened.get(peerId)).toEqual({
        ...first,
        bearerToken: "private-access-token",
      });
      expect(yield* reopened.get(otherId)).toEqual({
        ...other,
        bearerToken: "second-peer-private-token",
      });
      expect(yield* f.secretFiles).toHaveLength(2);
      yield* reopened.remove(peerId);
      const afterRemoval = yield* f.reopen;
      expect(yield* afterRemoval.list()).toEqual([other]);
      expect(yield* afterRemoval.get(otherId)).toEqual({
        ...other,
        bearerToken: "second-peer-private-token",
      });
      expect(yield* f.secretFiles).toHaveLength(1);
    }),
  );

  it.effect("re-pairs the same id by replacing its routing and token without duplicates", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.registry.pair(pairing);
      f.state.label = "Moved fixture";
      f.state.accessToken = "replacement-private-token";
      const updated = yield* f.registry.pair({
        ...pairing,
        pairingUrl: "http://box.tailnet.ts.net:3773/pair#token=fresh-pairing-secret",
        maxRuntimeMode: "full-access",
      });
      const reopened = yield* f.reopen;
      expect(yield* reopened.list()).toEqual([updated]);
      expect(yield* reopened.get(peerId)).toEqual({
        ...updated,
        bearerToken: "replacement-private-token",
      });
      expect(updated.httpBaseUrl).toBe("http://box.tailnet.ts.net:3773/");
      expect(updated.maxRuntimeMode).toBe("full-access");
      expect(yield* f.secretFiles).toHaveLength(1);
      const metadata = yield* f.fs.readFileString(f.metadataPath);
      expect(metadata).not.toContain("replacement-private-token");
      expect(metadata).not.toContain("fresh-pairing-secret");
      f.state.rejectConnect = true;
      f.state.accessToken = "rejected-replacement-token";
      yield* reopened.pair(pairing).pipe(Effect.flip);
      expect(yield* reopened.get(peerId)).toEqual({
        ...updated,
        bearerToken: "replacement-private-token",
      });
    }),
  );
});
