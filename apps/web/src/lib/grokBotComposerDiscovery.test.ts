import { describe, expect, it } from "vite-plus/test";

import {
  grokBotComposerAtReplacement,
  grokBotConnectorLogoUrls,
  grokBotSkillToProviderSkill,
  mentionableGrokBotComposerBots,
  searchGrokBotComposerBots,
  searchGrokBotComposerConnectors,
  searchGrokBotComposerSkills,
  serializeGrokBotComposerPrompt,
} from "./grokBotComposerDiscovery";

describe("grokBotComposerDiscovery", () => {
  it("serializes a duplicate-name skill's composer alias with its original native ID", () => {
    const result = serializeGrokBotComposerPrompt("$plugin-skill-2", {
      skills: [
        { id: "native-first", name: "Plugin skill", origin: "agent" },
        { id: "native-second", name: "Plugin skill", origin: "agent", chipName: "plugin-skill-2" },
      ],
      bots: [],
      connectors: [],
    });
    expect(result.doc.content[0]?.content?.[0]).toEqual({
      type: "workflowReference",
      attrs: { id: "native-second", label: "Plugin skill", iconId: null, iconUrl: null },
    });
  });
  it("maps native user skills onto provider skill chips without using bodies", () => {
    const skill = grokBotSkillToProviderSkill({
      id: "sand-workflow:review-pr",
      name: "Review PR",
      origin: "user",
      description: "Review a pull request",
    });
    expect(skill).toEqual({
      name: "review-pr",
      path: "sand-workflow:review-pr",
      enabled: true,
      displayName: "Review PR",
      scope: "personal",
      description: "Review a pull request",
      shortDescription: "Review a pull request",
    });
    expect("body" in skill).toBe(false);
  });

  it("keeps the current bot and unusable bots out of @ mentions", () => {
    const bots = mentionableGrokBotComposerBots(
      {
        skills: [],
        connectors: [],
        bots: [
          { id: "bot-alice", name: "Alice" },
          { id: "bot-hidden", name: "Hidden" },
        ],
      },
      "bot-current",
      new Set(["bot-alice"]),
    );
    expect(bots.map((bot) => bot.id)).toEqual(["bot-alice"]);
    expect(
      mentionableGrokBotComposerBots(
        {
          skills: [],
          connectors: [],
          bots: [
            { id: "bot-alice", name: "Alice" },
            { id: "bot-hidden", name: "Hidden" },
          ],
        },
        "bot-current",
        new Set(),
      ),
    ).toEqual([]);
    expect(searchGrokBotComposerBots(bots, "ali").map((bot) => bot.name)).toEqual(["Alice"]);
    expect(grokBotComposerAtReplacement("Alice")).toBe("@Alice ");
    expect(
      searchGrokBotComposerSkills(
        [{ id: "sand-workflow:review-pr", name: "review-pr", origin: "user" }],
        "review",
      ),
    ).toHaveLength(1);
  });

  it("lists every bot, connector, and skill for a bare @ or $ trigger", () => {
    const bots = [
      { id: "bot-alice", name: "Alice" },
      { id: "bot-codingbot", name: "codingbot" },
    ];
    const connectors = [{ pluginId: "42", name: "Linear", connectorType: "user" as const }];
    const skills = [
      { id: "sand-workflow:review-pr", name: "review-pr", origin: "user" as const },
      { id: "team-recipe", name: "Team Recipe", origin: "agent" as const },
    ];
    expect(searchGrokBotComposerBots(bots, "")).toHaveLength(2);
    expect(searchGrokBotComposerConnectors(connectors, "")).toHaveLength(1);
    expect(searchGrokBotComposerSkills(skills, "")).toHaveLength(2);
    expect(searchGrokBotComposerSkills(skills, "$")).toHaveLength(2);
  });

  it("serializes the native mention and workflowReference payload from composer tokens", () => {
    const result = serializeGrokBotComposerPrompt("Ping @Alice with $review-pr ", {
      skills: [{ id: "sand-workflow:review-pr", name: "review-pr", origin: "user" }],
      bots: [{ id: "bot-alice", name: "Alice" }],
      connectors: [],
    });
    expect(result.doc.content[0]?.content).toEqual([
      { type: "text", text: "Ping " },
      { type: "mention", attrs: { id: "bot-alice", label: "Alice" } },
      { type: "text", text: " with " },
      {
        type: "workflowReference",
        attrs: {
          id: "sand-workflow:review-pr",
          label: "review-pr",
          iconId: null,
          iconUrl: null,
        },
      },
      { type: "text", text: " " },
    ]);
  });

  it("keys catalog logos by plugin id and skips plugins without one", () => {
    expect([
      ...grokBotConnectorLogoUrls([
        { id: "101", logoUrl: "https://cdn.example/a.png" },
        { id: "102", logoUrl: null },
      ]),
    ]).toEqual([["101", "https://cdn.example/a.png"]]);
  });
});
