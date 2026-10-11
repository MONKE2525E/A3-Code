import { describe, expect, it } from "vite-plus/test";

import { hoverGazeAt } from "./grokBotAvatarEngine";

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe("hoverGazeAt", () => {
  it("looks straight ahead at the mark's center", () => {
    expect(hoverGazeAt(rect(100, 100, 64, 64), { x: 132, y: 132 })).toEqual([0, 0]);
  });

  it("saturates the eyes well inside the mark and points up for pointers above center", () => {
    // 35% of the mark's width from center is full deflection, so a 64px mark saturates at 22.4px.
    expect(hoverGazeAt(rect(0, 0, 64, 64), { x: 54.4, y: 32 })).toEqual([1, 0]);
    expect(hoverGazeAt(rect(0, 0, 64, 64), { x: 32, y: 9.6 })).toEqual([0, 1]);
    expect(hoverGazeAt(rect(0, 0, 64, 64), { x: 40, y: 32 })?.[0]).toBeCloseTo(8 / 22.4);
  });

  it("clamps each axis to the unit range when the mark is taller than it is wide", () => {
    expect(hoverGazeAt(rect(0, 0, 10, 40), { x: 10, y: 0 })).toEqual([1, 1]);
    expect(hoverGazeAt(rect(0, 0, 10, 40), { x: 0, y: 40 })).toEqual([-1, -1]);
  });

  it("returns null outside the mark, including along its edges", () => {
    expect(hoverGazeAt(rect(0, 0, 64, 64), { x: -1, y: 10 })).toBeNull();
    expect(hoverGazeAt(rect(0, 0, 64, 64), { x: 10, y: 65 })).toBeNull();
  });

  it("hit-tests the whole host but aims from the mark it anchors", () => {
    // A 200px tab with a 36px mark at its left: the eyes measure from the mark, not the tab's center.
    const tab = rect(0, 0, 200, 54);
    const mark = rect(9, 9, 36, 36);
    expect(hoverGazeAt(tab, { x: 27, y: 27 }, mark)).toEqual([0, 0]);
    expect(hoverGazeAt(tab, { x: 190, y: 27 }, mark)).toEqual([1, 0]);
    expect(hoverGazeAt(tab, { x: 27, y: 2 }, mark)).toEqual([0, 1]);
    expect(hoverGazeAt(tab, { x: 201, y: 27 }, mark)).toBeNull();
  });
});
