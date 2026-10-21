import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { measureComposerMultilinePrompt } from "./useComposerMultilinePrompt";

// `width`/`height` are the editor's block box, which spans the full row and
// wraps its paragraphs. `textWidth` is the painted text run, defaulting to the
// block width for prompts that fill their line.
function measure(
  input: { width: number; height: number; textWidth?: number; resting?: boolean; hidden?: boolean },
  reservedWidth?: number,
) {
  const text = { nodeType: 3, childNodes: [] };
  const editor = {
    clientWidth: input.hidden ? 0 : input.resting ? 400 : 500,
    childNodes: [{ nodeType: 1, childNodes: [text] }],
  };
  const body = { clientWidth: 532, querySelector: () => editor };
  const textWidth = input.textWidth ?? input.width;
  vi.stubGlobal("Node", { TEXT_NODE: 3 });
  vi.stubGlobal("getComputedStyle", (element: unknown) =>
    element === body
      ? { paddingLeft: "16px", paddingRight: "16px" }
      : { lineHeight: input.resting ? "32px" : "22.75px" },
  );
  vi.stubGlobal("document", {
    createRange: () => ({
      selectNodeContents() {},
      getBoundingClientRect: () => ({ width: input.width, height: input.height }),
      getClientRects: () => [{ left: 16, right: 16 + textWidth, width: textWidth }],
    }),
  });
  return measureComposerMultilinePrompt(body as unknown as HTMLElement, reservedWidth);
}

afterEach(() => vi.unstubAllGlobals());

describe("composer prompt line measurement", () => {
  it("keeps a short single paragraph compact even though its block spans the row", () => {
    // Real geometry for `<p>Hello</p>`: the block is full width, the text is ~45px.
    expect(measure({ width: 500, height: 22.75, textWidth: 45 }, 84)).toBe(false);
    expect(measure({ width: 500, height: 22.75, textWidth: 45 })).toBe(false);
  });

  it("allows a single line even though the editor has a larger minimum height", () => {
    expect(measure({ width: 500, height: 22.75 })).toBe(false);
  });

  it("keeps soft-wrapped lines expanded", () => {
    expect(measure({ width: 500, height: 45.5 })).toBe(true);
  });

  it("recognizes a long restored draft while the resting row is unwrapped", () => {
    expect(measure({ width: 700, height: 32, resting: true })).toBe(true);
  });

  it("uses the expanded width so inline actions cannot cause a collapse loop", () => {
    expect(measure({ width: 450, height: 32, resting: true })).toBe(false);
    expect(measure({ width: 500, height: 22.75 })).toBe(false);
  });

  it("allows collapse again after deleting the second line", () => {
    expect(measure({ width: 500, height: 45.5 })).toBe(true);
    expect(measure({ width: 500, height: 22.75 })).toBe(false);
  });

  it("wraps against the compact row's budget, not the full width", () => {
    // Expanded content width is 500px; a 116px reserved row leaves 384px.
    expect(measure({ width: 450, height: 22.75 }, 116)).toBe(true);
    expect(measure({ width: 380, height: 22.75 }, 116)).toBe(false);
  });

  it("has no slack at the compact budget, so both layouts agree on the boundary", () => {
    expect(measure({ width: 384, height: 22.75 }, 116)).toBe(false);
    expect(measure({ width: 384.5, height: 22.75 }, 116)).toBe(true);
  });

  it("retains the previous measurement when the editor is hidden", () => {
    expect(measure({ width: 0, height: 0, hidden: true })).toBeNull();
  });
});
