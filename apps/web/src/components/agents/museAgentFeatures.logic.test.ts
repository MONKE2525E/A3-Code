import { describe, expect, it } from "vite-plus/test";

import {
  describeMuseConnector,
  describeMuseSkill,
  formatMuseNextRun,
  groupMuseSkills,
  museMemoryPreview,
  museRoutineEditPrompt,
  museSessionTitle,
  museSkillMatches,
  resolveMuseSessionActions,
  resolveMuseTabSupport,
} from "./museAgentFeatures.logic";

describe("museAgentFeatures.logic", () => {
  it("never reports a tab as account-verified from the inventory", () => {
    expect(resolveMuseTabSupport(null, "skills")).toBe("unknown");
    const inventory = {
      accountAvailability: "unverified",
      features: [
        { feature: "tasks", operations: ["list"], support: "documented" },
        {
          feature: "computer",
          operations: [],
          support: "unavailable",
          unavailableReason: "native_protocol_unverified",
        },
      ],
    } as const;
    expect(resolveMuseTabSupport(inventory, "routines")).toBe("documented");
    expect(resolveMuseTabSupport(inventory, "computer")).toBe("unavailable");
    expect(resolveMuseTabSupport(inventory, "skills")).toBe("unknown");
  });

  it("shows unknown connector and skill state instead of inventing one", () => {
    expect(describeMuseConnector({ state: "unknown" }).label).toBe("Status unavailable");
    const unknown = describeMuseSkill({ name: "a", description: "", category: "x" });
    expect(unknown.label).toBe("Status unknown");
    expect(unknown.showBadge).toBe(false);
    expect(
      describeMuseSkill({ name: "a", description: "", category: "x", eligible: false }),
    ).toMatchObject({ label: "Not eligible", showBadge: true });
    expect(
      describeMuseSkill({
        name: "a",
        description: "",
        category: "x",
        eligible: false,
        requiresAuth: true,
      }),
    ).toMatchObject({ label: "Needs sign-in", showBadge: true });
    const enabledFalse = describeMuseSkill({
      name: "a",
      description: "",
      category: "x",
      enabled: false,
    });
    expect(enabledFalse.label).not.toBe("Turned off");
    expect(enabledFalse.showBadge).toBe(false);
    expect(
      describeMuseSkill({ name: "a", description: "", category: "x", disabled: true }),
    ).toMatchObject({ label: "Turned off", showBadge: true });
    expect(
      describeMuseSkill({ name: "a", description: "", category: "x", userDisabled: true }),
    ).toMatchObject({ label: "Turned off", showBadge: true });
  });

  it("keeps the primary conversation from being archived and archived ones restorable", () => {
    const primary = resolveMuseSessionActions({ isPrimary: true });
    expect(primary.canArchive).toBe(false);
    const archived = resolveMuseSessionActions({ isPrimary: false, archived: true });
    expect(archived.archiveAction).toBe("unarchive");
    expect(archived.canRename).toBe(false);
  });

  it("reads nextRunAtUtc as epoch seconds", () => {
    const seconds = 1_900_000_000;
    expect(formatMuseNextRun(seconds, (seconds - 60) * 1000)).toMatch(/^Next /);
    expect(formatMuseNextRun(seconds, (seconds + 60) * 1000)).toMatch(/^Was due /);
    expect(formatMuseNextRun(undefined, 0)).toBeNull();
  });

  it("falls back through title, snippet, and a default", () => {
    expect(museSessionTitle({ isPrimary: false, snippet: " hello " })).toBe("hello");
    expect(museSessionTitle({ isPrimary: false })).toBe("Untitled conversation");
  });

  it("groups skills by category and previews memory as one plain line", () => {
    const groups = groupMuseSkills([
      { name: "b", description: "", category: "Zed" },
      { name: "a", description: "", category: "Alpha" },
    ]);
    expect(groups.map((group) => group.category)).toEqual(["Alpha", "Zed"]);
    expect(museMemoryPreview("# Title\n\nbody   text", 12)).toBe("# Title body…");
    expect(museMemoryPreview("  ")).toBeNull();
  });

  it("maps uncategorized skills to Other and matches search text", () => {
    const groups = groupMuseSkills([
      { name: "b", description: "beta tool", category: "uncategorized" },
      { name: "a", description: "", category: "  " },
    ]);
    expect(groups.map((group) => group.category)).toEqual(["Other"]);
    expect(
      museSkillMatches({ name: "b", description: "beta tool", category: "uncategorized" }, "beta"),
    ).toBe(true);
    expect(
      museSkillMatches({ name: "b", description: "beta tool", category: "uncategorized" }, "alpha"),
    ).toBe(false);
  });
});

describe("museRoutineEditPrompt", () => {
  it("quotes the routine name with curly quotes", () => {
    expect(museRoutineEditPrompt('Daily "digest"')).toBe(
      'Edit my scheduled task \u201cDaily "digest"\u201d:',
    );
  });
});
