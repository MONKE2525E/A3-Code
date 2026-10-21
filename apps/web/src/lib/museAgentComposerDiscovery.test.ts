import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type MuseAgentConnector,
  type MuseAgentSkill,
} from "@t3tools/contracts";

import {
  isMuseComposerConnectionUsable,
  isMuseComposerSkillInvocable,
  museComposerApplySelection,
  museComposerConnectionDescription,
  museComposerConnectionPrompt,
  museComposerConnections,
  museComposerDiscoveryReads,
  museComposerDollarPickerItems,
  museComposerGuardTypedSlash,
  museComposerResolveStop,
  museComposerRunnableSlashCommands,
  museComposerSkillPrompt,
  museComposerSkills,
  museComposerSlashPickerItems,
  museComposerSlashTransport,
  museSkillToProviderSkill,
  MUSE_NATIVE_SLASH_COMMANDS,
  searchMuseComposerConnectors,
  searchMuseComposerSkills,
} from "./museAgentComposerDiscovery";

function skill(partial: Partial<MuseAgentSkill> & Pick<MuseAgentSkill, "name">): MuseAgentSkill {
  return {
    description: "",
    category: "tools",
    ...partial,
  };
}

function connector(
  partial: Partial<MuseAgentConnector> & Pick<MuseAgentConnector, "id" | "name" | "state">,
): MuseAgentConnector {
  return { description: "", ...partial };
}

describe("museAgentComposerDiscovery", () => {
  it("keeps registry skills that omit enabled/disabled flags", () => {
    const listed = skill({
      name: "web-search",
      title: "Web Search",
      description: "Search the web",
    });
    expect(isMuseComposerSkillInvocable(listed)).toBe(true);
    expect(museComposerSkills([listed])).toEqual([listed]);
  });

  it("excludes only explicit disabled, ineligible, or blocked skills", () => {
    expect(isMuseComposerSkillInvocable(skill({ name: "a", disabled: true }))).toBe(false);
    expect(isMuseComposerSkillInvocable(skill({ name: "b", userDisabled: true }))).toBe(false);
    expect(isMuseComposerSkillInvocable(skill({ name: "c", eligible: false }))).toBe(false);
    expect(isMuseComposerSkillInvocable(skill({ name: "d", blockedByAllowlist: true }))).toBe(
      false,
    );
    expect(isMuseComposerSkillInvocable(skill({ name: "e", enabled: false }))).toBe(true);
    expect(isMuseComposerSkillInvocable(skill({ name: "f", enabled: true }))).toBe(true);
  });

  it("maps a native skill onto a provider chip without a workspace path", () => {
    const mapped = museSkillToProviderSkill(
      skill({
        name: "review-pr",
        title: "Review PR",
        description: "Review a pull request",
      }),
    );
    expect(mapped).toEqual({
      name: "review-pr",
      path: "review-pr",
      enabled: true,
      scope: "other",
      displayName: "Review PR",
      description: "Review a pull request",
      shortDescription: "Review a pull request",
    });
    expect(mapped.path.includes("/")).toBe(false);
    expect("body" in mapped).toBe(false);
  });

  it("does not treat unknown connector availability as disconnected", () => {
    const unknown = connector({ id: "linear", name: "Linear", state: "unknown" });
    expect(isMuseComposerConnectionUsable(unknown)).toBe(true);
    expect(museComposerConnectionDescription(unknown)).toBe("Status unavailable");
    expect(museComposerConnectionDescription(unknown)).not.toMatch(/disconnect/i);
    expect(
      museComposerConnections([
        unknown,
        connector({ id: "soon", name: "Soon", state: "coming_soon" }),
        connector({ id: "gh", name: "GitHub", state: "connected" }),
      ]).map((item) => item.id),
    ).toEqual(["linear", "gh"]);
  });

  it("inserts a connection prompt without an @ mention", () => {
    const prompt = museComposerConnectionPrompt({ name: "Linear" });
    expect(prompt).toBe("Use the Linear connection. ");
    expect(prompt.startsWith("@")).toBe(false);
    expect(prompt.includes("@Linear")).toBe(false);
  });

  it("lists skills and connections for a bare $ trigger", () => {
    const skills = [
      skill({ name: "web-search", title: "Web Search" }),
      skill({ name: "hidden", disabled: true }),
    ];
    const connectors = [
      connector({ id: "linear", name: "Linear", state: "connected" }),
      connector({ id: "soon", name: "Soon", state: "coming_soon" }),
    ];
    expect(searchMuseComposerSkills(skills, "$").map((item) => item.name)).toEqual(["web-search"]);
    expect(searchMuseComposerSkills(skills, "web").map((item) => item.name)).toEqual([
      "web-search",
    ]);
    expect(searchMuseComposerConnectors(connectors, "").map((item) => item.id)).toEqual(["linear"]);
    expect(searchMuseComposerConnectors(connectors, "lin").map((item) => item.name)).toEqual([
      "Linear",
    ]);
  });

  it("keeps native slash names documented but only offers /stop in suggestions", () => {
    expect(MUSE_NATIVE_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "status",
      "compact",
      "clear",
      "usage",
      "subagents",
      "stop",
      "latest",
      "activity",
    ]);
    expect(museComposerRunnableSlashCommands().map((command) => command.name)).toEqual(["stop"]);
    expect(museComposerSlashTransport({ name: "compact" })).toBe("unimplemented");
    expect(museComposerSlashTransport({ name: "stop" })).toBe("stop");
    expect(MUSE_NATIVE_SLASH_COMMANDS.some((command) => command.name === "model")).toBe(false);
  });

  it("inserts a Use skill directive instead of a $name or filesystem path", () => {
    const prompt = museComposerSkillPrompt({ name: "web-search" });
    expect(prompt).toBe("Use skill web-search. ");
    expect(prompt.startsWith("$")).toBe(false);
    expect(prompt.includes("/web-search")).toBe(false);
    expect(prompt.includes("SKILL.md")).toBe(false);
  });

  it("offers /stop plus the same skill and connection prompt replacements on /", () => {
    const skills = [skill({ name: "web-search", title: "Web Search" })];
    const connectors = [connector({ id: "linear", name: "Linear", state: "connected" })];
    const dollar = museComposerDollarPickerItems(skills, connectors, "");
    const slash = museComposerSlashPickerItems(skills, connectors, "");
    expect(dollar.map((item) => item.kind)).toEqual(["skill", "connector"]);
    expect(slash.filter((item) => item.kind === "slash").map((item) => item.command.name)).toEqual([
      "stop",
    ]);
    expect(slash.some((item) => item.kind === "slash" && item.command.name === "compact")).toBe(
      false,
    );
    expect(slash.some((item) => item.kind === "slash" && item.command.name === "model")).toBe(
      false,
    );
    expect(slash.filter((item) => item.kind !== "slash")).toEqual(dollar);
    expect(museComposerApplySelection({ kind: "skill", skill: skills[0]! })).toEqual({
      action: "replace",
      text: "Use skill web-search. ",
    });
    expect(museComposerApplySelection({ kind: "connector", connector: connectors[0]! })).toEqual({
      action: "replace",
      text: "Use the Linear connection. ",
    });
    expect(
      museComposerApplySelection({
        kind: "slash",
        command: MUSE_NATIVE_SLASH_COMMANDS.find((command) => command.name === "stop")!,
        transport: "stop",
      }),
    ).toEqual({ action: "stop" });
  });

  it("guards typed unsupported Muse slash commands and /model", () => {
    expect(museComposerGuardTypedSlash("Use skill web-search. ")).toEqual({ action: "allow" });
    expect(museComposerGuardTypedSlash("/stop")).toEqual({ action: "stop" });
    expect(museComposerGuardTypedSlash("/compact")).toEqual({
      action: "block",
      command: "compact",
      message: "/compact is not wired in T3 yet.",
    });
    expect(museComposerGuardTypedSlash("/status now")).toEqual({
      action: "block",
      command: "status",
      message: "/status is not wired in T3 yet.",
    });
    expect(museComposerGuardTypedSlash("/history")).toEqual({
      action: "block",
      command: "latest",
      message: "/latest is not wired in T3 yet.",
    });
    expect(museComposerGuardTypedSlash("/model")).toEqual({
      action: "block",
      command: "model",
      message: "Muse's model cannot be changed from this composer.",
    });
    expect(museComposerGuardTypedSlash("please /compact later")).toEqual({ action: "allow" });
  });

  it("tells the user nothing is running when /stop cannot interrupt", () => {
    expect(museComposerResolveStop(true)).toEqual({ action: "interrupt" });
    expect(museComposerResolveStop(false)).toEqual({
      action: "idle",
      message: "Nothing is running to stop",
    });
    expect(museComposerGuardTypedSlash("/stop")).toEqual({ action: "stop" });
  });

  it("binds skill and connector reads to the same provider instance", () => {
    const providerInstanceId = ProviderInstanceId.make("muse-on-host");
    expect(museComposerDiscoveryReads(providerInstanceId)).toEqual({
      skills: { operation: "skills", providerInstanceId },
      connectors: { operation: "connectors", providerInstanceId },
    });
  });
});
