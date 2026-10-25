import { EnvironmentId, RuntimeMode } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { RemoteEnvironmentClient } from "./RemoteEnvironmentClient.ts";

export const PeerEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  maxRuntimeMode: RuntimeMode,
});
export type PeerEnvironment = typeof PeerEnvironment.Type;
const PeerEnvironmentsJson = Schema.fromJsonString(Schema.Array(PeerEnvironment));
const decodePeers = Schema.decodeEffect(PeerEnvironmentsJson);
const encodePeers = Schema.encodeEffect(PeerEnvironmentsJson);
export class RemotePeerError extends Schema.TaggedError<RemotePeerError>()("RemotePeerError", {
  reason: Schema.Literals([
    "not_paired",
    "identity_mismatch",
    "invalid_pairing",
    "storage",
    "unavailable",
  ]),
}) {
  override get message() {
    return {
      not_paired: "Destination environment is not paired. Pair it before delegating.",
      identity_mismatch: "Pairing destination does not match the expected environment.",
      invalid_pairing:
        "Pairing failed. Use a fresh direct or tailnet pairing link with orchestration read and operate access.",
      storage: "Unable to persist remote environment configuration.",
      unavailable: "Destination environment is unavailable.",
    }[this.reason];
  }
}
export class PeerEnvironmentRegistry extends Context.Service<
  PeerEnvironmentRegistry,
  {
    readonly list: () => Effect.Effect<readonly PeerEnvironment[], RemotePeerError>;
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<PeerEnvironment & { readonly bearerToken: string }, RemotePeerError>;
    readonly pair: (input: {
      readonly environmentId: EnvironmentId;
      readonly pairingUrl: string;
      readonly maxRuntimeMode: RuntimeMode;
    }) => Effect.Effect<PeerEnvironment, RemotePeerError>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<void, RemotePeerError>;
  }
>()("t3/remoteOrchestration/PeerEnvironmentRegistry") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const remote = yield* RemoteEnvironmentClient;
  const environment = yield* ServerEnvironment;
  const lock = yield* Semaphore.make(1);
  const filename = path.join(config.stateDir, "peer-environments.json");
  const storageError = () => new RemotePeerError({ reason: "storage" });
  const secretName = Effect.fn("PeerEnvironmentRegistry.secretName")(function* (id: EnvironmentId) {
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(id))
      .pipe(Effect.mapError(storageError));
    return `peer-environment-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  });
  const read = Effect.fn("PeerEnvironmentRegistry.read")(function* () {
    if (!(yield* fs.exists(filename).pipe(Effect.mapError(storageError)))) return [];
    const raw = yield* fs.readFileString(filename).pipe(Effect.mapError(storageError));
    return yield* decodePeers(raw).pipe(Effect.mapError(storageError));
  });
  const write = Effect.fn("PeerEnvironmentRegistry.write")(function* (
    peers: readonly PeerEnvironment[],
  ) {
    const contents = yield* encodePeers(peers).pipe(Effect.mapError(storageError));
    yield* writeFileStringAtomically({ filePath: filename, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(storageError),
    );
  });
  return PeerEnvironmentRegistry.of({
    list: () => read(),
    get: Effect.fn("PeerEnvironmentRegistry.get")(function* (id) {
      const peer = (yield* read()).find((peer) => peer.environmentId === id);
      if (!peer) return yield* new RemotePeerError({ reason: "not_paired" });
      const token = yield* secrets.get(yield* secretName(id)).pipe(Effect.mapError(storageError));
      if (Option.isNone(token)) return yield* new RemotePeerError({ reason: "not_paired" });
      return { ...peer, bearerToken: new TextDecoder().decode(token.value) };
    }),
    pair: Effect.fn("PeerEnvironmentRegistry.pair")(function* (input) {
      const localId = yield* environment.getEnvironmentId;
      if (input.environmentId === localId)
        return yield* new RemotePeerError({ reason: "identity_mismatch" });
      const target = yield* Effect.try({
        try: () => resolveRemotePairingTarget({ pairingUrl: input.pairingUrl }),
        catch: () => new RemotePeerError({ reason: "invalid_pairing" }),
      });
      const descriptor = yield* remote
        .descriptor({ httpBaseUrl: target.httpBaseUrl })
        .pipe(Effect.mapError(() => new RemotePeerError({ reason: "unavailable" })));
      // Discover before redeeming a one-time credential: a mistyped destination must not consume it.
      if (descriptor.environmentId !== input.environmentId)
        return yield* new RemotePeerError({ reason: "identity_mismatch" });
      const token = yield* remote
        .exchangePairing({ httpBaseUrl: target.httpBaseUrl, credential: target.credential })
        .pipe(Effect.mapError(() => new RemotePeerError({ reason: "invalid_pairing" })));
      yield* Effect.scoped(
        remote.connect({
          environmentId: input.environmentId,
          httpBaseUrl: target.httpBaseUrl,
          bearerToken: token.accessToken,
        }),
      ).pipe(Effect.mapError(() => new RemotePeerError({ reason: "invalid_pairing" })));
      const peer: PeerEnvironment = {
        environmentId: input.environmentId,
        label: descriptor.label,
        httpBaseUrl: target.httpBaseUrl,
        maxRuntimeMode: input.maxRuntimeMode,
      };
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const peers = yield* read();
          yield* secrets
            .set(
              yield* secretName(input.environmentId),
              new TextEncoder().encode(token.accessToken),
            )
            .pipe(Effect.mapError(storageError));
          yield* write([
            ...peers.filter((peer) => peer.environmentId !== input.environmentId),
            peer,
          ]);
          return peer;
        }),
      );
    }),
    remove: Effect.fn("PeerEnvironmentRegistry.remove")(function* (id) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const peers = yield* read();
          // Remove routing first so an interrupted removal cannot keep an orphan credential usable.
          yield* write(peers.filter((peer) => peer.environmentId !== id));
          yield* secrets.remove(yield* secretName(id)).pipe(Effect.mapError(storageError));
        }),
      );
    }),
  });
});
export const layer = Layer.effect(PeerEnvironmentRegistry, make);
