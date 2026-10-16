import type { MuseAgentTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { classifyMuseRoutine, groupMuseRoutines } from "./museAgentRoutines";

const task = (id: string, scheduleKey: string, isHeartbeat = false): MuseAgentTask => ({
  id,
  scheduleKey,
  isHeartbeat,
});

describe("classifyMuseRoutine", () => {
  it("reads repeating intervals with singular and plural units", () => {
    expect(classifyMuseRoutine(task("a", "every 5 hours"))).toEqual({
      group: "repeating",
      scheduleLabel: "Every 5 hours",
    });
    expect(classifyMuseRoutine(task("b", "Every 1 hour"))).toEqual({
      group: "repeating",
      scheduleLabel: "Every 1 hour",
    });
    expect(classifyMuseRoutine(task("c", "every 30 minutes")).scheduleLabel).toBe(
      "Every 30 minutes",
    );
  });

  it("reads daily times and keeps a bare daily schedule", () => {
    expect(classifyMuseRoutine(task("d", "daily 09:16"))).toEqual({
      group: "daily",
      scheduleLabel: "Daily at 09:16",
    });
    expect(classifyMuseRoutine(task("e", "every day")).group).toBe("daily");
  });

  it("puts dated and reminder schedules in Reminders", () => {
    expect(classifyMuseRoutine(task("f", "2026-10-15T09:16"))).toEqual({
      group: "reminders",
      scheduleLabel: "One time",
    });
    expect(classifyMuseRoutine(task("g", "reminder")).group).toBe("reminders");
  });

  it("groups heartbeats apart, keeping their interval when it has one", () => {
    expect(classifyMuseRoutine(task("h", "every 30 minutes", true))).toEqual({
      group: "heartbeat",
      scheduleLabel: "Every 30 minutes",
    });
    expect(classifyMuseRoutine(task("i", "", true)).scheduleLabel).toBe("Heartbeat");
  });

  it("shows an unrecognized key as given rather than guessing", () => {
    expect(classifyMuseRoutine(task("j", "cron 0 9 * * 1"))).toEqual({
      group: "other",
      scheduleLabel: "cron 0 9 * * 1",
    });
    expect(classifyMuseRoutine(task("k", "  ")).scheduleLabel).toBe("No schedule");
  });
});

describe("groupMuseRoutines", () => {
  it("returns non-empty groups in Muse's fixed order", () => {
    const groups = groupMuseRoutines([
      task("1", "cron 0 9 * * 1"),
      task("2", "every 5 hours"),
      task("3", "2026-10-15T09:16"),
      task("4", "daily 09:16"),
    ]);
    expect(groups.map((group) => group.group)).toEqual([
      "reminders",
      "daily",
      "repeating",
      "other",
    ]);
    expect(groups[2]?.tasks.map((entry) => entry.id)).toEqual(["2"]);
  });
});
