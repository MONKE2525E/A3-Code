import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { NativeReadError } from "../../grokBot/GrokBotNativeService.ts";
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
