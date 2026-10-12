import { describe, expect, it } from "@effect/vitest";
import { grokBotComputerSocketUrl } from "./grokBotComputerSocketUrl.ts";

describe("native computer websocket routing", () => {
  const routes = {
    primaryUrl: "https://box-6080.cursorvm.com/vnc.html?network_token=network&port_token=port",
    forkBaseUrl: "https://box-6081.cursorvm.com",
    networkToken: "network",
  };
  it("connects directly to the broker websocket with its network and port grants", () => {
    const socket = new URL(grokBotComputerSocketUrl("http://localhost:6080/vnc.html", routes));
    expect(socket.protocol).toBe("wss:");
    expect(socket.hostname).toBe("box-6080.cursorvm.com");
    expect(socket.pathname).toBe("/websockify");
    expect(socket.searchParams.get("network_token")).toBe("network");
    expect(socket.searchParams.get("port_token")).toBe("port");
  });
  it("preserves the exact bot display grant and fork resume policy", () => {
    const socket = new URL(
      grokBotComputerSocketUrl(
        "http://localhost:6081/vnc.html?path=websockify%3Ftoken%3Dbot-display",
        routes,
      ),
    );
    expect(socket.hostname).toBe("box-6081.cursorvm.com");
    expect(socket.pathname).toBe("/websockify");
    expect(socket.searchParams.get("token")).toBe("bot-display");
    expect(socket.searchParams.get("network_token")).toBe("network");
    expect(socket.searchParams.get("resume_lower_s")).toBe("900");
    expect(socket.searchParams.get("resume_upper_s")).toBe("18000");
  });
  it("rejects socket routes that escape the validated broker host", () => {
    expect(() =>
      grokBotComputerSocketUrl(
        "https://box.cursorvm.com/vnc.html?path=%2F%2Foutside.invalid%2Fwebsockify",
        routes,
      ),
    ).toThrow();
  });
});
