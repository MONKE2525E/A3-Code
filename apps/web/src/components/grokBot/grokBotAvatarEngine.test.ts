import { sha256 } from "@noble/hashes/sha2";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hoverGazeAt, loadGrokBotAvatarEngine } from "./grokBotAvatarEngine";

vi.mock("@noble/hashes/sha2", async (importOriginal) => {
  const original = await importOriginal<typeof import("@noble/hashes/sha2")>();
  return { ...original, sha256: vi.fn(original.sha256) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const trustedSha256 = "76f131c44107bcd25a196ddf5f765cf021ec12d757557591afcf58247c8d07ea";

function digest(source: string) {
  return Array.from(sha256(new TextEncoder().encode(source)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("avatar engine trust", () => {
  it("refuses malicious source even when the environment supplies its matching hash", async () => {
    const source = "globalThis.stolenCredentials = localStorage; export function createEngine() {}";
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await expect(loadGrokBotAvatarEngine("malicious", digest(source), source)).rejects.toThrow(
      "not a trusted build",
    );
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("refuses modified bytes even when the environment claims the trusted hash", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await expect(
      loadGrokBotAvatarEngine("modified", trustedSha256, "export function createEngine() {}"),
    ).rejects.toThrow("failed verification");
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("imports verified bytes with host React and preserves the renderer and animation recipes", async () => {
    // The proprietary renderer is installed locally, not a distributed test fixture.
    // Simulate its digest here to exercise the successful import/React boundary.
    const source = `export function createEngine(react, jsx) {
      return {
        BotRenderer: react.forwardRef((props) => jsx.jsx('span', props)),
        DEFAULT_FILL: 0.8,
        recipeByName: (name) => ({name, clip: 'native-animation'}),
      };
    }`;
    const bytes = Uint8Array.from(trustedSha256.match(/../g)!, (byte) => Number.parseInt(byte, 16));
    vi.mocked(sha256).mockReturnValueOnce(bytes);
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue(`data:text/javascript,${encodeURIComponent(source)}`);
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const engine = await loadGrokBotAvatarEngine("trusted", trustedSha256, source);
    expect(engine.BotRenderer).toHaveProperty("$$typeof", Symbol.for("react.forward_ref"));
    expect(engine.DEFAULT_FILL).toBe(0.8);
    expect(engine.recipeByName("Idle_D")).toEqual({ name: "Idle_D", clip: "native-animation" });
    expect(createUrl).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[0]!.value);

    vi.mocked(sha256).mockClear();
    const repeated = await Promise.all(
      Array.from({ length: 20 }, () => loadGrokBotAvatarEngine("trusted", trustedSha256, source)),
    );
    expect(repeated.every((copy) => copy === engine)).toBe(true);
    expect(sha256).not.toHaveBeenCalled();
    expect(createUrl).toHaveBeenCalledOnce();

    // Even a key already holding a trusted engine must not authorize new source.
    await expect(loadGrokBotAvatarEngine("trusted", trustedSha256, "tampered")).rejects.toThrow(
      "failed verification",
    );
    await expect(
      loadGrokBotAvatarEngine("trusted", digest("tampered"), "tampered"),
    ).rejects.toThrow("not a trusted build");
    expect(createUrl).toHaveBeenCalledOnce();
  });
});

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
