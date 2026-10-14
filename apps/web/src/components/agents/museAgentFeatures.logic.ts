import type {
  MuseAgentComputerTask,
  MuseAgentConnector,
  MuseAgentFeatureInventory,
  MuseAgentFeatureSession,
  MuseAgentSkill,
} from "@t3tools/contracts";

const MUSE_FEATURE_TABS = [
  { id: "memory", label: "Memory" },
  { id: "routines", label: "Routines" },
  { id: "connections", label: "Connections" },
  { id: "skills", label: "Skills" },
  { id: "conversations", label: "Conversations" },
  { id: "computer", label: "Computer" },
  { id: "dictation", label: "Dictation" },
  { id: "profile", label: "Profile" },
] as const;
export type MuseFeatureTabId = (typeof MUSE_FEATURE_TABS)[number]["id"];

/** Inventory feature each tab depends on; "tasks" are the native routines. */
const TAB_FEATURE: Record<MuseFeatureTabId, string> = {
  memory: "memory",
  routines: "tasks",
  connections: "connectors",
  skills: "skills",
  conversations: "sessions",
  computer: "computer",
  dictation: "dictation",
  profile: "profile",
};

export type MuseTabSupport = "unknown" | "documented" | "unavailable";

/**
 * Documented only means the server implements it from native client evidence. It never means the
 * signed-in account has it, so the tab stays "unknown" until its own query succeeds.
 */
export function resolveMuseTabSupport(
  inventory: MuseAgentFeatureInventory | null | undefined,
  tab: MuseFeatureTabId,
): MuseTabSupport {
  const entry = inventory?.features.find((feature) => feature.feature === TAB_FEATURE[tab]);
  if (!entry) return "unknown";
  return entry.support === "unavailable" ? "unavailable" : "documented";
}

export function formatMuseNextRun(nextRunAtUtc: number | undefined, now: number): string | null {
  if (nextRunAtUtc === undefined || !Number.isFinite(nextRunAtUtc)) return null;
  // Muse reports `nextRunAtUtc` as Unix epoch seconds.
  const ms = nextRunAtUtc * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const label = date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return ms < now ? `Was due ${label}` : `Next ${label}`;
}

export type MuseConnectorPresentation = {
  readonly label: string;
  readonly tone: "success" | "muted" | "warning";
};

/** Read-only: Muse's own app owns OAuth, so there is no connect action to offer. */
export function describeMuseConnector(
  connector: Pick<MuseAgentConnector, "state">,
): MuseConnectorPresentation {
  switch (connector.state) {
    case "connected":
      return { label: "Connected", tone: "success" };
    case "disconnected":
      return { label: "Not connected", tone: "muted" };
    case "coming_soon":
      return { label: "Coming soon", tone: "muted" };
    case "unknown":
      return { label: "Status unavailable", tone: "warning" };
  }
}

export type MuseSkillPresentation = {
  readonly label: string;
  readonly detail: string | null;
  readonly tone: "success" | "muted" | "warning";
};

/** Reports only what the server sent; a skill with no flags is "unknown", never "enabled". */
export function describeMuseSkill(skill: MuseAgentSkill): MuseSkillPresentation {
  const reason = skill.statusReason?.trim() || null;
  if (skill.blockedByAllowlist) {
    return { label: "Blocked by policy", detail: reason, tone: "warning" };
  }
  if (skill.userDisabled || skill.disabled || skill.enabled === false) {
    return { label: "Turned off", detail: reason, tone: "muted" };
  }
  if (skill.eligible === false) {
    return {
      label: skill.requiresAuth ? "Needs sign-in" : "Not eligible",
      detail: reason,
      tone: "warning",
    };
  }
  if (skill.enabled === true || skill.eligible === true) {
    return { label: "Available", detail: reason, tone: "success" };
  }
  return { label: "Status unknown", detail: reason, tone: "muted" };
}

export function groupMuseSkills(
  skills: ReadonlyArray<MuseAgentSkill>,
): ReadonlyArray<{ readonly category: string; readonly skills: ReadonlyArray<MuseAgentSkill> }> {
  const groups = new Map<string, MuseAgentSkill[]>();
  for (const skill of skills) {
    const category = skill.category.trim() || "Other";
    const bucket = groups.get(category);
    if (bucket) bucket.push(skill);
    else groups.set(category, [skill]);
  }
  return [...groups.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([category, items]) => ({
      category,
      skills: items.toSorted((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name)),
    }));
}

export type MuseSessionActions = {
  readonly canRename: boolean;
  readonly archiveAction: "archive" | "unarchive";
  readonly stateLabel: string | null;
};

/** The primary session anchors Muse itself, so it can be renamed but never archived. */
export function resolveMuseSessionActions(
  session: Pick<MuseAgentFeatureSession, "isPrimary" | "archived" | "readOnlyReason">,
): MuseSessionActions & { readonly canArchive: boolean } {
  const archived = session.archived === true;
  return {
    canRename: !archived,
    canArchive: !session.isPrimary,
    archiveAction: archived ? "unarchive" : "archive",
    stateLabel: archived ? "Archived" : session.isPrimary ? "Main chat" : null,
  };
}

export function museSessionTitle(
  session: Pick<MuseAgentFeatureSession, "title" | "snippet" | "isPrimary">,
): string {
  return (
    session.title?.trim() ||
    (session.isPrimary ? "Main conversation" : session.snippet?.trim()) ||
    "Untitled conversation"
  );
}

export function describeMuseComputerTask(task: MuseAgentComputerTask): string {
  const status = task.displayStatus?.trim() || task.status?.trim() || "Unknown status";
  if (task.queuePosition !== undefined) return `${status} · queue position ${task.queuePosition}`;
  return status;
}

/** Memory text may be long markdown; the list shows a short, plain first slice only. */
export function museMemoryPreview(text: string | undefined, limit = 160): string | null {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

/** Composer seed for editing a routine; matches the official Muse client's wording. */
export function museRoutineEditPrompt(title: string): string {
  return `Edit my scheduled task \u201c${title}\u201d:`;
}
