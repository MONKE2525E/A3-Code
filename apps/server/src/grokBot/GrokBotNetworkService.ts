import { GrokBotComputerError, GrokBotNetworkState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Config from "../config.ts";
import * as Native from "./GrokBotNativeService.ts";
import {
  intersectEgressPolicies,
  startEgressClient,
  type EgressPolicy,
} from "./GrokBotEgressClient.ts";

const Saved = Schema.Struct({ enabled: Schema.Boolean, binding: Schema.String });
const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(Saved));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(Saved));
const encodeSignature = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export class GrokBotNetworkService extends Context.Service<
  GrokBotNetworkService,
  {
    readonly read: () => Effect.Effect<typeof GrokBotNetworkState.Type, GrokBotComputerError>;
    readonly set: (
      enabled: boolean,
    ) => Effect.Effect<typeof GrokBotNetworkState.Type, GrokBotComputerError>;
    /** A prompt may request ownership only for the already opted-in account. Delivery never waits. */
    readonly claimIfEnabled: (binding: string) => Effect.Effect<void>;
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
  const isSignedOut = Schema.is(Native.NativeSignedOutError);
  const reconnects = yield* Queue.sliding<{ transport: number; standby: boolean }>(1);
  const file = path.join(config.stateDir, "grokbot-network.json");
  let saved = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeSaved),
    Effect.orElseSucceed(() => ({ enabled: false, binding: "" })),
  );
  let epoch = 0;
  let client: ReturnType<typeof startEgressClient> | undefined;
  let signature = "";
  let checkedAt = 0;
  let transport = 0;
  let context = "";
  let effectivePolicy: EgressPolicy | undefined;
  let connection:
    | Effect.Success<ReturnType<Native.GrokBotNativeService["Service"]["egressConnection"]>>
    | undefined;
  let allowed = true;
  let pendingClaimAt: number | null = null;
  let claimLifetime = 60_000;
  let reconnectAttempt = 0;
  let attachedAt: number | null = null;
  let reconnectAbort = Deferred.makeUnsafe<void>();
  const ownership = { generation: null as string | null };
  let state: typeof GrokBotNetworkState.Type = {
    enabled: saved.enabled,
    state: saved.enabled ? "connecting" : "off",
    activeStreams: 0,
    relayedStreams: 0,
    error: null,
  };
  const stop = () => {
    transport++;
    Deferred.doneUnsafe(reconnectAbort, Effect.void);
    reconnectAbort = Deferred.makeUnsafe<void>();
    client?.stop();
    client = undefined;
    signature = "";
  };
  const resetContext = () => {
    stop();
    context = "";
    effectivePolicy = undefined;
    connection = undefined;
    ownership.generation = null;
    pendingClaimAt = null;
    reconnectAttempt = 0;
    attachedAt = null;
    allowed = true;
    checkedAt = 0;
  };
  yield* Effect.addFinalizer(() => Effect.sync(stop));
  const account = native.accountBinding.pipe(
    Effect.mapError(() => new GrokBotComputerError({ reason: "account_unavailable" })),
  );
  const freshClaim = () =>
    pendingClaimAt !== null && clock.currentTimeMillisUnsafe() - pendingClaimAt < claimLifetime;
  const start = (mode: "if-free" | "claim" = "if-free") => {
    if (!saved.enabled || !allowed || !connection || !effectivePolicy) return;
    stop();
    const attempt = epoch;
    const attachment = transport;
    attachedAt = null;
    client = startEgressClient({
      ...connection,
      policy: effectivePolicy,
      attachMode: mode,
      ownership,
      now: () => clock.currentTimeMillisUnsafe(),
      opened: () => {
        if (attempt === epoch && attachment === transport && mode === "claim")
          pendingClaimAt = null;
      },
      status: (phase, activeStreams, relayedStreams) => {
        if (attempt !== epoch || attachment !== transport || !saved.enabled) return;
        if (phase === "connected" && attachedAt === null) {
          attachedAt = clock.currentTimeMillisUnsafe();
          if (mode === "claim") pendingClaimAt = null;
        }
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
      disconnected: (phase) => {
        if (attempt !== epoch || attachment !== transport || !saved.enabled) return;
        if (
          phase === "standby" ||
          (attachedAt !== null && clock.currentTimeMillisUnsafe() - attachedAt >= 60_000)
        )
          reconnectAttempt = 0;
        if (phase === "standby") pendingClaimAt = null;
        Queue.offerUnsafe(reconnects, { transport: attachment, standby: phase === "standby" });
      },
    });
  };
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
        const value = { ...saved, enabled: false };
        yield* persist(value);
        epoch++;
        resetContext();
        saved = value;
        state = { enabled: false, state: "off", activeStreams: 0, relayedStreams: 0, error: null };
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
        const refreshed = yield* native.egressConnection(binding);
        const verifiedAccount = yield* account;
        if (attempt !== epoch || !saved.enabled || verifiedAccount !== binding) return;
        allowed = refreshed.allowed;
        if (!allowed) {
          if (attempt === epoch) {
            stop();
            pendingClaimAt = null;
            state = {
              ...state,
              state: "error",
              activeStreams: 0,
              error: "Your GrokBot team does not allow routing through a local computer.",
            };
          }
          return;
        }
        // Credentials rotate within a box connection; they do not authorize policy expansion.
        const nextContext = encodeSignature({
          binding,
          url: refreshed.url,
          clientId: refreshed.clientId,
        });
        if (context !== nextContext) {
          effectivePolicy = undefined;
          ownership.generation = null;
          reconnectAttempt = 0;
          if (context !== "") pendingClaimAt = null;
          context = nextContext;
        }
        effectivePolicy =
          effectivePolicy === undefined
            ? refreshed.policy
            : intersectEgressPolicies(effectivePolicy, refreshed.policy);
        connection = refreshed;
        const next = encodeSignature({ ...refreshed, policy: effectivePolicy });
        checkedAt = clock.currentTimeMillisUnsafe();
        // Recovery has its own backoff. A policy refresh must not interrupt standby/retry timing.
        if (next === signature && client) return;
        start(freshClaim() ? "claim" : "if-free");
        signature = next;
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
            connection = undefined;
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
  yield* Effect.gen(function* () {
    while (true) {
      const retry = yield* Queue.take(reconnects);
      if (retry.transport !== transport || !saved.enabled) continue;
      const attempt = epoch;
      reconnectAttempt++;
      yield* Deferred.await(reconnectAbort).pipe(
        Effect.timeoutOrElse({
          duration: retry.standby
            ? 45_000
            : Math.min(30_000, 2_000 * 2 ** Math.min(reconnectAttempt - 1, 4)),
          orElse: () => Effect.void,
        }),
      );
      if (attempt !== epoch || retry.transport !== transport || !saved.enabled) continue;
      const current = yield* Effect.result(account);
      yield* lock.withPermits(1)(
        Effect.sync(() => {
          if (attempt !== epoch || retry.transport !== transport || !saved.enabled || !connection)
            return;
          if (current._tag === "Failure" || current.success !== saved.binding) {
            stop();
            return;
          }
          // Never recover past the cached-policy retention bound without a successful refresh.
          if (clock.currentTimeMillisUnsafe() - checkedAt >= 60_000) {
            stop();
            connection = undefined;
            return;
          }
          const previousSignature = signature;
          start(freshClaim() ? "claim" : "if-free");
          signature = previousSignature;
        }),
      );
    }
  }).pipe(Effect.forkIn(scope));
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
        yield* persist(value);
        epoch++;
        resetContext();
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
  const claimIfEnabled = Effect.fnUntraced(
    function* (binding: string) {
      if (!saved.enabled || saved.binding !== binding || !allowed) return;
      const attempt = epoch;
      const current = yield* account;
      yield* lock.withPermits(1)(
        Effect.sync(() => {
          if (
            attempt !== epoch ||
            current !== binding ||
            saved.binding !== binding ||
            !saved.enabled ||
            !allowed
          )
            return;
          pendingClaimAt = clock.currentTimeMillisUnsafe();
          claimLifetime = connection && effectivePolicy ? 30_000 : 60_000;
          if (connection && effectivePolicy && state.state !== "connected") {
            const previousSignature = signature;
            start("claim");
            signature = previousSignature;
          }
        }),
      );
    },
    Effect.timeout("2 seconds"),
    Effect.ignoreCause(),
  );
  return GrokBotNetworkService.of({ read, set, claimIfEnabled });
});
export const layer = Layer.effect(GrokBotNetworkService, make);
