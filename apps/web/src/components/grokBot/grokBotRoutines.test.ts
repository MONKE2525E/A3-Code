import { EnvironmentId, type GrokBotRoutine as GrokBotRoutineSchema } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

type GrokBotRoutine = typeof GrokBotRoutineSchema.Type;

import {
  GROK_BOT_ROUTINES_SETTINGS_HASH,
  grokBotRoutineNextRunIso,
  grokBotRoutinesSettingsSearch,
  groupGrokBotRoutines,
  grokBotRoutineSummary,
} from "./grokBotRoutines";

const routine = (botId: string, id: string, overrides: Partial<GrokBotRoutine> = {}) =>
  ({
    botId,
    id,
    name: id,
    schedule: "Every day",
    triggerDescription: "Schedule",
    isEnabled: true,
    createdAt: 1,
    ...overrides,
  }) as GrokBotRoutine;

describe("groupGrokBotRoutines", () => {
  it("follows roster order and keeps unknown bots last with their id", () => {
    const groups = groupGrokBotRoutines(
      [routine("b", "1"), routine("ghost", "2"), routine("a", "3"), routine("a", "4")],
      [
        { id: "a", name: "Alpha", label: "alpha" },
        { id: "b", name: "", label: "Beta" },
      ] as never,
    );
    expect(groups.map((g) => [g.botLabel, g.routines.length])).toEqual([
      ["Alpha", 2],
      ["Beta", 1],
      ["ghost", 1],
    ]);
  });
});

describe("grokBotRoutineSummary", () => {
  it("prefers native triggerDescription over a raw cron schedule", () => {
    expect(
      grokBotRoutineSummary(
        routine("a", "1", {
          schedule: "CRON_TZ=America/Vancouver 44 8 * * 1-5",
          triggerDescription: "Weekdays at 8:44 AM",
        }),
      ),
    ).toBe("Weekdays at 8:44 AM");
  });

  it("humanizes a cron schedule when triggerDescription is blank", () => {
    expect(
      grokBotRoutineSummary(
        routine("a", "1", {
          schedule: "CRON_TZ=America/Vancouver 44 8 * * 1-5",
          triggerDescription: "  ",
        }),
      ),
    ).toBe("Weekdays at 8:44 AM");
    expect(
      grokBotRoutineSummary(routine("a", "1", { schedule: " ", triggerDescription: "" })),
    ).toBe("No schedule details");
  });

  it("humanizes native cron that was left unformatted", () => {
    expect(
      grokBotRoutineSummary(
        routine("a", "1", {
          schedule: "CRON_TZ=America/Vancouver 2 3 */2 * *",
          triggerDescription: "CRON_TZ=America/Vancouver 2 3 */2 * *",
        }),
      ),
    ).toBe("Every 2 days at 3:02 AM");
    expect(
      grokBotRoutineSummary(
        routine("a", "1", {
          schedule: "CRON_TZ=America/Vancouver 17 23,0-6 * * *",
          triggerDescription: "CRON_TZ=America/Vancouver 17 23,0-6 * * *",
        }),
      ),
    ).toBe("Every day at 11:17 PM–6:17 AM");
  });

  it("keeps webhook trigger details from the native label", () => {
    expect(
      grokBotRoutineSummary(
        routine("a", "1", { schedule: "Webhook", triggerDescription: "Webhook" }),
      ),
    ).toBe("Webhook");
    expect(
      grokBotRoutineSummary(
        routine("a", "1", {
          schedule: "https://hooks.example/x",
          triggerDescription: "Webhook from GitHub",
        }),
      ),
    ).toBe("Webhook from GitHub");
  });
});

describe("grokBotRoutinesSettingsSearch", () => {
  it("writes the clicked environment onto both settings axes", () => {
    expect(GROK_BOT_ROUTINES_SETTINGS_HASH).toBe("grok-bot-routines");
    expect(grokBotRoutinesSettingsSearch(EnvironmentId.make("env-bot"))).toEqual({
      machine: "env-bot",
      environmentId: "env-bot",
    });
  });
});

describe("grokBotRoutineNextRunIso", () => {
  it("treats nextRunAt as epoch milliseconds", () => {
    expect(grokBotRoutineNextRunIso(1_800_000_000_000)).toBe("2027-01-15T08:00:00.000Z");
    expect(grokBotRoutineNextRunIso(undefined)).toBeNull();
    expect(grokBotRoutineNextRunIso(Number.NaN)).toBeNull();
  });
});
