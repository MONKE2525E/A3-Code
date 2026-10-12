import { describe, expect, it } from "@effect/vitest";
import { grokBotUsageLimits } from "./grokBotUsageLimits.ts";

const checkedAt = "2026-10-10T00:00:00.000Z";

describe("native Grok Bot weekly allowance", () => {
  it("maps the official percent and protobuf timestamp to a weekly quota", () => {
    expect(
      grokBotUsageLimits(
        { usagePercent: 12.75, nextResetTimestampUtc: "2026-10-12T12:30:00Z" },
        checkedAt,
      ),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 12.75,
          resetsAt: "2026-10-12T12:30:00.000Z",
        },
      ],
    });
  });
  it("does not invent quota for absent percentages or pooled enterprise accounts", () => {
    for (const status of [{}, { usagePercent: 40, usesPooledEnterpriseAllowance: true }]) {
      const limits = grokBotUsageLimits(status, checkedAt);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }
  });
  it("clamps native overflow and omits invalid reset times", () => {
    expect(
      grokBotUsageLimits({ usagePercent: 125, nextResetTimestampUtc: "bad" }, checkedAt).windows[0],
    ).toEqual({ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 });
    expect(grokBotUsageLimits({ usagePercent: -5 }, checkedAt).windows[0]?.usedPercent).toBe(0);
  });
  it("rejects malformed percentages rather than presenting zero usage", () => {
    for (const usagePercent of ["40", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => grokBotUsageLimits({ usagePercent }, checkedAt)).toThrow();
    }
  });
});
