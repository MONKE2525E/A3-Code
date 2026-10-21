import { describe, expect, it } from "vite-plus/test";
import { describeComputerUpgradeSchedule } from "./GrokBotComputerMaintenance";

describe("describeComputerUpgradeSchedule", () => {
  it("says so when nothing is scheduled", () => {
    expect(describeComputerUpgradeSchedule(null)).toBe("No upgrade is scheduled.");
  });

  it("reports the native schedule fields without inventing any", () => {
    const text = describeComputerUpgradeSchedule({
      localTime: "03:00",
      timezone: "UTC",
      targetImageTag: "2026.10",
      state: "pending",
      failureReason: "image pull timed out",
    });
    expect(text).toContain("Runs at 03:00 UTC");
    expect(text).toContain("Target image 2026.10");
    expect(text).toContain("State: pending");
    expect(text).toContain("Last attempt failed: image pull timed out");
    expect(text).not.toContain("Next");
  });

  it("falls back to a neutral line when the schedule has no fields", () => {
    expect(describeComputerUpgradeSchedule({})).toBe("An upgrade is scheduled.");
  });
});
