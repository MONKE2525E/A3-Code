import type {
  EnvironmentId,
  GrokBot,
  GrokBotRoutine as GrokBotRoutineSchema,
} from "@t3tools/contracts";

type GrokBotRoutine = typeof GrokBotRoutineSchema.Type;

/** Settings section id for native Grok Bot routines on Scheduled tasks. */
export const GROK_BOT_ROUTINES_SETTINGS_HASH = "grok-bot-routines";

/** Settings scope uses `machine`; scheduled-tasks also reads `environmentId`. */
export function grokBotRoutinesSettingsSearch(environmentId: EnvironmentId): {
  readonly machine: EnvironmentId;
  readonly environmentId: EnvironmentId;
} {
  return { machine: environmentId, environmentId };
}

export interface GrokBotRoutineGroup {
  readonly botId: string;
  readonly botLabel: string;
  readonly routines: readonly GrokBotRoutine[];
}

/** Groups routines under their bot in roster order. Routines of bots missing from the roster keep the bot id as label. */
export function groupGrokBotRoutines(
  routines: readonly GrokBotRoutine[],
  roster: readonly Pick<GrokBot, "id" | "name" | "label">[],
): readonly GrokBotRoutineGroup[] {
  const groups = new Map<string, GrokBotRoutine[]>();
  for (const routine of routines) {
    const list = groups.get(routine.botId);
    if (list) list.push(routine);
    else groups.set(routine.botId, [routine]);
  }
  const ordered = roster.flatMap((bot) => {
    const list = groups.get(bot.id);
    if (!list) return [];
    groups.delete(bot.id);
    return [{ botId: bot.id, botLabel: bot.name || bot.label || bot.id, routines: list }];
  });
  for (const [botId, list] of groups) ordered.push({ botId, botLabel: botId, routines: list });
  return ordered;
}

const CRON_TZ_PREFIX = /^(?:CRON_TZ|TZ)=\S+\s+/;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function normalizeCronSource(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function cronBody(value: string): string {
  return normalizeCronSource(value).replace(CRON_TZ_PREFIX, "");
}

function grokBotCronLooksRaw(value: string): boolean {
  const text = normalizeCronSource(value);
  if (text.length === 0) return false;
  const body = cronBody(text);
  const fields = body.split(" ");
  if (fields.length !== 5) return false;
  return (
    CRON_TZ_PREFIX.test(text) || /[*/,-]/.test(body) || fields.every((field) => /^\d+$/.test(field))
  );
}

function expandCronField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangeRaw, stepRaw] = part.split("/");
    const range = rangeRaw ?? "";
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return null;
    let start: number;
    let end: number;
    if (range === "*" || range === "") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [left, right] = range.split("-");
      start = Number(left);
      end = Number(right);
    } else {
      const exact = Number(range);
      if (!Number.isInteger(exact)) return null;
      start = exact;
      end = stepRaw === undefined ? exact : max;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      return null;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size === 0 ? null : [...values].sort((a, b) => a - b);
}

function expandDow(field: string): number[] | null {
  const values = expandCronField(field, 0, 7);
  if (values === null) return null;
  return [...new Set(values.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b);
}

function formatClock(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function circularRange(
  values: readonly number[],
  modulus: number,
): { start: number; end: number } | null {
  if (values.length === 0 || values.length > modulus) return null;
  if (values.length === modulus) return { start: values[0]!, end: values[values.length - 1]! };
  const present = new Set(values);
  const starts = values.filter((value) => !present.has((value - 1 + modulus) % modulus));
  if (starts.length !== 1) return null;
  const start = starts[0]!;
  for (let offset = 0; offset < values.length; offset += 1) {
    if (!present.has((start + offset) % modulus)) return null;
  }
  return { start, end: (start + values.length - 1) % modulus };
}

function describeDays(dayOfMonth: string, dayOfWeek: string): string | null {
  if (dayOfMonth === "*" && dayOfWeek === "*") return "Every day";
  const stepMatch = /^\*\/(\d+)$/.exec(dayOfMonth);
  if (dayOfWeek === "*" && stepMatch !== null) {
    const step = Number(stepMatch[1]);
    if (!Number.isInteger(step) || step <= 0) return null;
    return step === 1 ? "Every day" : `Every ${step} days`;
  }
  if (dayOfMonth !== "*" || dayOfWeek === "*") return null;
  const days = expandDow(dayOfWeek);
  if (days === null) return null;
  if (days.length === 5 && days.every((day, index) => day === index + 1)) return "Weekdays";
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return "Weekends";
  if (days.length === 1) return `Every ${WEEKDAYS[days[0]!]}`;
  if (days.length <= 3) return `Every ${joinWords(days.map((day) => WEEKDAYS[day]!))}`;
  return null;
}

function describeTime(minuteField: string, hourField: string): string | null {
  const minutes = expandCronField(minuteField, 0, 59);
  const hours = expandCronField(hourField, 0, 23);
  if (minutes === null || hours === null || minutes.length !== 1) return null;
  const minute = minutes[0]!;
  if (hours.length === 1) return `at ${formatClock(hours[0]!, minute)}`;
  if (hours.length === 24) {
    return minute === 0 ? "every hour" : `every hour at :${String(minute).padStart(2, "0")}`;
  }
  const range = circularRange(hours, 24);
  if (range !== null && hours.length > 2) {
    return `at ${formatClock(range.start, minute)}–${formatClock(range.end, minute)}`;
  }
  if (hours.length <= 3) return `at ${joinWords(hours.map((hour) => formatClock(hour, minute)))}`;
  return null;
}

/** Human label for a native cron string. Unrecognized expressions stay null. */
function grokBotCronLabel(schedule: string): string | null {
  const fields = cronBody(schedule).split(" ");
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (month !== "*" || minute === undefined || hour === undefined) return null;
  const days = describeDays(dayOfMonth ?? "*", dayOfWeek ?? "*");
  const time = describeTime(minute, hour);
  if (days === null || time === null) return null;
  if (time.startsWith("every ")) {
    const interval = `${time[0]?.toUpperCase() ?? ""}${time.slice(1)}`;
    return days === "Every day" ? interval : `${interval} ${days.toLowerCase()}`;
  }
  if (days === "Every day") return `Every day ${time}`;
  return `${days} ${time}`;
}

/** Native human trigger copy when present; otherwise a formatted cron or the raw schedule. */
export function grokBotRoutineSummary(routine: GrokBotRoutine): string {
  const trigger = routine.triggerDescription.trim();
  const schedule = routine.schedule.trim();
  const preferred = trigger.length > 0 ? trigger : schedule;
  if (preferred.length === 0) return "No schedule details";
  if (!grokBotCronLooksRaw(preferred)) return preferred;
  return grokBotCronLabel(preferred) ?? cronBody(preferred);
}

/** Native `nextRunAt` is epoch milliseconds. Invalid numbers are treated as unscheduled. */
export function grokBotRoutineNextRunIso(nextRunAt: number | undefined): string | null {
  if (nextRunAt === undefined) return null;
  const date = new Date(nextRunAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
