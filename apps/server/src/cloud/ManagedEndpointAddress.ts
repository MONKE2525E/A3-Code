import { RelayManagedEndpoint, RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  decodeConfirmedOrigin,
  decodeRuntimeConfig,
} from "./config.ts";
import { managedEndpointRuntimeConfigsMatch } from "./linkChecks.ts";

export const CLOUD_MANAGED_ENDPOINT_ADDRESS = "cloud-managed-endpoint-address";
const Address = Schema.Struct({
  endpoint: RelayManagedEndpoint,
  config: RelayManagedEndpointRuntimeConfig,
});
const decodeAddress = Schema.decodeUnknownOption(Schema.fromJsonString(Address));
const encodeAddress = Schema.encodeEffect(Schema.fromJsonString(Address));

export class ManagedEndpointAddressError extends Schema.TaggedError<ManagedEndpointAddressError>()(
  "ManagedEndpointAddressError",
  { stage: Schema.Literals(["read", "write"]) },
) {
  override get message() {
    return "The confirmed T3 Connect endpoint is unavailable.";
  }
}

/** Addresses come from authenticated relay replies, never a cloud tool's parameters. */
export class ManagedEndpointAddress extends Context.Service<
  ManagedEndpointAddress,
  {
    readonly read: Effect.Effect<RelayManagedEndpoint | null, ManagedEndpointAddressError>;
    readonly remember: (
      address: typeof Address.Type,
    ) => Effect.Effect<void, ManagedEndpointAddressError>;
  }
>()("t3/cloud/ManagedEndpointAddress") {}

const publicEndpoint = (endpoint: RelayManagedEndpoint): boolean => {
  try {
    const url = new URL(endpoint.httpBaseUrl);
    return (
      url.protocol === "https:" &&
      !isPrivateNetworkHost(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      ["", "/"].includes(url.pathname)
    );
  } catch {
    return false;
  }
};

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const read = Effect.gen(function* () {
    const [saved, config, confirmed] = yield* Effect.all([
      secrets.get(CLOUD_MANAGED_ENDPOINT_ADDRESS),
      secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      secrets.get(CLOUD_ENDPOINT_CONFIRMED_ORIGIN),
    ]);
    if (Option.isNone(saved) || Option.isNone(config) || Option.isNone(confirmed)) return null;
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const address = decodeAddress(text(saved.value));
    const runtime = decodeRuntimeConfig(text(config.value));
    const origin = decodeConfirmedOrigin(text(confirmed.value));
    if (
      Option.isNone(address) ||
      Option.isNone(runtime) ||
      Option.isNone(origin) ||
      !managedEndpointRuntimeConfigsMatch(address.value.config, runtime.value) ||
      !managedEndpointRuntimeConfigsMatch(origin.value.config, runtime.value) ||
      !publicEndpoint(address.value.endpoint)
    )
      return null;
    return address.value.endpoint;
  }).pipe(Effect.mapError(() => new ManagedEndpointAddressError({ stage: "read" })));
  const remember = Effect.fnUntraced(function* (address: typeof Address.Type) {
    // This codec contains a connector credential. Keep encoding/storage causes out of diagnostics.
    const encoded = yield* encodeAddress(address).pipe(
      Effect.mapError(() => new ManagedEndpointAddressError({ stage: "write" })),
    );
    yield* secrets
      .set(CLOUD_MANAGED_ENDPOINT_ADDRESS, new TextEncoder().encode(encoded))
      .pipe(Effect.mapError(() => new ManagedEndpointAddressError({ stage: "write" })));
  });
  return ManagedEndpointAddress.of({ read, remember });
});

export const layer = Layer.effect(ManagedEndpointAddress, make);
