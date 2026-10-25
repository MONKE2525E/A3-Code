import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  type EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ServerConfig,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

export class RemoteEnvironmentError extends Schema.TaggedError<RemoteEnvironmentError>()(
  "RemoteEnvironmentError",
  {
    reason: Schema.Literals([
      "unavailable",
      "unauthorized",
      "identity_mismatch",
      "invalid_response",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Remote environment is unavailable.";
      case "unauthorized":
        return "Remote environment authorization failed.";
      case "identity_mismatch":
        return "Remote environment identity does not match.";
      case "invalid_response":
        return "Remote environment address or response is invalid.";
    }
  }
}

const decodeDescriptor = Schema.decodeUnknownEffect(
  Schema.toCodecJson(ExecutionEnvironmentDescriptor),
);
const decodeAccessToken = Schema.decodeUnknownEffect(Schema.toCodecJson(AuthAccessTokenResult));
const decodeTicket = Schema.decodeUnknownEffect(Schema.toCodecJson(AuthWebSocketTicketResult));

const makeRpcClient = RpcClient.make(WsRpcGroup);
export type RemoteEnvironmentRpcClient = Effect.Success<typeof makeRpcClient>;

export class RemoteEnvironmentClient extends Context.Service<
  RemoteEnvironmentClient,
  {
    readonly descriptor: (input: {
      readonly httpBaseUrl: string;
    }) => Effect.Effect<ExecutionEnvironmentDescriptor, RemoteEnvironmentError>;
    readonly exchangePairing: (input: {
      readonly httpBaseUrl: string;
      readonly credential: string;
    }) => Effect.Effect<
      { readonly accessToken: string; readonly expiresInSeconds: number },
      RemoteEnvironmentError
    >;
    readonly connect: (input: {
      readonly environmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
    }) => Effect.Effect<
      {
        readonly client: RemoteEnvironmentRpcClient;
        readonly config: ServerConfig;
      },
      RemoteEnvironmentError,
      Scope.Scope
    >;
  }
>()("t3/remoteOrchestration/RemoteEnvironmentClient") {}

const endpoint = (base: string, path: string) =>
  Effect.try({
    try: () => {
      const url = new URL(base);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        base.includes("?") ||
        base.includes("#")
      ) {
        throw new Error("Invalid base URL");
      }
      // Match environmentEndpointUrl: official endpoints are rooted at the origin.
      url.pathname = path;
      return url;
    },
    catch: () => new RemoteEnvironmentError({ reason: "invalid_response" }),
  });

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const request = Effect.fn("RemoteEnvironmentClient.request")(
    function* (input: HttpClientRequest.HttpClientRequest) {
      const response = yield* http.execute(input).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.mapError(() => new RemoteEnvironmentError({ reason: "unavailable" })),
      );
      if (response.status === 401 || response.status === 403) {
        return yield* new RemoteEnvironmentError({ reason: "unauthorized" });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new RemoteEnvironmentError({
          reason: response.status >= 500 ? "unavailable" : "invalid_response",
        });
      }
      return yield* response.json.pipe(
        Effect.mapError(() => new RemoteEnvironmentError({ reason: "invalid_response" })),
      );
    },
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new RemoteEnvironmentError({ reason: "unavailable" })),
    }),
  );

  const descriptor = Effect.fn("RemoteEnvironmentClient.descriptor")(function* (input: {
    readonly httpBaseUrl: string;
  }) {
    const url = yield* endpoint(input.httpBaseUrl, "/.well-known/t3/environment");
    const body = yield* request(HttpClientRequest.get(url.toString()));
    return yield* decodeDescriptor(body).pipe(
      Effect.mapError(() => new RemoteEnvironmentError({ reason: "invalid_response" })),
    );
  });

  const exchangePairing = Effect.fn("RemoteEnvironmentClient.exchangePairing")(function* (input: {
    readonly httpBaseUrl: string;
    readonly credential: string;
  }) {
    const url = yield* endpoint(input.httpBaseUrl, "/oauth/token");
    const body = yield* request(
      HttpClientRequest.post(url.toString()).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: input.credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      ),
    );
    const token = yield* decodeAccessToken(body).pipe(
      Effect.mapError(() => new RemoteEnvironmentError({ reason: "invalid_response" })),
    );
    if (token.token_type !== "Bearer") {
      return yield* new RemoteEnvironmentError({ reason: "invalid_response" });
    }
    if (!token.scope.split(/\s+/).includes(AuthOrchestrationOperateScope)) {
      return yield* new RemoteEnvironmentError({ reason: "unauthorized" });
    }
    return { accessToken: token.access_token, expiresInSeconds: token.expires_in };
  });

  const connect = Effect.fn("RemoteEnvironmentClient.connect")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
  }) {
    const url = yield* endpoint(input.httpBaseUrl, "/api/auth/websocket-ticket");
    const body = yield* request(
      HttpClientRequest.post(url.toString()).pipe(HttpClientRequest.bearerToken(input.bearerToken)),
    );
    const ticket = yield* decodeTicket(body).pipe(
      Effect.mapError(() => new RemoteEnvironmentError({ reason: "invalid_response" })),
    );
    url.pathname = "/ws";
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    const scope = yield* Scope.fork(yield* Effect.scope);
    const protocol = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(url.toString(), { openTimeout: "10 seconds" }).pipe(
            Layer.provide(NodeSocket.layerWebSocketConstructor),
          ),
          RpcSerialization.layerJson,
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(protocol, scope);
      const client = yield* makeRpcClient.pipe(Effect.provide(context), Scope.provide(scope));
      const config = yield* client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(
          (error) =>
            new RemoteEnvironmentError({
              reason:
                error._tag === "EnvironmentAuthorizationError"
                  ? "unauthorized"
                  : error._tag === "RpcClientError" && error.reason._tag === "RpcClientDefect"
                    ? "invalid_response"
                    : "unavailable",
            }),
        ),
        // Native RPC decoding reports malformed remote payloads as defects.
        Effect.catchDefect(() =>
          Effect.fail(new RemoteEnvironmentError({ reason: "invalid_response" })),
        ),
      );
      if (config.environment.environmentId !== input.environmentId) {
        return yield* new RemoteEnvironmentError({ reason: "identity_mismatch" });
      }
      return { client, config };
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new RemoteEnvironmentError({ reason: "unavailable" })),
      }),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void)),
    );
  });
  return RemoteEnvironmentClient.of({ descriptor, exchangePairing, connect });
});

export const layer = Layer.effect(RemoteEnvironmentClient, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
