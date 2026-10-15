import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildMuseAgentSearchItems, type MuseAgentSearchHit } from "./CommandPalette.logic";

const environmentId = EnvironmentId.make("env-1");

const hit = (threadId: string, snippet: string): MuseAgentSearchHit => ({
  environmentId,
  threadId,
  source: "assistant",
  snippet,
});

describe("buildMuseAgentSearchItems", () => {
  it("lists one Muse item per conversation and keeps the query searchable", () => {
    const items = buildMuseAgentSearchItems({
      hits: [
        hit("muse-agent:a", "first"),
        hit("muse-agent:a", "again"),
        hit("muse-agent:b", "other"),
      ],
      query: "plan",
      identity: { environmentId, name: "Muse", icon: null },
      fallbackIcon: null,
      run: async () => {},
    });
    expect(items.map((item) => item.value)).toEqual([
      "muse-agent:env-1:muse-agent:a",
      "muse-agent:env-1:muse-agent:b",
    ]);
    expect(items[0]).toMatchObject({
      title: "Muse",
      description: "Muse conversation",
      searchTerms: ["plan", "Muse", "first"],
      threadContentMatch: { source: "assistant", snippet: "first", query: "plan" },
    });
  });

  it("opens the hit that was selected", async () => {
    const run = vi.fn(async () => {});
    const [item] = buildMuseAgentSearchItems({
      hits: [hit("muse-agent:a", "x")],
      query: "x",
      identity: { environmentId, name: "Muse", icon: null },
      fallbackIcon: null,
      run,
    });
    await item?.run();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ threadId: "muse-agent:a" }));
  });
});

it("keeps another environment's Muse identity separate from the selected account", async () => {
  const foreignEnvironment = EnvironmentId.make("env-2");
  const run = vi.fn(async () => {});
  const items = buildMuseAgentSearchItems({
    hits: [
      hit("muse-agent:a", "local result"),
      { ...hit("muse-agent:a", "remote result"), environmentId: foreignEnvironment },
    ],
    query: "result",
    identity: { environmentId, name: "Local Muse", icon: "local-avatar" },
    fallbackIcon: "generic-avatar",
    run,
  });
  expect(
    items.map((item) => ({ title: item.title, icon: item.icon, searchTerms: item.searchTerms })),
  ).toEqual([
    {
      title: "Local Muse",
      icon: "local-avatar",
      searchTerms: ["result", "Local Muse", "local result"],
    },
    { title: "Muse", icon: "generic-avatar", searchTerms: ["result", "Muse", "remote result"] },
  ]);
  await items[1]?.run();
  expect(run).toHaveBeenLastCalledWith({
    environmentId: foreignEnvironment,
    threadId: "muse-agent:a",
    source: "assistant",
    snippet: "remote result",
  });
});
