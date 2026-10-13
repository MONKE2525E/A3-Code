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

export interface MuseAgentComputerPreviewReference {
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: string;
  readonly taskId: string;
}

export type MuseAgentComputerPreviewLoadResult =
  | { readonly _tag: "Available"; readonly bytes: Uint8Array; readonly contentType: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unavailable" };

const previewMediaTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Fetch the selected environment's current native preview without exposing Muse URLs. */
export const fetchEnvironmentMuseAgentComputerPreview = Effect.fn(
  "clientRuntime.state.fetchEnvironmentMuseAgentComputerPreview",
)(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly reference: MuseAgentComputerPreviewReference;
    readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization?: Option.Option<
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
    >;
    readonly timeoutMs?: number;
  }): Effect.fn.Return<
    MuseAgentComputerPreviewLoadResult,
    RemoteEnvironmentRequestError,
    HttpClient.HttpClient
  > {
    const params = input.reference;
    const [bytes, response] = yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "museAgentComputerPreview",
      method: "GET",
      timeoutMs: input.timeoutMs ?? 30_000,
      url: (urls) => urls.media({ params }),
      request: ({ client, headers }) =>
        client.media({ params, headers, responseMode: "decoded-and-response" }),
    });
    const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (
      !previewMediaTypes.has(contentType) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > 20 * 1024 * 1024
    )
      return { _tag: "Unavailable" };
    return { _tag: "Available", bytes, contentType };
  },
  Effect.catchTags({
    EnvironmentResourceNotFoundError: () =>
      Effect.succeed<MuseAgentComputerPreviewLoadResult>({ _tag: "Missing" }),
    EnvironmentInternalError: () =>
      Effect.succeed<MuseAgentComputerPreviewLoadResult>({ _tag: "Unavailable" }),
    RemoteEnvironmentAuthUndeclaredStatusError: (error) =>
      error.status === 404
        ? Effect.succeed<MuseAgentComputerPreviewLoadResult>({ _tag: "Missing" })
        : Effect.fail(error),
  }),
);

export class MuseAgentComputerPreviewLoader extends Context.Service<
  MuseAgentComputerPreviewLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      reference: MuseAgentComputerPreviewReference,
    ) => Effect.Effect<MuseAgentComputerPreviewLoadResult, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/museAgentComputerPreviewHttp/MuseAgentComputerPreviewLoader") {}

export const layer = Layer.effect(
  MuseAgentComputerPreviewLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return MuseAgentComputerPreviewLoader.of({
      load: (prepared, reference) =>
        fetchEnvironmentMuseAgentComputerPreview({
          prepared,
          reference,
          signer,
          remoteAuthorization,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
    });
  }),
);
