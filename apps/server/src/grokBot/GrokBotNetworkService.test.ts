import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as Native from "./GrokBotNativeService.ts";
import * as Network from "./GrokBotNetworkService.ts";

it.effect("observed sign-out stops routing and does not enable it again on sign-in", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    let signedIn = true;
    const native = Layer.mock(Native.GrokBotNativeService)({
      accountBinding: Effect.suspend(() =>
        signedIn ? Effect.succeed("account") : Effect.fail(new Native.NativeSignedOutError({})),
      ),
      egressConnection: () => Effect.never,
    });
    yield* Effect.gen(function* () {
      const service = yield* Network.GrokBotNetworkService;
      yield* service.set(true);
      signedIn = false;
      assert.strictEqual((yield* service.read()).state, "off");
      signedIn = true;
      assert.strictEqual((yield* service.read()).enabled, false);
      const config = yield* Config.ServerConfig;
      assert.strictEqual(
        JSON.parse(yield* fs.readFileString(`${config.stateDir}/grokbot-network.json`)).enabled,
        false,
      );
    }).pipe(
      Effect.provide(
        Network.layer.pipe(Layer.provide(native), Layer.provideMerge(Config.layerTest(root, root))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "disabled routing does not read the account and can stop a pending connection after sign-out",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const started = yield* Deferred.make<void>();
      let signedIn = true;
      let accountReads = 0;
      const native = Layer.mock(Native.GrokBotNativeService)({
        accountBinding: Effect.suspend(() => {
          accountReads++;
          return signedIn
            ? Effect.succeed("account")
            : Effect.fail(new Native.NativeReadError({ stage: "session" }));
        }),
        egressConnection: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.gen(function* () {
        const service = yield* Network.GrokBotNetworkService;
        assert.strictEqual((yield* service.read()).state, "off");
        assert.strictEqual(accountReads, 0);
        yield* service.set(true);
        yield* Deferred.await(started);
        signedIn = false;
        assert.strictEqual((yield* service.set(false)).state, "off");
        assert.strictEqual((yield* service.read()).enabled, false);
      }).pipe(
        Effect.provide(
          Network.layer.pipe(Layer.provide(native), Layer.provide(Config.layerTest(root, root))),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("an account change persists routing off instead of silently resuming later", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    let binding = "first";
    const native = Layer.mock(Native.GrokBotNativeService)({
      accountBinding: Effect.sync(() => binding),
      egressConnection: () => Effect.never,
    });
    yield* Effect.gen(function* () {
      const service = yield* Network.GrokBotNetworkService;
      yield* service.set(true);
      binding = "second";
      assert.strictEqual((yield* service.read()).enabled, false);
      binding = "first";
      assert.strictEqual((yield* service.read()).state, "off");
      const config = yield* Config.ServerConfig;
      const saved = JSON.parse(yield* fs.readFileString(`${config.stateDir}/grokbot-network.json`));
      assert.strictEqual(saved.enabled, false);
    }).pipe(
      Effect.provide(
        Network.layer.pipe(Layer.provide(native), Layer.provideMerge(Config.layerTest(root, root))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
