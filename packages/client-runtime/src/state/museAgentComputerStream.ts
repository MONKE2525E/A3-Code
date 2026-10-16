import { WS_METHODS, type ProviderInstanceId } from "@t3tools/contracts";
import { museAgentComputerStreamPath } from "@t3tools/contracts/museAgentComputer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import type { Atom } from "effect/reactivity";

import * as RemoteAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Supervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { EnvironmentHttpConnectionNotReadyError } from "./pullRequests.ts";
import { createEnvironmentCommand } from "./runtime.ts";

export interface MuseAgentComputerStreamReference {
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: string;
  readonly taskId: string;
  readonly takeoverId: string;
}

/** Each viewer gets a fresh ticket. The primary RPC socket's single-use ticket is never reused. */
export const prepareMuseAgentComputerStream = Effect.fn(
  "clientRuntime.state.prepareMuseAgentComputerStream",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly reference: MuseAgentComputerStreamReference;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
}) {
  const [credential, response] = yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "auth",
    method: "POST",
    timeoutMs: 30_000,
    url: (urls) => urls.webSocketTicket(),
    request: ({ client, headers }) =>
      client.webSocketTicket({ headers, responseMode: "decoded-and-response" }),
  });
  // A relay request may refresh onto a newly resolved origin; use the actual authorized request.
  const url = new URL(museAgentComputerStreamPath(input.reference), response.request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("takeoverId", input.reference.takeoverId);
  url.searchParams.set("wsTicket", credential.ticket);
  return { socketUrl: url.href };
});

export class MuseAgentComputerStreamClient extends Context.Service<
  MuseAgentComputerStreamClient,
  {
    readonly prepare: (
      prepared: PreparedConnection,
      reference: MuseAgentComputerStreamReference,
    ) => Effect.Effect<{ readonly socketUrl: string }, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/museAgentComputerStream/MuseAgentComputerStreamClient") {}

export const layer = Layer.effect(
  MuseAgentComputerStreamClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteAuthorization.RemoteEnvironmentAuthorization,
    );
    return MuseAgentComputerStreamClient.of({
      prepare: (prepared, reference) =>
        prepareMuseAgentComputerStream({ prepared, reference, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);

/** The server also checks operate authority and the exact native user-control lease at upgrade. */
export function createMuseAgentComputerStreamCommand<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | MuseAgentComputerStreamClient | R, ER>,
) {
  // These binary HTTP payloads use the fixed Muse chat operate policy, not feature operations.
  const permissions = createCommandPermissions(runtime, WS_METHODS.museAgentsOpenThread);
  const command = createEnvironmentCommand(runtime, {
    label: "environment-command:muse-agent:computer-stream",
    execute: (input: MuseAgentComputerStreamReference, registry, environmentId) =>
      Effect.gen(function* () {
        yield* permissions.authorize(registry, environmentId, input);
        const supervisor = yield* Supervisor.EnvironmentSupervisor;
        const client = yield* MuseAgentComputerStreamClient;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* new EnvironmentHttpConnectionNotReadyError({
            message: "The environment HTTP connection is not ready.",
          });
        return yield* client.prepare(prepared.value, input);
      }),
  });
  return {
    ...command,
    requiredScopes: permissions.requiredScopes,
    permissionAtom: permissions.permissionAtom,
  };
}
