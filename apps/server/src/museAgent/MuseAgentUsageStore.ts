import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import { estimateMuseUsage } from "./MuseAgentUsageHistory.ts";
import type { MuseAgentSubscription } from "./MuseAgentUsage.ts";

const Observation = Schema.Struct({
  at: Schema.Number,
  weeklyUsed: Schema.Number,
  reset: Schema.Number,
  weeklyAllowance: Schema.Number,
  bonusBalance: Schema.Number,
  bonusTotal: Schema.Number,
  bonusTokenScale: Schema.Number,
  bonusKnown: Schema.Boolean,
});
export const MuseUsageFile = Schema.Struct({
  binding: Schema.String,
  accountFingerprint: Schema.optionalKey(Schema.String),
  observation: Observation,
  bonusObservation: Schema.optionalKey(Observation),
  hours: Schema.Array(Schema.Struct({ start: Schema.Number, tokens: Schema.Number })),
});
export const MUSE_USAGE_FILE = "muse-agent-usage.json";
const decodeFile = Schema.decodeUnknownSync(Schema.fromJsonString(MuseUsageFile));
const encodeFile = Schema.encodeSync(Schema.fromJsonString(MuseUsageFile));

function observation(subscription: MuseAgentSubscription, at: number) {
  const plan = subscription.tier.name.toLowerCase();
  const weeklyAllowance = plan.includes("maximum")
    ? 3_000_000_000
    : plan.includes("power")
      ? 500_000_000
      : plan.includes("free")
        ? 100_000_000
        : 0;
  const weeklyUsed =
    subscription.usage?.state === "METERED" ? subscription.usage.percentUsed : null;
  const reset = subscription.usage?.resetsAt;
  if (
    !weeklyAllowance ||
    typeof weeklyUsed !== "number" ||
    !Number.isFinite(weeklyUsed) ||
    weeklyUsed < 0 ||
    weeklyUsed > 100 ||
    typeof reset !== "number" ||
    !Number.isFinite(reset) ||
    reset <= 0
  )
    return null;
  const balance = subscription.topupBalance;
  const total = subscription.topupTotal;
  const bonusKnown =
    typeof balance === "number" &&
    typeof total === "number" &&
    Number.isFinite(balance) &&
    Number.isFinite(total) &&
    balance >= 0 &&
    total >= balance;
  if (reset * 1000 <= at || reset * 1000 > at + 7 * 24 * 3_600_000) return null;
  const safeBalance = bonusKnown ? balance : 0;
  const safeTotal = bonusKnown ? total : 0;
  const label = subscription.topupRowValueLabel?.match(/([\d,.]+)\s*([kmb])?\s+tokens?\s+left/i);
  const unit = label?.[2]?.toLowerCase();
  const shown = label
    ? Number(label[1]?.replaceAll(",", "")) *
      (unit === "b" ? 1e9 : unit === "m" ? 1e6 : unit === "k" ? 1e3 : 1)
    : 0;
  const scale = safeBalance > 0 && Number.isFinite(shown) && shown > 0 ? shown / safeBalance : 0;
  return {
    at,
    weeklyUsed,
    reset: reset * 1000,
    weeklyAllowance,
    bonusBalance: safeBalance,
    bonusTotal: safeTotal,
    bonusTokenScale: scale,
    bonusKnown,
  };
}

export class MuseAgentUsageStore extends Context.Service<
  MuseAgentUsageStore,
  {
    readonly observe: (
      binding: string,
      subscription: MuseAgentSubscription,
      accountFingerprint?: string,
    ) => Effect.Effect<void>;
  }
>()("t3/museAgent/MuseAgentUsageStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const filePath = path.join(config.stateDir, MUSE_USAGE_FILE);
  const observe = Effect.fn("MuseAgentUsageStore.observe")(
    function* (binding: string, subscription: MuseAgentSubscription, accountFingerprint?: string) {
      const now = yield* Clock.currentTimeMillis;
      const current = observation(subscription, now);
      if (!current) return;
      const previous = yield* fs.readFileString(filePath).pipe(
        Effect.map(decodeFile),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      const same =
        previous &&
        (previous.accountFingerprint && accountFingerprint
          ? previous.accountFingerprint === accountFingerprint
          : previous.binding === binding)
          ? previous
          : null;
      if (same && current.at <= same.observation.at) return;
      const prior = same?.observation ?? {
        ...current,
        at: Math.max(current.reset - 7 * 24 * 3_600_000, 0),
        weeklyUsed: 0,
      };
      const lastBonus =
        same?.bonusObservation ?? (same?.observation.bonusKnown ? same.observation : undefined);
      const stable =
        current.bonusKnown && lastBonus && lastBonus.bonusTokenScale > 0
          ? { ...current, bonusTokenScale: lastBonus.bonusTokenScale }
          : current;
      const hours = new Map((same?.hours ?? []).map(({ start, tokens }) => [start, tokens]));
      const add = (items: ReturnType<typeof estimateMuseUsage>) => {
        for (const item of items) hours.set(item.start, (hours.get(item.start) ?? 0) + item.tokens);
      };
      add(estimateMuseUsage({ ...prior, bonusKnown: false }, { ...stable, bonusKnown: false }));
      if (current.bonusKnown && lastBonus && lastBonus.bonusTokenScale > 0) {
        add(
          estimateMuseUsage(
            { ...lastBonus, weeklyAllowance: 0 },
            { ...stable, weeklyAllowance: 0 },
          ),
        );
      } else if (current.bonusKnown && stable.bonusTokenScale > 0) {
        const used = Math.round((stable.bonusTotal - stable.bonusBalance) * stable.bonusTokenScale);
        if (used > 0) {
          const hour = Math.floor(now / 3_600_000) * 3_600_000;
          hours.set(hour, (hours.get(hour) ?? 0) + used);
        }
      }
      const cutoff = now - 90 * 24 * 3_600_000;
      const data = {
        binding,
        ...(accountFingerprint ? { accountFingerprint } : {}),
        observation: stable,
        ...(stable.bonusKnown
          ? { bonusObservation: stable }
          : lastBonus
            ? { bonusObservation: lastBonus }
            : {}),
        hours: [...hours]
          .filter(([start]) => start >= cutoff)
          .map(([start, tokens]) => ({ start, tokens })),
      };
      yield* writeFileStringAtomically({ filePath, contents: encodeFile(data) }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
    lock.withPermits(1),
    Effect.ignoreCause({ log: true }),
  );
  return MuseAgentUsageStore.of({ observe });
});

export const layer = Layer.effect(MuseAgentUsageStore, make);
