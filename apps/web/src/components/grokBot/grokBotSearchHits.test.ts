import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { grokBotSearchHitsFromMatches } from "./grokBotSearchHits";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

function shell(environmentId: EnvironmentId, id: string, model: string) {
  return {
    environmentId,
    id: ThreadId.make(id),
    modelSelection: { instanceId: ProviderInstanceId.make("grok-bot-instance"), model },
  };
}

function match(environmentId: EnvironmentId, threadId: string, snippet: string) {
  return {
    environmentId,
    threadId: ThreadId.make(threadId),
    projectId: ProjectId.make("scratch"),
    source: "assistant" as const,
    snippet,
    messageCreatedAt: null,
  };
}

const bot = { id: "bot-1", name: "Mobile Scout", avatarShape: "cat", avatarColor: "teal" };

describe("grokBotSearchHitsFromMatches", () => {
  const shells = [
    shell(envA, "grok-bot:canonical-1", "bot-1"),
    shell(envA, "thread:coding", "gpt-x"),
    shell(envB, "grok-bot:canonical-2", "bot-2"),
  ];

  it("resolves a bot conversation match to its roster bot in the roster environment", () => {
    const hits = grokBotSearchHitsFromMatches({
      matches: [match(envA, "grok-bot:canonical-1", "mobile only")],
      shells,
      rosterEnvironmentId: envA,
      roster: [bot],
    });

    expect(hits).toEqual([
      {
        environmentId: envA,
        bot,
        source: "assistant",
        snippet: "mobile only",
      },
    ]);
  });

  it("ignores matches in ordinary threads", () => {
    const hits = grokBotSearchHitsFromMatches({
      matches: [match(envA, "thread:coding", "mobile only")],
      shells,
      rosterEnvironmentId: envA,
      roster: [bot],
    });

    expect(hits).toEqual([]);
  });

  it("shows each bot once, keeping the first match", () => {
    const hits = grokBotSearchHitsFromMatches({
      matches: [
        match(envA, "grok-bot:canonical-1", "first mobile only"),
        match(envA, "grok-bot:canonical-1", "second mobile only"),
      ],
      shells,
      rosterEnvironmentId: envA,
      roster: [bot],
    });

    expect(hits.map((hit) => hit.snippet)).toEqual(["first mobile only"]);
  });

  it("falls back to a generic name for a bot outside the roster environment", () => {
    const hits = grokBotSearchHitsFromMatches({
      matches: [match(envB, "grok-bot:canonical-2", "elsewhere")],
      shells,
      rosterEnvironmentId: envA,
      roster: [bot],
    });

    expect(hits[0]?.bot).toEqual({
      id: "bot-2",
      name: "Grok Bot",
      avatarShape: "",
      avatarColor: "",
    });
  });
});
