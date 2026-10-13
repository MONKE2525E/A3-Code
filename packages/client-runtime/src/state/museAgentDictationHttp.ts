import {
  WS_METHODS,
  MuseAgentDictationRequestError,
  type ProviderInstanceId,
  type MuseAgentDictationLanguage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import type { Atom } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { EnvironmentHttpConnectionNotReadyError } from "./pullRequests.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export interface MuseAgentDictationInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly pcm: Uint8Array;
  readonly language?: MuseAgentDictationLanguage;
}

const isDictationRequestError = Schema.is(MuseAgentDictationRequestError);

export const transcribeEnvironmentMuseAudio = Effect.fn(
  "clientRuntime.state.transcribeEnvironmentMuseAudio",
)(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly recording: MuseAgentDictationInput;
    readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization?: Option.Option<
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
    >;
  }) {
    const params = { providerInstanceId: input.recording.providerInstanceId };
    const query = input.recording.language ? { language: input.recording.language } : {};
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "museAgentDictation",
      method: "POST",
      timeoutMs: 45_000,
      url: (urls) => urls.transcribe({ params, query }),
      request: ({ client, headers }) =>
        client.transcribe({ params, query, payload: input.recording.pcm, headers }),
    });
  },
  Effect.catchTags({
    RemoteEnvironmentAuthFetchError: (error) =>
      Effect.fail(isDictationRequestError(error.cause) ? error.cause : error),
  }),
);

export class MuseAgentDictationClient extends Context.Service<
  MuseAgentDictationClient,
  {
    readonly transcribe: (
      prepared: PreparedConnection,
      recording: MuseAgentDictationInput,
    ) => Effect.Effect<
      { readonly text: string },
      RemoteEnvironmentRequestError | MuseAgentDictationRequestError
    >;
  }
>()("@t3tools/client-runtime/state/museAgentDictationHttp/MuseAgentDictationClient") {}

export const layer = Layer.effect(
  MuseAgentDictationClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return MuseAgentDictationClient.of({
      transcribe: (prepared, recording) =>
        transcribeEnvironmentMuseAudio({ prepared, recording, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);

/** Binary uploads use the same destination operate grant as native agent mutations. */
export function createMuseAgentDictationCommand<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | MuseAgentDictationClient | R, ER>,
) {
  const permissions = createCommandPermissions(runtime, WS_METHODS.museAgentsFeatureUpdate);
  const command = createEnvironmentCommand(runtime, {
    label: "environment-command:muse-agent:dictation",
    execute: (input: MuseAgentDictationInput, registry, environmentId) =>
      Effect.gen(function* () {
        yield* permissions.authorize(registry, environmentId, input);
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const client = yield* MuseAgentDictationClient;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* new EnvironmentHttpConnectionNotReadyError({
            message: "The environment HTTP connection is not ready.",
          });
        return yield* client.transcribe(prepared.value, input);
      }),
  });
  return {
    ...command,
    requiredScopes: permissions.requiredScopes,
    permissionAtom: permissions.permissionAtom,
  };
}
