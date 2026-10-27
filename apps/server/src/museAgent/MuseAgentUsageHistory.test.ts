import { describe, expect, it } from "@effect/vitest";
import { estimateMuseUsage } from "./MuseAgentUsageHistory.ts";

const hour = 3_600_000;
const sample = (at: number, used: number, reset: number, balance = 100, total = 100) => ({
  at,
  weeklyUsed: used,
  reset,
  weeklyAllowance: 100_000_000,
  bonusBalance: balance,
  bonusTotal: total,
  bonusTokenScale: 25,
});

describe("Muse usage estimates", () => {
  it("spreads the observed weekly and bonus consumption over elapsed hours", () => {
    const result = estimateMuseUsage(
      sample(0, 10, 7 * 24 * hour),
      sample(2 * hour, 12, 7 * 24 * hour, 60),
    );
    expect(result.map((entry) => entry.tokens)).toEqual([1_000_500, 1_000_500]);
  });
  it("starts the new weekly period at its reset and never assumes the previous one was exhausted", () => {
    const result = estimateMuseUsage(sample(0, 90, hour), sample(3 * hour, 2, 169 * hour));
    expect(result.map((entry) => [entry.start, entry.tokens])).toEqual([
      [hour, 1_000_000],
      [2 * hour, 1_000_000],
    ]);
  });
  it("does not count bonus grants or a change of plan as consumption", () => {
    const previous = sample(0, 20, 168 * hour);
    const current = { ...sample(hour, 30, 168 * hour, 200, 200), weeklyAllowance: 500_000_000 };
    expect(estimateMuseUsage(previous, current)).toEqual([]);
  });
  it("counts depleted bonus tokens but ignores missing bonus data", () => {
    const previous = sample(0, 0, 168 * hour);
    expect(estimateMuseUsage(previous, sample(hour, 0, 168 * hour, 0))).toEqual([
      { start: 0, tokens: 2_500 },
    ]);
    expect(
      estimateMuseUsage(previous, { ...sample(hour, 0, 168 * hour, 0), bonusKnown: false }),
    ).toEqual([]);
  });
});
