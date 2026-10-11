import { describe, expect, it } from "@effect/vitest";
import { grokBotWorkflowReferences } from "./GrokBotWorkflowReferences.ts";

const doc = (attrs: unknown) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "workflowReference", attrs }] }],
});
describe("native workflow references", () => {
  it("keeps exact native ids and labels without sending or transforming the message", () => {
    expect(
      grokBotWorkflowReferences(
        JSON.stringify(
          doc({
            id: "sand-workflow:native-id",
            label: "Search YouTube",
            iconId: "youtube",
            arbitrary: "ignored",
          }),
        ),
      ),
    ).toEqual([{ id: "sand-workflow:native-id", label: "Search YouTube" }]);
  });
  it("ignores malformed references and bounded metadata failures", () => {
    for (const value of [
      "{",
      "x".repeat(262145),
      doc({ id: "", label: "bad" }),
      doc({ id: "ok", label: "x".repeat(1025) }),
      doc({ id: "ok", label: "ok", teachQueueScope: "x".repeat(257) }),
    ]) {
      expect(grokBotWorkflowReferences(value)).toEqual([]);
    }
  });
  it("caps the number of chips while retaining the readable message separately", () => {
    const node = { type: "workflowReference", attrs: { id: "skill", label: "Skill" } };
    expect(
      grokBotWorkflowReferences({ type: "doc", content: Array.from({ length: 100 }, () => node) }),
    ).toHaveLength(64);
  });
});
