import { describe, expect, it } from "vite-plus/test";
import { DateTime } from "effect";
import { ThreadId } from "@t3tools/contracts";
import { isExpiredCompletedSubagentRow } from "./ThreadRelationshipsControl";
describe("previous agent expiry", () => {
  const day = 24 * 60 * 60 * 1000;
  const completedAt = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
  const row = (status: string) => ({
    threadId: ThreadId.make("child"),
    fromThreadId: ThreadId.make("parent"),
    depth: 1,
    edge: {
      sourceThreadId: ThreadId.make("parent"),
      targetThreadId: ThreadId.make("child"),
      kind: "subagent" as const,
      status,
    },
  });
  const nowAfter = (ms: number) => Date.parse("2026-10-01T00:00:00Z") + ms;

  it("hides a completed subagent once 24 hours have passed since completion", () => {
    expect(
      isExpiredCompletedSubagentRow({ row: row("completed"), completedAt, nowMs: nowAfter(day) }),
    ).toBe(true);
    expect(
      isExpiredCompletedSubagentRow({
        row: row("completed"),
        completedAt,
        nowMs: nowAfter(day - 60_000),
      }),
    ).toBe(false);
  });

  it("keeps failed, interrupted, and completed rows without a completion time", () => {
    for (const status of ["failed", "interrupted", "error"]) {
      expect(
        isExpiredCompletedSubagentRow({ row: row(status), completedAt, nowMs: nowAfter(2 * day) }),
      ).toBe(false);
    }
    expect(
      isExpiredCompletedSubagentRow({
        row: row("completed"),
        completedAt: null,
        nowMs: nowAfter(2 * day),
      }),
    ).toBe(false);
  });
});
