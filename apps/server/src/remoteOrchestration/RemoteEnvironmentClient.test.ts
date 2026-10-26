// @effect-diagnostics nodeBuiltinImport:off -- isolated HTTP fixtures exercise the real auth and socket transport.
import * as NodeHttp from "node:http";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Schema from "effect/Schema";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RemoteEnvironmentClient from "./RemoteEnvironmentClient.ts";

const environmentId = EnvironmentId.make("remote-fixture");
const descriptor = {
  environmentId,
  label: "Remote fixture",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: false },
} satisfies typeof ExecutionEnvironmentDescriptor.Encoded;

const config = {
  environment: descriptor,
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
} satisfies typeof ServerConfig.Encoded;

const Request = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Number]),
  tag: Schema.String,
  payload: Schema.Unknown,
});

const isRequest = Schema.is(Request);

const fixture = Effect.fn("RemoteEnvironmentClientTest.fixture")(function* (
  options: {
    readonly status?: number;
    readonly body?: unknown;
    readonly config?: unknown;
    readonly redirect?: string;
    readonly socket?: "drop" | "malformed" | "stall";
  } = {},
) {
  const requests: { path: string; authorization: string | undefined; body: string }[] = [];
  const rpcRequests: (typeof Request.Type)[] = [];
  const upgrades: string[] = [];
  const closed = Promise.withResolvers<void>();
  const configRequested = Promise.withResolvers<void>();
  const server = NodeHttp.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
      res.writeHead(options.status ?? 200, {
        "content-type": "application/json",
        ...(options.redirect ? { location: options.redirect } : {}),
      });
      res.end(
        JSON.stringify(
          options.body ??
            (req.url === "/oauth/token"
              ? {
                  access_token: "fixture-access-token",
                  token_type: "Bearer",
                  issued_token_type: AuthAccessTokenType,
                  expires_in: 3600,
                  scope: "orchestration:read orchestration:operate",
                }
              : req.url === "/.well-known/t3/environment"
                ? descriptor
                : {
                    ticket: "fixture-ticket",
                    expiresAt: "2099-01-01T00:00:00.000Z",
                  }),
        ),
      );
    });
  });
  const ws = new NodeWS.WebSocketServer({ server });
  ws.on("connection", (socket, request) => {
    upgrades.push(request.url ?? "");
    socket.once("close", () => closed.resolve());
    socket.on("message", (data) => {
      const decoded: unknown = JSON.parse(data.toString());
      if (!isRequest(decoded)) return;
      rpcRequests.push(decoded);
      if (decoded.tag === WS_METHODS.serverGetConfig) configRequested.resolve();
      if (options.socket === "stall") return;
      if (options.socket === "drop" && decoded.tag !== WS_METHODS.serverGetConfig) {
        socket.terminate();
        return;
      }
      if (options.socket === "malformed") {
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: decoded.id,
            exit: { _tag: "Success", value: {} },
          }),
        );
        return;
      }
      const response: RpcMessage.ResponseExitEncoded = {
        _tag: "Exit",
        requestId: decoded.id,
        exit: {
          _tag: "Success",
          value: decoded.tag === WS_METHODS.serverGetConfig ? (options.config ?? config) : {},
        },
      };
      socket.send(JSON.stringify(response));
    });
  });
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of ws.clients) socket.terminate();
            ws.close(() => server.close(() => resolve()));
            server.closeAllConnections();
          }),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    httpBaseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    rpcRequests,
    upgrades,
    awaitClosed: Effect.promise(() => closed.promise),
    awaitConfigRequested: Effect.promise(() => configRequested.promise),
  };
});

it.live(
  "discovers, exchanges the official pairing form, and connects a native scoped RPC client",
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture();
      const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
      expect(
        yield* service.descriptor({ httpBaseUrl: `${remote.httpBaseUrl}/ignored-path` }),
      ).toEqual(descriptor);
      expect(
        yield* service.exchangePairing({
          httpBaseUrl: remote.httpBaseUrl,
          credential: "one-time-secret",
        }),
      ).toEqual({ accessToken: "fixture-access-token", expiresInSeconds: 3600 });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connected = yield* service.connect({
            environmentId,
            httpBaseUrl: remote.httpBaseUrl,
            bearerToken: "fixture-access-token",
          });
          expect(connected.config.environment.environmentId).toBe(environmentId);
          expect(yield* connected.client[WS_METHODS.serverProbe]({})).toEqual({});
        }),
      );
      yield* remote.awaitClosed;
      expect(remote.requests.map((request) => request.path)).toEqual([
        "/.well-known/t3/environment",
        "/oauth/token",
        "/api/auth/websocket-ticket",
      ]);
      const form = new URLSearchParams(remote.requests[1]?.body);
      expect(Object.fromEntries(form)).toEqual({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: "one-time-secret",
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
      });
      expect(remote.requests[2]?.authorization).toBe("Bearer fixture-access-token");
      const upgrade = new URL(remote.upgrades[0] ?? "", remote.httpBaseUrl);
      expect(upgrade.pathname).toBe("/ws");
      expect(upgrade.searchParams.get("wsTicket")).toBe("fixture-ticket");
      expect(upgrade.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM)).toBe(
        String(ORCHESTRATION_PROTOCOL_VERSION),
      );
      expect(upgrade.toString()).not.toContain("fixture-access-token");
      expect(remote.rpcRequests.map((request) => request.tag)).toEqual([
        WS_METHODS.serverGetConfig,
        WS_METHODS.serverProbe,
      ]);
    }).pipe(Effect.provide(RemoteEnvironmentClient.layer)),
);

it.live("rejects a pairing token that cannot launch remote work", () =>
  Effect.gen(function* () {
    const remote = yield* fixture({
      body: {
        access_token: "fixture-read-only-token",
        token_type: "Bearer",
        issued_token_type: AuthAccessTokenType,
        expires_in: 3600,
        scope: "orchestration:read",
      },
    });
    const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
    const error = yield* service
      .exchangePairing({ httpBaseUrl: remote.httpBaseUrl, credential: "one-time-secret" })
      .pipe(Effect.flip);
    expect(error.reason).toBe("unauthorized");
    expect(remote.upgrades).toEqual([]);
  }).pipe(Effect.provide(RemoteEnvironmentClient.layer)),
);

it.live("rejects a mismatched environment and closes its socket before returning", () =>
  Effect.gen(function* () {
    const remote = yield* fixture();
    const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
    const error = yield* service
      .connect({
        environmentId: EnvironmentId.make("another-box"),
        httpBaseUrl: remote.httpBaseUrl,
        bearerToken: "private-token",
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("identity_mismatch");
    yield* remote.awaitClosed;
    expect(remote.rpcRequests.map((request) => request.tag)).toEqual([WS_METHODS.serverGetConfig]);
    expect(JSON.stringify(error)).not.toContain("private-token");
  }).pipe(Effect.provide(RemoteEnvironmentClient.layer)),
);

it.live("decodes config through the native RPC schema and rejects malformed config", () =>
  Effect.gen(function* () {
    const remote = yield* fixture({ socket: "malformed" });
    const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
    const error = yield* service
      .connect({ environmentId, httpBaseUrl: remote.httpBaseUrl, bearerToken: "private-token" })
      .pipe(Effect.flip);
    expect(error.reason).toBe("invalid_response");
    yield* remote.awaitClosed;
  }).pipe(Effect.provide(RemoteEnvironmentClient.layer)),
);

it.live(
  "does not reconnect or replay a mutation with a caller-supplied command ID after a socket drops",
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture({ socket: "drop" });
      const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
      const { client } = yield* service.connect({
        environmentId,
        httpBaseUrl: remote.httpBaseUrl,
        bearerToken: "private-token",
      });
      const command = {
        type: "thread.stop",
        commandId: CommandId.make("stable-caller-command"),
        threadId: ThreadId.make("remote-thread"),
      } as const;
      yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command).pipe(Effect.flip);
      yield* remote.awaitClosed;
      yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command).pipe(Effect.flip);
      expect(remote.upgrades).toHaveLength(1);
      expect(remote.rpcRequests.map((request) => request.tag)).toEqual([
        WS_METHODS.serverGetConfig,
        ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      ]);
      expect(remote.rpcRequests[1]?.payload).toEqual(command);
    }).pipe(Effect.provide(RemoteEnvironmentClient.layer)),
);

it.live("rejects redirects without forwarding authorization or the pairing credential", () =>
  Effect.gen(function* () {
    const destination = yield* fixture();
    const remote = yield* fixture({ status: 307, redirect: destination.httpBaseUrl });
    const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
    const discovered = yield* service.descriptor(remote).pipe(Effect.flip);
    const paired = yield* service
      .exchangePairing({ ...remote, credential: "private-secret" })
      .pipe(Effect.flip);
    const connected = yield* service
      .connect({ ...remote, environmentId, bearerToken: "private-secret" })
      .pipe(Effect.flip);
    expect([discovered.reason, paired.reason, connected.reason]).toEqual([
      "invalid_response",
      "invalid_response",
      "invalid_response",
    ]);
    expect(destination.requests).toEqual([]);
    expect(destination.upgrades).toEqual([]);
  }).pipe(Effect.provide(RemoteEnvironmentClient.layer)),
);

it.live("maps auth rejection and invalid HTTP responses to safe tagged errors", () =>
  Effect.gen(function* () {
    const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
    for (const status of [401, 403, 500]) {
      const remote = yield* fixture({ status, body: { error: "private-secret" } });
      const error = yield* service
        .connect({ ...remote, environmentId, bearerToken: "private-secret" })
        .pipe(Effect.flip);
      expect(error.reason).toBe(status === 500 ? "unavailable" : "unauthorized");
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain("private-secret");
      expect(remote.upgrades).toEqual([]);
    }
    const invalid = yield* fixture({ body: { ticket: 1 } });
    expect((yield* service.descriptor(invalid).pipe(Effect.flip)).reason).toBe("invalid_response");
    expect(
      (yield* service.exchangePairing({ ...invalid, credential: "secret" }).pipe(Effect.flip))
        .reason,
    ).toBe("invalid_response");
    expect(
      (yield* service
        .connect({ ...invalid, environmentId, bearerToken: "secret" })
        .pipe(Effect.flip)).reason,
    ).toBe("invalid_response");
  }).pipe(Effect.provide(RemoteEnvironmentClient.layer)),
);

it.effect("rejects invalid base addresses before any network operation", () =>
  Effect.gen(function* () {
    const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
    for (const httpBaseUrl of [
      "not a URL",
      "ftp://example.test",
      "ws://example.test",
      "https://user:secret@example.test",
      "https://example.test?token=secret",
      "https://example.test#secret",
      "https://example.test?",
      "https://example.test#",
    ]) {
      const error = yield* service.descriptor({ httpBaseUrl }).pipe(Effect.flip);
      expect(error.reason).toBe("invalid_response");
      expect(JSON.stringify(error)).not.toContain(httpBaseUrl);
    }
  }).pipe(Effect.provide(RemoteEnvironmentClient.layer)),
);

it.effect("bounds stalled HTTP requests and aborts the underlying fetch", () => {
  const started = Promise.withResolvers<void>();
  let aborted = false;
  const fetch: typeof globalThis.fetch = (_url, init) => {
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("fixture aborted"));
      });
    });
  };
  return Effect.gen(function* () {
    const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
    const pending = yield* service
      .descriptor({ httpBaseUrl: "https://example.test" })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    yield* TestClock.adjust("10 seconds");
    expect((yield* Fiber.join(pending).pipe(Effect.flip)).reason).toBe("unavailable");
    expect(aborted).toBe(true);
  }).pipe(
    Effect.provide(RemoteEnvironmentClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
});

it.effect("uses explicit HTTPS and Tailscale HTTP origins without inferring host endpoints", () => {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify(descriptor), {
      headers: { "content-type": "application/json" },
    });
  };
  return Effect.gen(function* () {
    const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
    yield* service.descriptor({ httpBaseUrl: "https://remote.example:8443/path" });
    yield* service.descriptor({ httpBaseUrl: "http://box.tailnet.ts.net:3773/path" });
    expect(urls).toEqual([
      "https://remote.example:8443/.well-known/t3/environment",
      "http://box.tailnet.ts.net:3773/.well-known/t3/environment",
    ]);
  }).pipe(
    Effect.provide(RemoteEnvironmentClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
});

it.effect("bounds config acquisition and closes a connected but unresponsive socket", () =>
  Effect.gen(function* () {
    const remote = yield* fixture({ socket: "stall" });
    const service = yield* RemoteEnvironmentClient.RemoteEnvironmentClient;
    const pending = yield* service
      .connect({
        environmentId,
        httpBaseUrl: remote.httpBaseUrl,
        bearerToken: "private-token",
      })
      .pipe(Effect.forkChild);
    yield* remote.awaitConfigRequested;
    yield* TestClock.adjust("10 seconds");
    expect((yield* Fiber.join(pending).pipe(Effect.flip)).reason).toBe("unavailable");
    yield* remote.awaitClosed;
    expect(remote.upgrades).toHaveLength(1);
  }).pipe(Effect.provide(RemoteEnvironmentClient.layer)),
);
