import type { MuseAgentTask } from "@t3tools/contracts";

/** Muse's own schedules, grouped the way the original Muse app lists them. */
export type MuseRoutineGroupId = "reminders" | "daily" | "repeating" | "heartbeat" | "other";

const MUSE_ROUTINE_GROUP_ORDER: ReadonlyArray<MuseRoutineGroupId> = [
  "reminders",
  "daily",
  "repeating",
  "heartbeat",
  "other",
];

const MUSE_ROUTINE_GROUP_LABELS: Readonly<Record<MuseRoutineGroupId, string>> = {
  reminders: "Reminders",
  daily: "Daily",
  repeating: "Repeating",
  heartbeat: "Heartbeat",
  other: "Other",
};

export type MuseRoutineClassification = {
  readonly group: MuseRoutineGroupId;
  /** Human schedule text, such as "Every 5 hours". Unknown shapes keep the raw key. */
  readonly scheduleLabel: string;
};

const EVERY_PATTERN =
  /\bevery\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i;
const TIME_PATTERN = /\b(\d{1,2}):(\d{2})\b/;
// No trailing \b: an ISO timestamp continues with "T", which is a word character.
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/;
const DAILY_PATTERN = /\bdaily\b|\bevery\s+day\b/i;
const ONE_TIME_PATTERN = /\bonce\b|\bone[- ]time\b|\breminder\b/i;

function repeatingLabel(count: number, unit: string): string {
  const normalized = unit.toLowerCase().charAt(0);
  const name = normalized === "m" ? "minute" : normalized === "h" ? "hour" : "day";
  return `Every ${count} ${count === 1 ? name : `${name}s`}`;
}

/**
 * Sorts one Muse task into a group. Muse's schedule key is opaque text, so only shapes we can
 * read are placed in a named group; anything else lands in Other with its raw key shown.
 */
export function classifyMuseRoutine(
  task: Pick<MuseAgentTask, "scheduleKey" | "isHeartbeat">,
): MuseRoutineClassification {
  const key = task.scheduleKey.trim();
  const every = EVERY_PATTERN.exec(key);
  if (task.isHeartbeat) {
    return {
      group: "heartbeat",
      scheduleLabel: every ? repeatingLabel(Number(every[1]), every[2] ?? "") : "Heartbeat",
    };
  }
  if (every) {
    return {
      group: "repeating",
      scheduleLabel: repeatingLabel(Number(every[1]), every[2] ?? ""),
    };
  }
  const time = TIME_PATTERN.exec(key);
  if (DAILY_PATTERN.test(key) || (time && !DATE_PATTERN.test(key) && !ONE_TIME_PATTERN.test(key))) {
    return {
      group: "daily",
      scheduleLabel: time ? `Daily at ${time[0]}` : "Daily",
    };
  }
  if (ONE_TIME_PATTERN.test(key) || DATE_PATTERN.test(key)) {
    return { group: "reminders", scheduleLabel: "One time" };
  }
  return { group: "other", scheduleLabel: key.length > 0 ? key : "No schedule" };
}

export type MuseRoutineGroup = {
  readonly group: MuseRoutineGroupId;
  readonly label: string;
  readonly tasks: ReadonlyArray<MuseAgentTask & { readonly scheduleLabel: string }>;
};

/** Tasks grouped in the fixed Muse order; empty groups are omitted. */
export function groupMuseRoutines(tasks: ReadonlyArray<MuseAgentTask>): MuseRoutineGroup[] {
  const buckets = new Map<MuseRoutineGroupId, MuseRoutineGroup["tasks"][number][]>();
  for (const task of tasks) {
    const { group, scheduleLabel } = classifyMuseRoutine(task);
    const bucket = buckets.get(group) ?? [];
    bucket.push({ ...task, scheduleLabel });
    buckets.set(group, bucket);
  }
  return MUSE_ROUTINE_GROUP_ORDER.flatMap((group) => {
    const bucket = buckets.get(group);
    return bucket ? [{ group, label: MUSE_ROUTINE_GROUP_LABELS[group], tasks: bucket }] : [];
  });
}
