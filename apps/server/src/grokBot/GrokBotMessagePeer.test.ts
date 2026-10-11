import { describe, expect, it } from "vite-plus/test";
import { grokBotMessagePeer } from "./GrokBotMessagePeer.ts";

describe("native message peers", () => {
  it("selects the other bot by identity and preserves a cloud agent's destination kind", () => {
    expect(
      grokBotMessagePeer("self", {
        fromAgent: { id: "self", name: "Me" },
        toAgent: { id: "cloud", name: "Cloud task", kind: "cloud-agent" },
      }),
    ).toEqual({ botId: "cloud", name: "Cloud task", kind: "cloud-agent", direction: "to" });
    expect(grokBotMessagePeer("self", { fromAgent: { id: "peer" } })).toEqual({
      botId: "peer",
      name: "peer",
      direction: "from",
    });
  });

  it("keeps malformed or self-only participants out of navigation metadata", () => {
    for (const fromAgent of [
      null,
      "peer",
      {},
      { id: "" },
      { id: " " },
      { id: 12 },
      { id: "self" },
    ]) {
      expect(grokBotMessagePeer("self", { fromAgent })).toBeUndefined();
    }
  });
});
