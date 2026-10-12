import { assert, it } from "@effect/vitest";

import { parsePinnedAgentIds } from "./desktopPins.ts";

it("reads pinned ids out of a persistence blob", () => {
  const blob = '\u0001junk"pinnedAgentIds":["a","b"],"mentionRecents":[]';
  assert.deepStrictEqual(parsePinnedAgentIds(blob), ["a", "b"]);
  assert.deepStrictEqual(parsePinnedAgentIds("no pins here"), []);
});
