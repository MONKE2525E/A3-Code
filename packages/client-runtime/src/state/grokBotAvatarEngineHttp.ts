import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export type GrokBotAvatarEngineLoadResult =
  | {
      readonly _tag: "Available";
      readonly version: string;
      readonly sha256: string;
      readonly source: string;
    }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unavailable" };

/** Fetch source through the connection's normal auth path before importing a local Blob module. */
export const fetchEnvironmentGrokBotAvatarEngine = Effect.fn(
  "clientRuntime.state.fetchEnvironmentGrokBotAvatarEngine",
)(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization?: Option.Option<
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
    >;
    readonly timeoutMs?: number;
  }): Effect.fn.Return<
    GrokBotAvatarEngineLoadResult,
    RemoteEnvironmentRequestError,
    HttpClient.HttpClient
  > {
    const metadata = yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "grokBotAvatarEngine",
      method: "GET",
      timeoutMs: input.timeoutMs ?? 15_000,
      url: (urls) => urls.metadata(),
      request: ({ client, headers }) => client.metadata({ headers }),
    });
    // Derive the module URL from the digest instead of following arbitrary response URLs.
    const params = { file: `${metadata.sha256}.mjs` };
    const source = yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "grokBotAvatarEngine",
      method: "GET",
      timeoutMs: input.timeoutMs ?? 15_000,
      url: (urls) => urls.module({ params }),
      request: ({ client, headers }) => client.module({ params, headers }),
    });
    return { _tag: "Available", version: metadata.version, sha256: metadata.sha256, source };
  },
  Effect.catchTags({
    EnvironmentResourceNotFoundError: (error) =>
      error.reason === "grok_bot_avatar_engine_not_found"
        ? Effect.succeed<GrokBotAvatarEngineLoadResult>({ _tag: "Missing" })
        : Effect.fail(error),
    EnvironmentInternalError: (error) =>
      error.reason === "grok_bot_avatar_engine_unavailable"
        ? Effect.succeed<GrokBotAvatarEngineLoadResult>({ _tag: "Unavailable" })
        : Effect.fail(error),
    // Older environments do not expose the optional local asset route.
    RemoteEnvironmentAuthUndeclaredStatusError: (error) =>
      error.status === 404
        ? Effect.succeed<GrokBotAvatarEngineLoadResult>({ _tag: "Missing" })
        : Effect.fail(error),
  }),
);

export class GrokBotAvatarEngineLoader extends Context.Service<
  GrokBotAvatarEngineLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
    ) => Effect.Effect<GrokBotAvatarEngineLoadResult, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/grokBotAvatarEngineHttp/GrokBotAvatarEngineLoader") {}

export const layer = Layer.effect(
  GrokBotAvatarEngineLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return GrokBotAvatarEngineLoader.of({
      load: (prepared) =>
        fetchEnvironmentGrokBotAvatarEngine({ prepared, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
