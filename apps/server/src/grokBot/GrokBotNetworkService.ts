import { GrokBotComputerError, GrokBotNetworkState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Config from "../config.ts";
import * as Native from "./GrokBotNativeService.ts";
import { startEgressClient } from "./GrokBotEgressClient.ts";

const Saved = Schema.Struct({ enabled: Schema.Boolean, binding: Schema.String });
const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(Saved));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(Saved));
const encodeSignature = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isSignedOut = Schema.is(Native.NativeSignedOutError);
export class GrokBotNetworkService extends Context.Service<
  GrokBotNetworkService,
  {
    readonly read: () => Effect.Effect<typeof GrokBotNetworkState.Type, GrokBotComputerError>;
    readonly set: (
      enabled: boolean,
    ) => Effect.Effect<typeof GrokBotNetworkState.Type, GrokBotComputerError>;
  }
>()("t3/grokBot/GrokBotNetworkService") {}
const make = Effect.gen(function* () {
  const native = yield* Native.GrokBotNativeService;
  const clock = yield* Clock.Clock;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const reconcileLock = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;
  const file = path.join(config.stateDir, "grokbot-network.json");
  let saved = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeSaved),
    Effect.orElseSucceed(() => ({ enabled: false, binding: "" })),
  );
  let epoch = 0;
  let client: ReturnType<typeof startEgressClient> | undefined;
  let signature = "";
  let checkedAt = 0;
  let state: typeof GrokBotNetworkState.Type = {
    enabled: saved.enabled,
    state: saved.enabled ? "connecting" : "off",
    activeStreams: 0,
    relayedStreams: 0,
    error: null,
  };
  const stop = () => {
    client?.stop();
    client = undefined;
    signature = "";
  };
  yield* Effect.addFinalizer(() => Effect.sync(stop));
  const account = native.accountBinding.pipe(
    Effect.mapError(() => new GrokBotComputerError({ reason: "account_unavailable" })),
  );
  const persist = (value: typeof saved) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(file + ".tmp", encodeSaved(value), { mode: 0o600 });
      yield* fs.rename(file + ".tmp", file);
    }).pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
  const disableForAccountChange = (binding: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (saved.binding !== binding || !saved.enabled) return;
        epoch++;
        stop();
        saved = { ...saved, enabled: false };
        state = { enabled: false, state: "off", activeStreams: 0, relayedStreams: 0, error: null };
        yield* persist(saved);
      }),
    );
  const reconcile = reconcileLock.withPermits(1)(
    Effect.suspend(() => {
      const attempt = epoch;
      return Effect.gen(function* () {
        if (!saved.enabled) return;
        const currentAccount = yield* Effect.result(native.accountBinding);
        if (currentAccount._tag === "Failure") {
          if (isSignedOut(currentAccount.failure)) {
            yield* disableForAccountChange(saved.binding);
            return;
          }
          return yield* currentAccount.failure;
        }
        const binding = currentAccount.success;
        if (binding !== saved.binding) {
          yield* disableForAccountChange(saved.binding);
          return;
        }
        const connection = yield* native.egressConnection(binding);
        if (!connection.allowed) {
          if (attempt === epoch) {
            stop();
            state = {
              ...state,
              state: "error",
              activeStreams: 0,
              error: "Your GrokBot team does not allow routing through a local computer.",
            };
          }
          return;
        }
        const policy = connection.policy;
        if (attempt !== epoch || !saved.enabled || (yield* account) !== binding) return;
        // Replace only our client when its credentials or policy change. Native's tunnel remains intact.
        const next = encodeSignature({ connection, policy });
        checkedAt = clock.currentTimeMillisUnsafe();
        if (next === signature && client?.isAlive()) return;
        stop();
        signature = next;
        client = startEgressClient({
          ...connection,
          policy,
          now: () => clock.currentTimeMillisUnsafe(),
          status: (phase, activeStreams, relayedStreams) => {
            if (attempt !== epoch || !saved.enabled) return;
            state = {
              enabled: true,
              state: phase,
              activeStreams,
              relayedStreams,
              error:
                phase === "error"
                  ? "The routing connection is unavailable. T3 will retry while routing is enabled."
                  : null,
            };
          },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (attempt !== epoch) return;
            const error = Cause.squash(cause);
            const transient = Native.isTransientEgressRefreshError(error);
            if (
              transient &&
              client?.isAlive() &&
              clock.currentTimeMillisUnsafe() - checkedAt < 60_000
            ) {
              const current = yield* Effect.result(account);
              if (attempt !== epoch) return;
              if (current._tag === "Success" && current.success === saved.binding) return;
            }
            stop();
            if (saved.enabled)
              state = {
                ...state,
                state: "error",
                activeStreams: 0,
                error: "Could not refresh routing. Check the GrokBot account and cloud computer.",
              };
          }),
        ),
      );
    }),
  );
  // Scoped ownership closes every socket on server shutdown; disabled routing makes no network calls.
  yield* reconcile.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkIn(scope));
  yield* Effect.sync(() => client?.heartbeat()).pipe(
    Effect.repeat(Schedule.spaced("15 seconds")),
    Effect.forkIn(scope),
  );
  const read = Effect.fnUntraced(function* () {
    if (saved.enabled) {
      const current = yield* Effect.result(native.accountBinding);
      if (current._tag === "Failure") {
        if (isSignedOut(current.failure)) yield* disableForAccountChange(saved.binding);
        else return yield* new GrokBotComputerError({ reason: "account_unavailable" });
      } else if (current.success !== saved.binding) {
        yield* disableForAccountChange(saved.binding);
      }
    }
    return state;
  });
  const set = (enabled: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const binding = enabled ? yield* account : saved.binding;
        const value = { enabled, binding };
        if (!enabled) {
          epoch++;
          stop();
          saved = value;
          state = {
            enabled: false,
            state: "off",
            activeStreams: 0,
            relayedStreams: 0,
            error: null,
          };
        }
        yield* persist(value);
        epoch++;
        stop();
        saved = value;
        state = {
          enabled,
          state: enabled ? "connecting" : "off",
          activeStreams: 0,
          relayedStreams: 0,
          error: null,
        };
        // The long connect runs outside the mutation, so switching off remains immediate.
        if (enabled) yield* reconcile.pipe(Effect.forkIn(scope));
        return state;
      }),
    );
  return GrokBotNetworkService.of({ read, set });
});
export const layer = Layer.effect(GrokBotNetworkService, make);
