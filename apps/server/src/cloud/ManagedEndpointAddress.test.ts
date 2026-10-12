import { expect, it } from "@effect/vitest";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointAddress from "./ManagedEndpointAddress.ts";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  encodeConfirmedOriginJson,
  encodeEndpointRuntimeConfigJson,
} from "./config.ts";

it.effect("uses only a public address confirmed for the current tunnel configuration", () =>
  Effect.gen(function* () {
    const files = new Map<string, Uint8Array>();
    const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(files.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          files.set(name, value);
        }),
    });
    const config: RelayManagedEndpointRuntimeConfig = {
      providerKind: "cloudflare_tunnel",
      connectorToken: "fixture-connector",
      tunnelId: "fixture-tunnel",
    };
    const write = (name: string, text: string) => files.set(name, new TextEncoder().encode(text));
    yield* Effect.gen(function* () {
      const service = yield* ManagedEndpointAddress.ManagedEndpointAddress;
      const remember = (httpBaseUrl: string) =>
        service.remember({
          config,
          endpoint: {
            httpBaseUrl,
            wsBaseUrl: "wss://fixture.example/",
            providerKind: "cloudflare_tunnel",
          },
        });
      yield* remember("https://fixture.example/");
      expect(yield* service.read).toBeNull();
      write(CLOUD_ENDPOINT_RUNTIME_CONFIG, yield* encodeEndpointRuntimeConfigJson(config));
      expect(yield* service.read).toBeNull();
      write(
        CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
        yield* encodeConfirmedOriginJson({
          config,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 43123 },
        }),
      );
      expect((yield* service.read)?.httpBaseUrl).toBe("https://fixture.example/");
      write(
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        yield* encodeEndpointRuntimeConfigJson({
          ...config,
          connectorToken: "replacement-connector",
        }),
      );
      expect(yield* service.read).toBeNull();
      write(CLOUD_ENDPOINT_RUNTIME_CONFIG, yield* encodeEndpointRuntimeConfigJson(config));
      for (const url of [
        "http://fixture.example",
        "https://127.0.0.1",
        "https://fixture.example/path",
        "https://fixture.example/?token=fixture",
      ]) {
        yield* remember(url);
        expect(yield* service.read).toBeNull();
      }
      yield* remember("https://fixture.example/");
      files.delete(CLOUD_ENDPOINT_RUNTIME_CONFIG);
      expect(yield* service.read).toBeNull();
    }).pipe(Effect.provide(ManagedEndpointAddress.layer.pipe(Layer.provide(secrets))));
  }),
);
