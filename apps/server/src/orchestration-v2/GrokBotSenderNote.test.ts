import { assert, it } from "@effect/vitest";

import { grokBotSenderNote } from "./GrokBotSenderNote.ts";

it("names the sending T3 agent", () => {
  assert.strictEqual(grokBotSenderNote("Agent comms"), "[message from another agent, Agent comms]");
});

it("collapses whitespace in the sender title", () => {
  assert.strictEqual(
    grokBotSenderNote("  Agent\n\n  comms "),
    "[message from another agent, Agent comms]",
  );
});

it("falls back to another T3 agent when the sender has no usable title", () => {
  assert.strictEqual(grokBotSenderNote("   "), "[message from another agent, another T3 agent]");
  assert.strictEqual(
    grokBotSenderNote(undefined),
    "[message from another agent, another T3 agent]",
  );
});

it("truncates a long sender title so the stamp stays bounded", () => {
  const note = grokBotSenderNote("x".repeat(400));
  assert.isTrue(note.includes(`${"x".repeat(159)}…]`));
  assert.isFalse(note.includes("x".repeat(160)));
});
