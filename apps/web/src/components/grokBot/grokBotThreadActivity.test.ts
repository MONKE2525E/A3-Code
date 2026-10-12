import type {
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type GrokBotThreadActivityShell,
  grokBotInFlightToolActivity,
  grokBotToolActivity,
  selectGrokBotToolActivities,
} from "./grokBotThreadActivity";

const CURRENT = "grok-bot-current" as ProviderInstanceId;
const RUN = "run-current" as RunId;

function toolItem(input: {
  readonly toolName: string | null;
  readonly status: string;
  readonly runId?: RunId | null;
}): OrchestrationV2TurnItem {
  // Only the fields the activity reader touches; the rest of a turn item is not read.
  return {
    type: "dynamic_tool",
    toolName: input.toolName,
    status: input.status,
    runId: input.runId === undefined ? RUN : input.runId,
  } as unknown as OrchestrationV2TurnItem;
}

function shell(input: {
  readonly id: string;
  readonly model: string;
  readonly instanceId?: ProviderInstanceId;
  readonly activeRunId?: RunId | null;
  readonly activityRunStatus?: string | null;
  readonly archived?: boolean;
}): GrokBotThreadActivityShell & { readonly id: ThreadId } {
  // Shell fields only; the selector reads nothing else from a thread.
  return {
    id: input.id as ThreadId,
    providerInstanceId: input.instanceId ?? CURRENT,
    modelSelection: { instanceId: input.instanceId ?? CURRENT, model: input.model },
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    archivedAt: input.archived ? DateTime.makeUnsafe("2026-02-01T00:00:00Z") : null,
    activeRunId: input.activeRunId === undefined ? RUN : input.activeRunId,
    activityRunStatus: input.activityRunStatus === undefined ? "running" : input.activityRunStatus,
    status: "running",
  } as unknown as GrokBotThreadActivityShell & { readonly id: ThreadId };
}

describe("grokBotToolActivity", () => {
  it("maps tool names onto the shared classifier's states", () => {
    expect(grokBotToolActivity("Bash")).toBe("running");
    expect(grokBotToolActivity("Read")).toBe("reading");
    expect(grokBotToolActivity("Grep")).toBe("searching");
    expect(grokBotToolActivity("Edit")).toBe("working");
  });

  it("labels MCP and T3 tools as generic work, never as a command", () => {
    expect(grokBotToolActivity("mcp__t3-code__t3_thread_read")).toBe("working");
    expect(grokBotToolActivity("github.read_file")).toBe("working");
    expect(grokBotToolActivity(null)).toBe("working");
  });
});

describe("grokBotInFlightToolActivity", () => {
  it("counts only pending or running calls from the active run", () => {
    expect(
      grokBotInFlightToolActivity({
        activeRunId: RUN,
        turnItems: [toolItem({ toolName: "Bash", status: "running" })],
      }),
    ).toBe("running");
    expect(
      grokBotInFlightToolActivity({
        activeRunId: RUN,
        turnItems: [toolItem({ toolName: "Read", status: "pending" })],
      }),
    ).toBe("reading");
  });

  it("clears once a call is neither pending nor running", () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted", "waiting"]) {
      expect(
        grokBotInFlightToolActivity({
          activeRunId: RUN,
          turnItems: [toolItem({ toolName: "Bash", status })],
        }),
      ).toBeUndefined();
    }
  });

  it("ignores calls from another run and any call when no run is active", () => {
    const otherRun = [toolItem({ toolName: "Bash", status: "running", runId: "run-old" as RunId })];
    expect(grokBotInFlightToolActivity({ activeRunId: RUN, turnItems: otherRun })).toBeUndefined();
    expect(
      grokBotInFlightToolActivity({
        activeRunId: null,
        turnItems: [toolItem({ toolName: "Bash", status: "running" })],
      }),
    ).toBeUndefined();
  });

  it("keeps an older call in flight while a newer one has finished", () => {
    expect(
      grokBotInFlightToolActivity({
        activeRunId: RUN,
        turnItems: [
          toolItem({ toolName: "Grep", status: "running" }),
          toolItem({ toolName: "Read", status: "completed" }),
        ],
      }),
    ).toBe("searching");
  });
});

describe("selectGrokBotToolActivities", () => {
  it("reads detail only for canonical bot threads with an active run", () => {
    const threads = [
      shell({ id: "grok-bot:busy", model: "bot-a" }),
      shell({ id: "manual-chat", model: "bot-a" }),
      shell({
        id: "grok-bot:idle",
        model: "bot-b",
        activeRunId: null,
        activityRunStatus: null,
      }),
      shell({ id: "grok-bot:archived", model: "bot-c", archived: true }),
      shell({
        id: "grok-bot:other-account",
        model: "bot-d",
        instanceId: "grok-bot-old" as ProviderInstanceId,
      }),
    ];
    const readTurnItems = vi.fn((thread: GrokBotThreadActivityShell) =>
      thread.id === "grok-bot:busy" ? [toolItem({ toolName: "Read", status: "running" })] : [],
    );

    const activities = selectGrokBotToolActivities({
      threads,
      instanceId: CURRENT,
      readTurnItems,
    });

    expect([...activities]).toEqual([["bot-a", "reading"]]);
    expect(readTurnItems.mock.calls.map(([thread]) => thread.id)).toEqual(["grok-bot:busy"]);
  });

  it("shows native work while the thread detail is not live", () => {
    const activities = selectGrokBotToolActivities({
      threads: [shell({ id: "grok-bot:busy", model: "bot-a" })],
      instanceId: CURRENT,
      readTurnItems: () => null,
    });

    expect([...activities]).toEqual([["bot-a", "thinking"]]);
  });

  it("keeps a running bot active between tool calls, then clears at run completion", () => {
    const threads = [shell({ id: "grok-bot:busy", model: "bot-a" })];
    const readTurnItems = () => [toolItem({ toolName: "Read", status: "completed" })];
    expect([
      ...selectGrokBotToolActivities({ threads, instanceId: CURRENT, readTurnItems }),
    ]).toEqual([["bot-a", "thinking"]]);
    expect(
      selectGrokBotToolActivities({
        threads: [shell({ id: "grok-bot:busy", model: "bot-a", activityRunStatus: "completed" })],
        instanceId: CURRENT,
        readTurnItems,
      }).size,
    ).toBe(0);
  });
});
