import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadId } from "@t3tools/contracts";

import {
  isExpiredCompletedSubagentRow,
  resolveThreadLineageWindow,
  ThreadLineageRowList,
} from "./ThreadRelationshipsControl";

const rows = Array.from({ length: 20 }, (_, index) => `row-${index}`);

function renderRowList(visibleCount: number) {
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, visibleCount);
  return renderToStaticMarkup(
    <ThreadLineageRowList hiddenCount={hiddenCount} onShowMore={() => {}}>
      {visibleRows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ThreadLineageRowList>,
  );
}

describe("thread lineage row list", () => {
  it("shows six rows before the first expansion", () => {
    const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, 6);

    expect(visibleRows).toEqual(rows.slice(0, 6));
    expect(hiddenCount).toBe(14);
  });

  it("offers one page at a time", () => {
    expect(renderRowList(6)).toContain("Show 12 more");
    expect(renderRowList(6 + 12)).toContain("Show 2 more");
  });

  it("omits the expansion affordance when everything fits", () => {
    const markup = renderRowList(rows.length);

    expect(markup).not.toContain("more");
    expect(resolveThreadLineageWindow(rows.slice(0, 6), 6).hiddenCount).toBe(0);
  });

  it("keeps the rows in a bounded, labelled scroll region and the button outside it", () => {
    const markup = renderRowList(6);
    const list = /<ul([^>]*)>/.exec(markup)?.[1] ?? "";

    expect(list).toContain('aria-label="Related threads"');
    expect(list).toContain("max-h-[13.5rem]");
    expect(list).toContain("overflow-y-auto");
    expect(list).toContain("overscroll-contain");
    expect(markup.indexOf("</ul>")).toBeLessThan(markup.indexOf("<button"));
  });
});

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
