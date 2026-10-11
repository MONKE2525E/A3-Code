import { describe, expect, it } from "@effect/vitest";
import { grokBotComputerViewerUrl } from "./grokBotComputerUrl.ts";

describe("native computer routing", () => {
  const routes = {
    primaryUrl: "https://box-6080.cursorvm.com/vnc.html?network_token=network",
    forkBaseUrl: "https://box-6081.cursorvm.com",
    networkToken: "network",
  };
  it("uses the broker route for the primary display and enables interactive native input", () => {
    const url = new URL(grokBotComputerViewerUrl("http://localhost:6080/vnc.html", routes));
    expect(url.hostname).toBe("box-6080.cursorvm.com");
    expect(url.searchParams.get("network_token")).toBe("network");
    expect(url.searchParams.get("sandInteractive")).toBe("1");
  });
  it("preserves the bot-specific fork token in the websocket route", () => {
    const url = new URL(
      grokBotComputerViewerUrl(
        "http://127.0.0.1:6081/vnc.html?path=websockify%3Ftoken%3Dbot-display",
        routes,
      ),
    );
    expect(url.hostname).toBe("box-6081.cursorvm.com");
    const path = url.searchParams.get("path")!;
    expect(new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("token")).toBe("bot-display");
    expect(url.searchParams.get("network_token")).toBe("network");
  });
  it.each([
    "http://localhost:6080/vnc.html",
    "https://outside.invalid/vnc.html",
    "https://cursorvm.com.outside.invalid/vnc.html",
    "https://user:secret@box.cursorvm.com/vnc.html",
  ])("rejects unsupported or unsafe viewer routes: %s", (url) => {
    expect(() => grokBotComputerViewerUrl(url, {})).toThrow();
  });
});
