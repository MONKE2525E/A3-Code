import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import {
  MuseAgentUsageStore,
  MuseUsageFile,
  MUSE_USAGE_FILE,
  layer,
} from "./MuseAgentUsageStore.ts";

it.effect("persists account-bound estimates without counting repeated observations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "muse-usage-" });
    const configLayer = ServerConfig.layerTest(process.cwd(), dir);
    const context = yield* Layer.build(layer.pipe(Layer.provide(configLayer)));
    const store = Context.get(context, MuseAgentUsageStore);
    const now = 1_800_000_000_000;
    const subscription = {
      tier: { name: "Muse Free" },
      usage: { state: "METERED", percentUsed: 10, resetsAt: (now + 3_600_000) / 1000 },
      topupBalance: 100,
      topupTotal: 100,
      topupRowValueLabel: "2,500 tokens left",
    };
    yield* TestClock.setTime(now);
    yield* store.observe("account-a", subscription);
    yield* TestClock.adjust("30 minutes");
    yield* store.observe("account-a", { ...subscription, topupTotal: null });
    yield* TestClock.adjust("30 minutes");
    yield* store.observe("account-a", {
      ...subscription,
      usage: {
        ...subscription.usage,
        percentUsed: 20,
        resetsAt: (now + 7 * 24 * 3_600_000) / 1000,
      },
      topupBalance: 0,
      topupRowValueLabel: "0 tokens left",
    });
    const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
    const read = fs
      .readFileString(path.join(config.stateDir, MUSE_USAGE_FILE))
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(MuseUsageFile))));
    const before = yield* read;
    assert.strictEqual(before.binding, "account-a");
    assert.strictEqual(
      before.hours.reduce((sum, entry) => sum + entry.tokens, 0),
      30_002_500,
    );
    yield* store.observe("account-a", subscription);
    assert.deepStrictEqual(yield* read, before);
    yield* store.observe("account-b", {
      ...subscription,
      usage: { ...subscription.usage, resetsAt: (now + 3_600_000 * 2) / 1000 },
      topupBalance: 50,
      topupRowValueLabel: "1,250 tokens left",
    });
    const firstBonus = yield* read;
    assert.strictEqual(firstBonus.binding, "account-b");
    assert.strictEqual(
      firstBonus.hours.reduce((sum, entry) => sum + entry.tokens, 0),
      10_001_250,
    );
    yield* TestClock.adjust("1 hour");
    yield* store.observe("account-c", {
      ...subscription,
      usage: { ...subscription.usage, resetsAt: (now + 3_600_000 * 3) / 1000 },
      topupBalance: 10,
      topupTotal: null,
    });
    const partialBonus = yield* read;
    assert.strictEqual(partialBonus.binding, "account-c");
    assert.strictEqual(partialBonus.observation.bonusKnown, false);
    assert.strictEqual(
      partialBonus.hours.reduce((sum, entry) => sum + entry.tokens, 0),
      10_000_000,
    );
    yield* store.observe("account-d", {
      ...subscription,
      usage: { ...subscription.usage, resetsAt: (now + 3_600_000 * 3) / 1000 },
      topupBalance: 50,
      topupRowValueLabel: null,
    });
    yield* TestClock.adjust("30 minutes");
    yield* store.observe("account-d", {
      ...subscription,
      usage: { ...subscription.usage, resetsAt: (now + 3_600_000 * 3) / 1000 },
      topupBalance: 50,
      topupRowValueLabel: "1,250 tokens left",
    });
    const recoveredBonus = yield* read;
    assert.strictEqual(
      recoveredBonus.hours.reduce((sum, entry) => sum + entry.tokens, 0),
      10_001_250,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
