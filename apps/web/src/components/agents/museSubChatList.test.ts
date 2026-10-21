import { describe, expect, it } from "vite-plus/test";

import { museConnectorGeometry, resolveMuseSubChatList } from "./museSubChatList";

const HASH = "a".repeat(64);
const main = `muse-agent:${HASH}`;
const side = (name: string) => `muse-agent:${HASH}:${name}`;
const thread = (id: string, pinnedAt: unknown = null, archivedAt: unknown = null) => ({
  id,
  title: id,
  providerInstanceId: "muse",
  archivedAt,
  pinnedAt,
});
const list = (threads: ReturnType<typeof thread>[], routeThreadId: string | null) =>
  resolveMuseSubChatList({ threads, providerInstanceId: "muse", routeThreadId });

describe("resolveMuseSubChatList", () => {
  const threads = [thread(main), thread(side("a")), thread(side("b")), thread(side("p"), "now")];

  it("lists only pinned chats when Main is open", () => {
    const result = list(threads, main);
    expect(result.open).toBeNull();
    expect(result.pinned.map((entry) => entry.id)).toEqual([side("p")]);
  });

  it("lists the open unpinned side chat and no other unpinned chat", () => {
    const result = list(threads, side("a"));
    expect(result.open?.id).toBe(side("a"));
    expect(result.pinned.map((entry) => entry.id)).toEqual([side("p")]);
  });

  it("shows an open pinned chat as the active pinned row without a connector target", () => {
    const result = list(threads, side("p"));
    expect(result.open).toBeNull();
    expect(result.pinned).toEqual([expect.objectContaining({ id: side("p"), active: true })]);
  });

  it("never lists Main, even if pinned", () => {
    const result = list([thread(main, "now")], main);
    expect(result.pinned).toEqual([]);
    expect(result.open).toBeNull();
  });

  it("ignores archived chats", () => {
    const archived = thread(side("a"), null, "x");
    expect(list([archived], side("a")).open).toBeNull();
  });
});

describe("museConnectorGeometry", () => {
  it("runs down then curves into the row", () => {
    expect(museConnectorGeometry({ dy: 40, dx: 30, radius: 16 }).path).toBe(
      "M 0 0 V 24 Q 0 40 16 40 H 30",
    );
  });

  it("shrinks the radius when space is tight", () => {
    expect(museConnectorGeometry({ dy: 10, dx: 30 }).path).toBe("M 0 0 V 0 Q 0 10 10 10 H 30");
  });
});
