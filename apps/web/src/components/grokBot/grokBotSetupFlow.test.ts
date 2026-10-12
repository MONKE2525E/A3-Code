import { describe, expect, it } from "vite-plus/test";
import {
  grokBotSetupPollMs,
  grokBotSetupSendDisabled,
  grokBotSetupShowsTerminal,
  grokBotSetupView,
  grokBotTerminalHint,
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
