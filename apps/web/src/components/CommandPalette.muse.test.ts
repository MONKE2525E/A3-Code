import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildMuseAgentSearchItems,
  openMuseAgentSearchHit,
  type MuseAgentSearchHit,
} from "./CommandPalette.logic";

const environmentId = EnvironmentId.make("env-1");

const hit = (threadId: string, snippet: string): MuseAgentSearchHit => ({
  environmentId,
  threadId,
  source: "assistant",
  snippet,
});

describe("opening Muse search results", () => {
  const identity = "a".repeat(64);
  const providerInstanceId = ProviderInstanceId.make("historical-muse-instance");
  const remoteEnvironmentId = EnvironmentId.make("remote-env");
  const main = ThreadId.make(`muse-agent:${identity}`);
  const side = ThreadId.make(`${main}:${encodeURIComponent("side:chat /one")}`);
  const shells = [main, side].map((id) => ({
    environmentId: remoteEnvironmentId,
    id,
    providerInstanceId,
  }));

  it.each([main, side])(
    "reattaches %s before navigating in the result's environment",
    async (threadId) => {
      const events: string[] = [];
      let finishOpen = (_value: { threadId: ThreadId }): void => {
        throw new Error("Open not started");
      };
      const ready = new Promise<{ threadId: ThreadId }>((resolve) => {
        finishOpen = resolve;
      });
      const selected = { ...hit(threadId, "match"), environmentId: remoteEnvironmentId };
      const openThread = vi.fn(() => {
        events.push("open");
        return ready;
      });
      const navigate = vi.fn(async () => {
        events.push("navigate");
      });
      const [item] = buildMuseAgentSearchItems({
        hits: [selected],
        query: "match",
        identity: { environmentId, name: "Local Muse", icon: null },
        fallbackIcon: null,
        canOpen: () => true,
        run: (hit) => openMuseAgentSearchHit({ hit, shells, openThread, navigate }),
      });
      const opening = item!.run();
      expect(events).toEqual(["open"]);
      expect(openThread).toHaveBeenCalledWith({
        environmentId: remoteEnvironmentId,
        input: {
          providerInstanceId,
          ...(threadId === side ? { sessionId: "side:chat /one" } : {}),
        },
      });
      finishOpen({ threadId });
      await opening;
      expect(events).toEqual(["open", "navigate"]);
      expect(navigate).toHaveBeenCalledWith({ environmentId: remoteEnvironmentId, threadId });
    },
  );

  it.each(["failure", "interrupted", "other-account"])(
    "does not navigate after %s",
    async (outcome) => {
      const navigate = vi.fn(async () => {});
      const opening = openMuseAgentSearchHit({
        hit: { ...hit(side, "match"), environmentId: remoteEnvironmentId },
        shells,
        navigate,
        openThread: async () => {
          if (outcome === "failure") throw new Error("Muse sign-in required");
          return outcome === "interrupted"
            ? null
            : { threadId: ThreadId.make(`muse-agent:${"b".repeat(64)}`) };
        },
      });
      if (outcome === "interrupted") await opening;
      else
        await expect(opening).rejects.toThrow(
          outcome === "failure" ? "Muse sign-in required" : "different Muse account",
        );
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it.each([main, `muse-agent:${identity}:%ZZ`, `muse-agent:${identity}:%61`])(
    "rejects missing or malformed shell %s before opening",
    async (threadId) => {
      const openThread = vi.fn(async () => ({ threadId: main }));
      const navigate = vi.fn(async () => {});
      await expect(
        openMuseAgentSearchHit({
          hit: {
            ...hit(threadId, "match"),
            environmentId: threadId === main ? environmentId : remoteEnvironmentId,
          },
          shells: [{ environmentId: remoteEnvironmentId, id: threadId, providerInstanceId }],
          openThread,
          navigate,
        }),
      ).rejects.toThrow("unavailable");
      expect(openThread).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    },
  );
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
      canOpen: () => true,
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
      canOpen: () => true,
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
    canOpen: () => true,
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
