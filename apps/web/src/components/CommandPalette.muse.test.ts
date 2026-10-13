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
      name: "Muse",
      icon: () => null,
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
      name: "Muse",
      icon: () => null,
      run,
    });
    await item?.run();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ threadId: "muse-agent:a" }));
  });
});
