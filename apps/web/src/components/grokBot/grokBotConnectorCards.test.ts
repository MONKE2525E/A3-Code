import { describe, expect, it } from "vite-plus/test";

import { settledConnectorCardIds } from "./grokBotConnectorCards";

const card = (id: string, serverId: number, variant: "connect" | "connected") => ({
  id,
  grokBotConnectorCard: { connector: "mcp.linear.app", serverId, variant },
});

describe("settledConnectorCardIds", () => {
  it("settles earlier connect cards once the same connector reports connected", () => {
    const settled = settledConnectorCardIds([
      card("ask-1", 7, "connect"),
      { id: "text" },
      card("ask-2", 7, "connect"),
      card("other", 8, "connect"),
      card("done", 7, "connected"),
    ]);
    expect([...settled].toSorted()).toEqual(["ask-1", "ask-2"]);
  });

  it("keeps a connect card open when the connection was confirmed before it", () => {
    expect(
      settledConnectorCardIds([card("done", 7, "connected"), card("again", 7, "connect")]).size,
    ).toBe(0);
  });
});
