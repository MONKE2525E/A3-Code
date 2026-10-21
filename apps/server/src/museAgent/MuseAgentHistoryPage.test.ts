import { describe, expect, it } from "vite-plus/test";
import { museAgentHistoryPage } from "./MuseAgentHistoryPage.ts";

const row = (seq: number, messageId = `message-${seq}`) => ({
  event_name: "message.user",
  seq,
  occurred_at_ms: seq * 1000,
  message_id: messageId,
  payload: { display_text: "Synthetic history" },
});
describe("native Muse history pages", () => {
  it("keeps native ancillary rows in the cursor when their payload is null or primitive", () => {
    const page = museAgentHistoryPage(
      {
        events: [
          { ...row(12), event_name: "task.status", payload: null },
          { ...row(10), event_name: "generation_state_update", payload: "metadata" },
          row(14),
        ],
        hasMore: true,
      },
      "primary",
      20,
    );
    expect(page.nextBeforeSeq).toBe(10);
    expect(page.frames.map((frame) => frame.event)).toEqual([
      "generation_state_update",
      "task.status",
      "message.user",
    ]);
  });
  it("retains native top-level display text when a canonical message payload is null", () => {
    const page = museAgentHistoryPage(
      {
        events: [{ ...row(34_083), payload: null, display_text: "Synthetic canonical message" }],
        hasMore: true,
      },
      "primary",
    );
    expect(page.nextBeforeSeq).toBe(34_083);
    expect(page.frames[0]?.payload).toMatchObject({
      display_text: "Synthetic canonical message",
      session_id: "primary",
      seq: 34_083,
    });
  });
  it("orders native rows and accepts gaps, duplicates and zero on the final page", () => {
    const page = museAgentHistoryPage(
      { events: [row(4), row(0), row(4)], hasMore: false },
      "primary",
      10,
    );
    expect(page.frames.map((frame) => frame.meta?.seq)).toEqual([0, 4, 4]);
    expect(page.nextBeforeSeq).toBe(0);
    expect(page.hasMore).toBe(false);
    expect(
      museAgentHistoryPage({ events: [], hasMore: false }, "primary", 0).nextBeforeSeq,
    ).toBeNull();
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid cursor %s",
    (cursor) => {
      expect(() =>
        museAgentHistoryPage({ events: [], hasMore: false }, "primary", cursor),
      ).toThrow();
    },
  );
  it.each([-1, 1.5, 999_999, Number.MAX_SAFE_INTEGER])(
    "rejects unsupported row sequence %s",
    (seq) => {
      expect(() =>
        museAgentHistoryPage({ events: [row(seq)], hasMore: false }, "primary"),
      ).toThrow();
    },
  );
  it("rejects cursor overlaps, foreign sessions and nonprogress before publishing", () => {
    for (const page of [
      { events: [row(10)], hasMore: true },
      { events: [{ ...row(9), session_id: "foreign" }], hasMore: true },
      { events: [], hasMore: true },
      { events: [row(0)], hasMore: true },
      { events: [null], hasMore: true },
      { events: Array.from({ length: 81 }, (_, seq) => row(seq)), hasMore: false },
    ])
      expect(() => museAgentHistoryPage(page, "primary", 10)).toThrow();
    expect(
      museAgentHistoryPage({ events: [row(999_998)], hasMore: false }, "primary").nextBeforeSeq,
    ).toBe(999_998);
  });
});
