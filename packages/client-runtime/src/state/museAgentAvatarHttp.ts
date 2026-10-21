import type { ProviderInstanceId } from "@t3tools/contracts";
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

export interface MuseAgentAvatarReference {
  readonly providerInstanceId: ProviderInstanceId;
  readonly variant: string;
  readonly revision?: string;
}

export type MuseAgentAvatarLoadResult =
  | { readonly _tag: "Available"; readonly bytes: Uint8Array; readonly contentType: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unavailable" };

const mediaTypes = new Set([
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
]);

/** Load avatar bytes using the selected environment's cookie, bearer, or relay credentials. */
export const fetchEnvironmentMuseAgentAvatar = Effect.fn(
  "clientRuntime.state.fetchEnvironmentMuseAgentAvatar",
)(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly reference: MuseAgentAvatarReference;
    readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization?: Option.Option<
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
    >;
    readonly timeoutMs?: number;
  }): Effect.fn.Return<
    MuseAgentAvatarLoadResult,
    RemoteEnvironmentRequestError,
    HttpClient.HttpClient
  > {
    const params = {
      providerInstanceId: input.reference.providerInstanceId,
      variant: input.reference.variant,
    };
    const query = input.reference.revision ? { revision: input.reference.revision } : {};
    const [bytes, response] = yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "museAgentAvatar",
      method: "GET",
      timeoutMs: input.timeoutMs ?? 30_000,
      url: (urls) => urls.media({ params, query }),
      request: ({ client, headers }) =>
        client.media({ params, query, headers, responseMode: "decoded-and-response" }),
    });
    const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (
      !mediaTypes.has(contentType) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > 20 * 1024 * 1024
    ) {
      return { _tag: "Unavailable" };
    }
    return { _tag: "Available", bytes, contentType };
  },
  Effect.catchTags({
    EnvironmentResourceNotFoundError: () =>
      Effect.succeed<MuseAgentAvatarLoadResult>({ _tag: "Missing" }),
    EnvironmentInternalError: () =>
      Effect.succeed<MuseAgentAvatarLoadResult>({ _tag: "Unavailable" }),
    RemoteEnvironmentAuthUndeclaredStatusError: (error) =>
      error.status === 404
        ? Effect.succeed<MuseAgentAvatarLoadResult>({ _tag: "Missing" })
        : Effect.fail(error),
  }),
);

export class MuseAgentAvatarLoader extends Context.Service<
  MuseAgentAvatarLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      reference: MuseAgentAvatarReference,
    ) => Effect.Effect<MuseAgentAvatarLoadResult, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/museAgentAvatarHttp/MuseAgentAvatarLoader") {}

export const layer = Layer.effect(
  MuseAgentAvatarLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return MuseAgentAvatarLoader.of({
      load: (prepared, reference) =>
        fetchEnvironmentMuseAgentAvatar({ prepared, reference, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
