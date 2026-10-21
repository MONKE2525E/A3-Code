import { describe, expect, it } from "vite-plus/test";

import { resolveUserMessagePresentation } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("attributes older server-sent restart continuations to T3 Code, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "t3code" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });

  it("hides the internal prompt of a voice request behind the voice marker", () => {
    const prompt = "Project: p1 (pass it as projectId to delegate_task).\nFix the login bug";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "mcp",
        voiceRequest: true,
        text: prompt,
      }),
    ).toEqual({ text: "", attribution: "voice", scheduledTaskId: undefined });
  });

  it("recognizes the exact legacy voice bridge shape and nothing looser", () => {
    const legacy = "[From a voice call]\nFix the login bug";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "mcp",
        text: legacy,
      }),
    ).toMatchObject({ text: "", attribution: "voice" });
    for (const message of [
      { role: "user", createdBy: "user" as const, creationSource: "web" as const, text: legacy },
      {
        role: "user",
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        text: `Quote:\n${legacy}`,
      },
      {
        role: "user",
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        text: "[From a voice call] typed",
      },
    ]) {
      expect(resolveUserMessagePresentation(message)).toMatchObject({
        text: message.text,
        attribution: message.createdBy === "agent" ? "agent" : null,
      });
    }
  });
});
