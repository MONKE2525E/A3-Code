import { describe, expect, it } from "vite-plus/test";
import {
  grokBotSetupPollMs,
  grokBotSetupSendDisabled,
  grokBotSetupShowsTerminal,
  grokBotSetupView,
  grokBotTerminalHint,
  resolveGrokBotOAuthRedirect,
} from "./grokBotSetupFlow";

const status = (phase: Parameters<typeof grokBotSetupView>[0]["phase"], complete = false) => ({
  phase,
  complete,
  primaryBot: null,
  mcpUrl: null,
  terminalCommand: null,
  authorizationUrl: null,
  error: null,
  updatedAtMs: 0,
});

describe("grokBotSetupView", () => {
  it("hides the send action only when the server reports complete", () => {
    expect(grokBotSetupView(status("complete", true)).showSend).toBe(false);
    expect(grokBotSetupView(status("complete", false)).showSend).toBe(true);
    expect(grokBotSetupView(status("verifying")).showSend).toBe(true);
  });
  it("keeps refreshing only while the server is active", () => {
    expect(grokBotSetupView(status("awaiting_authorization")).active).toBe(true);
    expect(grokBotSetupView(status("stalled")).active).toBe(false);
  });
  it("offers retry on failure", () => {
    expect(grokBotSetupView(status("failed")).sendLabel).toBe("Retry setup");
  });
  it("rechecks transient status failures without permitting another setup message", () => {
    const unavailable = { ...status("failed"), retryable: true };
    expect(grokBotSetupView(unavailable).active).toBe(true);
    expect(grokBotSetupView(unavailable).title).toBe("Setup temporarily unavailable");
    expect(grokBotSetupSendDisabled(unavailable)).toBe(true);
    expect(grokBotSetupView(status("failed")).active).toBe(false);
  });
  it("requires a primary bot before sending", () => {
    expect(grokBotSetupSendDisabled(status("needs_primary"))).toBe(true);
    expect(grokBotSetupSendDisabled(status("needs_prerequisite"))).toBe(true);
    expect(
      grokBotSetupSendDisabled({
        ...status("needs_prerequisite"),
        primaryBot: { id: "primary", name: "Primary" },
      }),
    ).toBe(false);
  });
  it("blocks resend while any phase is active but allows retry after failure", () => {
    expect(grokBotSetupSendDisabled(status("awaiting_authorization"))).toBe(true);
    expect(grokBotSetupSendDisabled(status("verifying"))).toBe(true);
    expect(grokBotSetupSendDisabled(status("failed"))).toBe(false);
    expect(grokBotSetupSendDisabled(status("stalled"))).toBe(false);
  });
  it("polls authorization slower than sending and verifying", () => {
    expect(grokBotSetupPollMs("awaiting_authorization")).toBe(10_000);
    expect(grokBotSetupPollMs("verifying")).toBe(5_000);
  });
  it("shows the terminal command only while setup is unfinished", () => {
    const command = { ...status("awaiting_authorization"), terminalCommand: "t3 x" };
    expect(grokBotSetupShowsTerminal(command)).toBe(true);
    expect(grokBotSetupShowsTerminal({ ...command, phase: "complete", complete: true })).toBe(
      false,
    );
    expect(grokBotSetupShowsTerminal(status("needs_setup"))).toBe(false);
  });
  it("identifies generated PowerShell commands", () => {
    expect(grokBotTerminalHint('& "C:\\a b\\t3.exe" x')).toContain("PowerShell");
    expect(grokBotTerminalHint("t3 x")).not.toContain("PowerShell");
  });
});

describe("resolveGrokBotOAuthRedirect", () => {
  it("never passes the Electron app origin", () => {
    expect(resolveGrokBotOAuthRedirect("t3code://app", "http://127.0.0.1:3773/")).toBe(
      "http://127.0.0.1:3773/settings/marketplace?grokBotOAuth=1",
    );
  });
  it("prefers the destination environment over a different page origin", () => {
    expect(resolveGrokBotOAuthRedirect("https://app.t3.codes", "https://box.ts.net")).toBe(
      "https://box.ts.net/settings/marketplace?grokBotOAuth=1",
    );
  });
  it("falls back to the page origin and rejects non-web origins", () => {
    expect(resolveGrokBotOAuthRedirect("https://box.ts.net", null)).toBe(
      "https://box.ts.net/settings/marketplace?grokBotOAuth=1",
    );
    expect(resolveGrokBotOAuthRedirect("t3code://app", null)).toBeNull();
  });
  it.each(["http://192.168.1.10:3773", "http://100.64.0.2:3773"])(
    "uses the environment's published HTTPS endpoint when connected over %s",
    (httpBaseUrl) => {
      expect(
        resolveGrokBotOAuthRedirect(
          "https://app.t3.codes",
          httpBaseUrl,
          "https://this-environment.example.test/mcp",
        ),
      ).toBe("https://this-environment.example.test/settings/marketplace?grokBotOAuth=1");
      expect(resolveGrokBotOAuthRedirect("https://app.t3.codes", httpBaseUrl)).toBeNull();
    },
  );
  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "keeps the server's HTTP loopback exception for %s",
    (host) => {
      expect(
        resolveGrokBotOAuthRedirect(
          "t3code://app",
          `http://${host}:3773`,
          "https://this-environment.example.test/mcp",
        ),
      ).toBe(`http://${host}:3773/settings/marketplace?grokBotOAuth=1`);
    },
  );
  it("uses a published environment address before falling back to the page", () => {
    expect(
      resolveGrokBotOAuthRedirect(
        "https://app.t3.codes",
        null,
        "https://this-environment.example.test/mcp",
      ),
    ).toBe("https://this-environment.example.test/settings/marketplace?grokBotOAuth=1");
  });
  it("rejects insecure remote and credential-bearing addresses", () => {
    expect(resolveGrokBotOAuthRedirect("http://100.64.0.2:3773", null)).toBeNull();
    expect(
      resolveGrokBotOAuthRedirect("t3code://app", "https://user:password@box.ts.net"),
    ).toBeNull();
    expect(
      resolveGrokBotOAuthRedirect("t3code://app", "http://100.64.0.2:3773", "http://box.ts.net"),
    ).toBeNull();
  });
});
