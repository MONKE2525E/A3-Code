import { describe, expect, it } from "@effect/vitest";
import { museAgentUsageLimits } from "./MuseAgentUsage.ts";

describe("Muse account limits", () => {
  it("shows the weekly allowance and the non-expiring additional balance", () => {
    expect(
      museAgentUsageLimits(
        {
          tier: { name: "Muse Free" },
          usage: { state: "METERED", percentUsed: 25, resetsAt: 1793413479 },
          topupBalance: 120,
          topupTotal: 160,
        },
        "2026-10-26T00:00:00.000Z",
      ),
    ).toEqual({
      checkedAt: "2026-10-26T00:00:00.000Z",
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 25,
          resetsAt: "2026-10-31T02:24:39.000Z",
        },
        { id: "additional", kind: "other", label: "Additional tokens", usedPercent: 25 },
      ],
    });
  });
  it("does not invent a quota for an unknown usage state", () => {
    const result = museAgentUsageLimits(
      { tier: { name: "Muse Free" }, usage: { state: "UNKNOWN" } },
      "2026-10-26T00:00:00.000Z",
    );
    expect(result.windows).toEqual([]);
    expect(result.unavailable?.reason).toBe("unsupported");
  });
  it("does not report a fabricated additional balance when the total is absent", () => {
    const result = museAgentUsageLimits(
      {
        tier: { name: "Muse Free" },
        usage: { state: "METERED", percentUsed: 0 },
        topupBalance: 10,
      },
      "2026-10-26T00:00:00.000Z",
    );
    expect(result.windows).toEqual([
      { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 0 },
    ]);
  });
});
