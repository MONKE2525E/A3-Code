import type {
  MuseAgentConnector,
  MuseAgentSkill,
  ProviderInstanceId,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

/**
 * Native Muse 6.0 composer slash commands from the cached client. Gateway
 * commands are sent to the native session; local ones stay in the Muse app UI.
 */
export type MuseNativeSlashCommandKind = "gateway" | "local";

export type MuseNativeSlashCommand = {
  readonly name: string;
  readonly description: string;
  readonly kind: MuseNativeSlashCommandKind;
  readonly aliases?: readonly string[];
  readonly args?: string;
};

export const MUSE_NATIVE_SLASH_COMMANDS: readonly MuseNativeSlashCommand[] = [
  { name: "status", description: "Show current session status", kind: "gateway" },
  { name: "compact", description: "Compact conversation context", kind: "gateway" },
  { name: "clear", description: "Start a fresh context on the next message", kind: "gateway" },
  {
    name: "usage",
    description: "Toggle usage display",
    kind: "gateway",
    args: "on | off",
  },
  { name: "subagents", description: "List sub-agents", kind: "gateway" },
  { name: "stop", description: "Stop the current response", kind: "local" },
  {
    name: "latest",
    description: "Jump back to the latest transcript view",
    kind: "local",
    aliases: ["history"],
  },
  { name: "activity", description: "Open the Activity panel", kind: "local" },
];

export type MuseComposerSlashTransport = "stop" | "unimplemented";

/** T3 can run `/stop` as interrupt. Native Muse has no compact method here. */
export function museComposerSlashTransport(
  command: Pick<MuseNativeSlashCommand, "name">,
): MuseComposerSlashTransport {
  return command.name === "stop" ? "stop" : "unimplemented";
}

export function museComposerRunnableSlashCommands(): readonly MuseNativeSlashCommand[] {
  return MUSE_NATIVE_SLASH_COMMANDS.filter(
    (command) => museComposerSlashTransport(command) === "stop",
  );
}

export type MuseComposerPickerItem =
  | { readonly kind: "skill"; readonly skill: MuseAgentSkill }
  | { readonly kind: "connector"; readonly connector: MuseAgentConnector }
  | {
      readonly kind: "slash";
      readonly command: MuseNativeSlashCommand;
      readonly transport: MuseComposerSlashTransport;
    };

export type MuseComposerSelection =
  | { readonly action: "replace"; readonly text: string }
  | { readonly action: "stop" }
  | { readonly action: "unimplemented"; readonly command: string; readonly message: string };

export type MuseTypedSlashGuard =
  | { readonly action: "allow" }
  | { readonly action: "stop" }
  | { readonly action: "block"; readonly command: string; readonly message: string };

/** Native registry has no load-scope descriptor; insert a prompt directive. */
export function museComposerSkillPrompt(skill: Pick<MuseAgentSkill, "name">): string {
  return `Use skill ${skill.name}. `;
}

export function museComposerUnimplementedSlashMessage(command: string): string {
  return `/${command} is not wired in T3 yet.`;
}

export const MUSE_STOP_IDLE_MESSAGE = "Nothing is running to stop";

export function museComposerResolveStop(
  canInterrupt: boolean,
): { readonly action: "interrupt" } | { readonly action: "idle"; readonly message: string } {
  return canInterrupt
    ? { action: "interrupt" }
    : { action: "idle", message: MUSE_STOP_IDLE_MESSAGE };
}

export function museComposerApplySelection(item: MuseComposerPickerItem): MuseComposerSelection {
  switch (item.kind) {
    case "skill":
      return { action: "replace", text: museComposerSkillPrompt(item.skill) };
    case "connector":
      return { action: "replace", text: museComposerConnectionPrompt(item.connector) };
    case "slash":
      return item.transport === "stop"
        ? { action: "stop" }
        : {
            action: "unimplemented",
            command: item.command.name,
            message: museComposerUnimplementedSlashMessage(item.command.name),
          };
  }
}

export function museComposerDiscoveryReads(providerInstanceId: ProviderInstanceId): {
  readonly skills: {
    readonly operation: "skills";
    readonly providerInstanceId: ProviderInstanceId;
  };
  readonly connectors: {
    readonly operation: "connectors";
    readonly providerInstanceId: ProviderInstanceId;
  };
} {
  return {
    skills: { operation: "skills", providerInstanceId },
    connectors: { operation: "connectors", providerInstanceId },
  };
}

const MUSE_TYPED_SLASH_ALIASES: Readonly<Record<string, string>> = { history: "latest" };

export function museComposerGuardTypedSlash(prompt: string): MuseTypedSlashGuard {
  const match = /^\/([\w-]+)(?:\s|$)/u.exec(prompt.trim());
  if (match === null) return { action: "allow" };
  const typed = match[1]!.toLowerCase();
  const command = MUSE_TYPED_SLASH_ALIASES[typed] ?? typed;
  if (command === "model") {
    return {
      action: "block",
      command: "model",
      message: "Muse's model cannot be changed from this composer.",
    };
  }
  const native = MUSE_NATIVE_SLASH_COMMANDS.find((item) => item.name === command);
  if (native === undefined) return { action: "allow" };
  if (museComposerSlashTransport(native) === "stop") return { action: "stop" };
  return {
    action: "block",
    command: native.name,
    message: museComposerUnimplementedSlashMessage(native.name),
  };
}

/**
 * Native registry rows often omit enabled/disabled. The Muse client keeps a
 * skill when `disabled !== true && user_disabled !== true`. Explicit ineligible
 * or allowlist-blocked skills stay out; missing flags stay in.
 */
export function isMuseComposerSkillInvocable(
  skill: Pick<
    MuseAgentSkill,
    "disabled" | "userDisabled" | "eligible" | "blockedByAllowlist" | "enabled"
  >,
): boolean {
  if (skill.disabled === true || skill.userDisabled === true) return false;
  if (skill.eligible === false || skill.blockedByAllowlist === true) return false;
  return true;
}

export function museComposerSkills(skills: readonly MuseAgentSkill[]): readonly MuseAgentSkill[] {
  return skills.filter(isMuseComposerSkillInvocable);
}

/** Native skill id in `path`, never a workspace file path. */
export function museSkillToProviderSkill(skill: MuseAgentSkill): ServerProviderSkill {
  const displayName = skill.title?.trim();
  return {
    name: skill.name,
    path: skill.name,
    enabled: true,
    scope: "other",
    ...(displayName ? { displayName } : {}),
    ...(skill.description
      ? { description: skill.description, shortDescription: skill.description }
      : {}),
  };
}

/**
 * Coming-soon catalog entries are not usable. Unknown is not disconnected.
 */
export function isMuseComposerConnectionUsable(
  connector: Pick<MuseAgentConnector, "state">,
): boolean {
  return connector.state !== "coming_soon";
}

export function museComposerConnections(
  connectors: readonly MuseAgentConnector[],
): readonly MuseAgentConnector[] {
  return connectors.filter(isMuseComposerConnectionUsable);
}

export function museComposerConnectionPrompt(connector: Pick<MuseAgentConnector, "name">): string {
  return `Use the ${connector.name} connection. `;
}

export function museComposerConnectionDescription(
  connector: Pick<MuseAgentConnector, "state" | "description">,
): string {
  switch (connector.state) {
    case "connected":
      return connector.description.trim() || "Use this Muse connection";
    case "unknown":
      return "Status unavailable";
    case "disconnected":
      return connector.description.trim() || "Not connected";
    case "coming_soon":
      return "Coming soon";
  }
}

function scoreLabel(value: string, query: string): number | null {
  return scoreQueryMatch({
    value: value.toLowerCase(),
    query,
    exactBase: 0,
    prefixBase: 2,
    boundaryBase: 4,
    includesBase: 6,
    fuzzyBase: 100,
    boundaryMarkers: ["-", "_", "/", ":"],
  });
}

function searchByLabels<T>(
  items: readonly T[],
  query: string,
  labels: (item: T) => readonly string[],
): T[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^[@\p{Sc}]+/u });
  if (!normalizedQuery) return [...items];
  const ranked: Array<{ item: T; score: number; tieBreaker: string }> = [];
  for (const item of items) {
    const scores = labels(item)
      .map((label) => scoreLabel(label, normalizedQuery))
      .filter((score): score is number => score !== null);
    if (scores.length === 0) continue;
    insertRankedSearchResult(
      ranked,
      {
        item,
        score: Math.min(...scores),
        tieBreaker: labels(item)[0] ?? "",
      },
      Number.POSITIVE_INFINITY,
    );
  }
  return ranked.map((entry) => entry.item);
}

export function searchMuseComposerSkills(
  skills: readonly MuseAgentSkill[],
  query: string,
): MuseAgentSkill[] {
  return searchByLabels(museComposerSkills(skills), query, (skill) => [
    skill.title ?? "",
    skill.name,
    skill.description,
    skill.category,
  ]);
}

export function searchMuseComposerConnectors(
  connectors: readonly MuseAgentConnector[],
  query: string,
): MuseAgentConnector[] {
  return searchByLabels(museComposerConnections(connectors), query, (connector) => [
    connector.name,
    connector.id,
    connector.description,
  ]);
}

function searchMuseComposerSlashCommands(query: string): MuseNativeSlashCommand[] {
  return searchByLabels(museComposerRunnableSlashCommands(), query, (command) => [
    command.name,
    ...(command.aliases ?? []),
    command.description,
  ]);
}

/** `$` lists native skills and connections as prompt replacements. */
export function museComposerDollarPickerItems(
  skills: readonly MuseAgentSkill[],
  connectors: readonly MuseAgentConnector[],
  query: string,
): MuseComposerPickerItem[] {
  return [
    ...searchMuseComposerSkills(skills, query).map((skill) => ({ kind: "skill" as const, skill })),
    ...searchMuseComposerConnectors(connectors, query).map((connector) => ({
      kind: "connector" as const,
      connector,
    })),
  ];
}

/**
 * `/` offers only runnable slash transport (`/stop`) plus the same
 * skill/connection prompt replacements as `$`. Unsupported native commands
 * stay out of the menu; typed send still guards them.
 */
export function museComposerSlashPickerItems(
  skills: readonly MuseAgentSkill[],
  connectors: readonly MuseAgentConnector[],
  query: string,
): MuseComposerPickerItem[] {
  return [
    ...searchMuseComposerSlashCommands(query).map((command) => ({
      kind: "slash" as const,
      command,
      transport: museComposerSlashTransport(command),
    })),
    ...museComposerDollarPickerItems(skills, connectors, query),
  ];
}
