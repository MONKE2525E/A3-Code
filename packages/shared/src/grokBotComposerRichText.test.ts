import { describe, expect, it } from "vite-plus/test";

import {
  formatGrokBotComposerAtToken,
  grokBotSkillChipName,
  serializeGrokBotComposerRichText,
} from "./grokBotComposerRichText.ts";

const catalog = {
  skills: [
    { id: "sand-workflow:review-pr", name: "review-pr" },
    { id: "team-recipe-1", name: "Team Recipe", chipName: "team-recipe" },
  ],
  bots: [{ id: "bot-alice", name: "Alice" }],
  connectors: [{ pluginId: "42", name: "linear", displayName: "Linear" }],
};

describe("serializeGrokBotComposerRichText", () => {
  it("encodes native mention and workflowReference nodes from T3 $ and @ tokens", () => {
    const result = serializeGrokBotComposerRichText(
      "Ask @Alice to run $review-pr and @Linear please",
      catalog,
    );

    expect(result.doc).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ask " },
            { type: "mention", attrs: { id: "bot-alice", label: "Alice" } },
            { type: "text", text: " to run " },
            {
              type: "workflowReference",
              attrs: {
                id: "sand-workflow:review-pr",
                label: "review-pr",
                iconId: null,
                iconUrl: null,
              },
            },
            { type: "text", text: " and " },
            {
              type: "workflowReference",
              attrs: {
                id: "plugin:42",
                label: "Linear",
                iconId: null,
                iconUrl: null,
              },
            },
            { type: "text", text: " please" },
          ],
        },
      ],
    });
    expect(JSON.parse(result.richText)).toEqual(result.doc);
    expect(result.nativeText).toBe("Ask @Alice to run @review-pr and @Linear please");
    expect(result.unresolved).toEqual([]);
  });

  it("keeps unmatched tokens as prose instead of inventing native ids", () => {
    const result = serializeGrokBotComposerRichText("Use $missing and @ghost ", catalog);
    expect(result.doc.content[0]?.content).toEqual([
      { type: "text", text: "Use $missing and @ghost " },
    ]);
    expect(result.unresolved).toEqual(["$missing", "@ghost"]);
  });

  it("preserves user-own sand-workflow ids and quoted bot names", () => {
    const quoted = serializeGrokBotComposerRichText(
      `${formatGrokBotComposerAtToken("Alice")} $review-pr`,
      catalog,
    );
    expect(quoted.doc.content[0]?.content).toEqual([
      { type: "mention", attrs: { id: "bot-alice", label: "Alice" } },
      { type: "text", text: " " },
      {
        type: "workflowReference",
        attrs: {
          id: "sand-workflow:review-pr",
          label: "review-pr",
          iconId: null,
          iconUrl: null,
        },
      },
    ]);
    expect(grokBotSkillChipName({ id: "team-recipe-1", name: "Team Recipe" })).toBe("team-recipe");
  });
});
