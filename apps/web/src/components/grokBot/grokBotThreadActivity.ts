import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
} from "@t3tools/contracts";
import { classifyToolActivity } from "@t3tools/shared/toolActivity";

import type { GrokBotActivity } from "./grokBotActivity";
import { findGrokBotNativeThread } from "./grokBotNativeThread";

/** The avatar states a tool call can show. Only the tool name decides which one. */
export type GrokBotToolActivity = Extract<
  GrokBotActivity,
  "running" | "reading" | "searching" | "writing" | "working"
>;

/** Native run activity is visible even before a tool starts or its detail arrives. */
export type GrokBotThreadActivity = GrokBotToolActivity | "thinking";

/** Shell fields that say whether a bot thread has a run in flight. */
export type GrokBotThreadActivityShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "providerInstanceId"
  | "modelSelection"
  | "archivedAt"
  | "createdAt"
  | "activeRunId"
  | "status"
  | "activityRunStatus"
>;

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

export const GROK_BOT_TOOL_ACTIVITY_LABELS: Record<GrokBotThreadActivity, string> = {
  thinking: "Working",
  running: "Running a command",
  reading: "Reading files",
  searching: "Searching files",
  writing: "Writing files",
  working: "Using tools",
};

/**
 * Maps a tool name onto the shared classifier. Only the name is read, never its
 * arguments or output. MCP and T3 tools carry a `__` or `.` and fall to "working".
 */
export function grokBotToolActivity(toolName: string | null): GrokBotToolActivity {
  switch (
    classifyToolActivity({
      itemType: "dynamic_tool_call",
      data: { toolName: toolName ?? undefined },
    })
  ) {
    case "command":
      return "running";
    case "read":
      return "reading";
    case "search":
      return "searching";
    case "file_change":
      return "writing";
    case "other":
      return "working";
  }
}

/**
 * The tool call a bot is in the middle of. Only pending or running calls from the
 * thread's current run count, so a finished, cancelled, or prior-run call never
 * shows. When several calls are in flight, the most recent one wins.
 */
export function grokBotInFlightToolActivity(input: {
  readonly activeRunId: RunId | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): GrokBotToolActivity | undefined {
  if (input.activeRunId === null) return undefined;
  for (let index = input.turnItems.length - 1; index >= 0; index -= 1) {
    const item = input.turnItems[index];
    if (item?.type !== "dynamic_tool" || item.runId !== input.activeRunId) continue;
    if (item.status === "pending" || item.status === "running") {
      return grokBotToolActivity(item.toolName);
    }
  }
  return undefined;
}

/**
 * Run or tool activity for each bot in one provider instance. Only the bot's matched native
 * thread is considered, and its detail is read only when that thread has an active
 * run. Idle bots and archived threads never reach `readTurnItems`, so they add no
 * detail subscription. A running shell remains visible while its tools load or finish.
 */
export function selectGrokBotToolActivities<T extends GrokBotThreadActivityShell>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly instanceId: ProviderInstanceId;
  /** Turn items of a thread whose detail is live; null while it is loading, cached, or gone. */
  readonly readTurnItems: (thread: T) => ReadonlyArray<OrchestrationV2TurnItem> | null;
}): ReadonlyMap<string, GrokBotThreadActivity> {
  const botIds = new Set<string>();
  for (const thread of input.threads) {
    if (thread.providerInstanceId === input.instanceId) botIds.add(thread.modelSelection.model);
  }
  const activities = new Map<string, GrokBotThreadActivity>();
  for (const botId of botIds) {
    const thread = findGrokBotNativeThread(input.threads, {
      instanceId: input.instanceId,
      botId,
    });
    if (
      thread === null ||
      thread.archivedAt !== null ||
      thread.activeRunId === null ||
      !ACTIVE_RUN_STATUSES.has(thread.activityRunStatus ?? thread.status)
    ) {
      continue;
    }
    const turnItems = input.readTurnItems(thread);
    const activity =
      turnItems === null
        ? undefined
        : grokBotInFlightToolActivity({ activeRunId: thread.activeRunId, turnItems });
    activities.set(botId, activity ?? "thinking");
  }
  return activities;
}
