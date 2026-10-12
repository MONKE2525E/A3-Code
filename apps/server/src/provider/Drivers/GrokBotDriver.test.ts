import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { NativeReadError, NativeSignedOutError } from "../../grokBot/GrokBotNativeService.ts";
import { GrokBotNativeRuntimeService } from "../../grokBot/GrokBotNativeRuntimeService.ts";
import { GrokBotManagedBinding } from "../../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import {
  makeBindings,
  makeNative,
  makeTurn,
  options,
} from "../../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import { checkGrokBotProvider, GrokBotDriver } from "./GrokBotDriver.ts";

it.effect(
  "publishes native weekly quota and retains provider readiness when its quota probe fails",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      for (const fails of [false, true]) {
        const snapshot = yield* checkGrokBotProvider(options).pipe(
          Effect.provideService(
            GrokBotNativeRuntimeService,
            makeNative({
              accountInfo: () =>
                Effect.succeed({ email: "fixture@example.test", plan: "SuperGrok Heavy" }),
              usageLimits: (binding, checkedAt) => {
                assert.equal(binding, options.config.accountBinding);
                return fails
                  ? Effect.fail(new NativeReadError({ stage: "request", status: 503 }))
                  : Effect.succeed({
                      checkedAt,
                      credentialFingerprint: binding,
                      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 15 }],
                    });
              },
            }),
          ),
          Effect.provideService(GrokBotManagedBinding, makeBindings(turn)),
        );
        assert.equal(snapshot.status, "ready");
        assert.equal(snapshot.auth.status, "authenticated");
        assert.equal(snapshot.auth.email, "fixture@example.test");
        assert.equal(snapshot.auth.label, "SuperGrok Heavy");
        if (fails) assert.equal(snapshot.usageLimits?.unavailable?.reason, "probeFailed");
        else {
          assert.equal(snapshot.usageLimits?.windows[0]?.usedPercent, 15);
          assert.equal(snapshot.usageLimits?.credentialFingerprint, options.config.accountBinding);
        }
      }
    }),
);

it.effect(
  "discovers account-bound bots as durable model IDs and reports the exact readiness gate",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const snapshot = yield* checkGrokBotProvider(options).pipe(
        Effect.provideService(GrokBotNativeRuntimeService, makeNative()),
        Effect.provideService(
          GrokBotManagedBinding,
          makeBindings(turn, {
            availability: Effect.succeed({
              ready: false,
              reason: "native settlement not verified",
            }),
          }),
        ),
      );
      assert.equal(snapshot.models[0]?.slug, "durable-bot-1");
      assert.equal(snapshot.models[0]?.name, "Bot One");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.message, "native settlement not verified");
      assert.equal(GrokBotDriver.metadata.hasDefaultInstance, false);
      assert.equal(GrokBotDriver.metadata.supportsMultipleInstances, false);
    }),
);

it.effect("does not enumerate bots for an unbound, disabled, or switched account", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    for (const config of [
      { ...options, enabled: false },
      { ...options, config: { accountBinding: null } },
      options,
    ]) {
      const snapshot = yield* checkGrokBotProvider(config).pipe(
        Effect.provideService(
          GrokBotNativeRuntimeService,
          makeNative({
            accountBinding: Effect.succeed("b".repeat(64)),
            roster: () => Effect.die("must not list another account"),
          }),
        ),
        Effect.provideService(GrokBotManagedBinding, makeBindings(turn)),
      );
      assert.equal(snapshot.models.length, 0);
      assert.notEqual(snapshot.auth.status, "authenticated");
    }
  }),
);

it.effect("a transient roster outage recovers before publishing an account error", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const attempted = yield* Deferred.make<void>();
    let attempts = 0;
    const native = makeNative({
      roster: (binding) =>
        Effect.gen(function* () {
          attempts++;
          if (attempts === 1) {
            yield* Deferred.succeed(attempted, undefined);
            return yield* new NativeReadError({ stage: "request", status: 503 });
          }
          return yield* makeNative().roster(binding);
        }),
    });
    const fiber = yield* checkGrokBotProvider(options).pipe(
      Effect.provideService(GrokBotNativeRuntimeService, native),
      Effect.provideService(GrokBotManagedBinding, makeBindings(turn)),
      Effect.forkChild,
    );
    yield* Deferred.await(attempted);
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    assert.equal(result.status, "ready");
    assert.equal(result.models[0]?.slug, "durable-bot-1");
    assert.equal(attempts, 2);
  }),
);

it.effect("a persistent roster outage is reported after bounded retries", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const attempted = yield* Deferred.make<void>();
    let attempts = 0;
    const fiber = yield* checkGrokBotProvider(options).pipe(
      Effect.provideService(
        GrokBotNativeRuntimeService,
        makeNative({
          roster: () =>
            Effect.gen(function* () {
              attempts++;
              yield* Deferred.succeed(attempted, undefined);
              return yield* new NativeReadError({ stage: "request", status: 503 });
            }),
        }),
      ),
      Effect.provideService(GrokBotManagedBinding, makeBindings(turn)),
      Effect.forkChild,
    );
    yield* Deferred.await(attempted);
    yield* TestClock.adjust("5 seconds");
    const result = yield* Fiber.join(fiber);
    assert.equal(result.status, "error");
    assert.deepEqual(result.models, []);
    assert.equal(result.message, "Could not refresh Grok Bot status. Try again shortly.");
    assert.equal(attempts, 6);
  }),
);

it.effect("sign-out and rejected credentials are never retried", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    for (const error of [
      new NativeReadError({ stage: "request", status: 401 }),
      new NativeSignedOutError({}),
    ]) {
      let attempts = 0;
      const result = yield* checkGrokBotProvider(options).pipe(
        Effect.provideService(
          GrokBotNativeRuntimeService,
          makeNative({
            roster: () =>
              Effect.sync(() => {
                attempts++;
              }).pipe(Effect.andThen(Effect.fail(error))),
          }),
        ),
        Effect.provideService(GrokBotManagedBinding, makeBindings(turn)),
      );
      assert.equal(result.status, "error");
      assert.equal(attempts, 1);
    }
  }),
);
