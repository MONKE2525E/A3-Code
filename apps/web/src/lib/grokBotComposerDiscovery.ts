import type {
  GrokBotComposerBot,
  GrokBotComposerConnector,
  GrokBotComposerResources,
  GrokBotComposerSkill,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  formatGrokBotComposerAtToken,
  grokBotConnectorLabel,
  grokBotSkillChipName,
  serializeGrokBotComposerRichText,
  type GrokBotComposerRichTextResult,
} from "@t3tools/shared/grokBotComposerRichText";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

export function grokBotSkillToProviderSkill(skill: GrokBotComposerSkill): ServerProviderSkill {
  return {
    name: grokBotSkillChipName(skill),
    path: skill.id,
    enabled: true,
    displayName: skill.name,
    scope: skill.origin === "user" ? "personal" : "other",
    ...(skill.description
      ? { description: skill.description, shortDescription: skill.description }
      : {}),
  };
}

function scoreLabel(value: string, query: string, bases: readonly number[]): number | null {
  return scoreQueryMatch({
    value: value.toLowerCase(),
    query,
    exactBase: bases[0] ?? 0,
    prefixBase: bases[1] ?? 2,
    boundaryBase: bases[2] ?? 4,
    includesBase: bases[3] ?? 6,
    fuzzyBase: bases[4] ?? 100,
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
      .map((label) => scoreLabel(label, normalizedQuery, [0, 2, 4, 6, 100]))
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

export function searchGrokBotComposerSkills(
  skills: readonly GrokBotComposerSkill[],
  query: string,
): GrokBotComposerSkill[] {
  return searchByLabels(skills, query, (skill) => [
    skill.name,
    grokBotSkillChipName(skill),
    skill.id,
    skill.description ?? "",
  ]);
}

export function searchGrokBotComposerBots(
  bots: readonly GrokBotComposerBot[],
  query: string,
): GrokBotComposerBot[] {
  return searchByLabels(bots, query, (bot) => [bot.name, bot.id]);
}

export function searchGrokBotComposerConnectors(
  connectors: readonly GrokBotComposerConnector[],
  query: string,
): GrokBotComposerConnector[] {
  return searchByLabels(connectors, query, (connector) => [
    grokBotConnectorLabel(connector),
    connector.name,
    connector.pluginId,
    connector.description ?? "",
  ]);
}

export function mentionableGrokBotComposerBots(
  resources: GrokBotComposerResources | null,
  currentBotId: string,
  usableBotIds?: ReadonlySet<string>,
): readonly GrokBotComposerBot[] {
  if (!resources) return [];
  return resources.bots.filter((bot) => {
    if (bot.id === currentBotId) return false;
    if (usableBotIds !== undefined && !usableBotIds.has(bot.id)) return false;
    return true;
  });
}

/**
 * Catalog logos keyed by plugin id. A connector's `pluginId` is the catalog plugin's id, so the
 * composer reads its icon from the marketplace catalog instead of a field the composer contract lacks.
 */
export function grokBotConnectorLogoUrls(
  plugins: readonly { readonly id: string; readonly logoUrl: string | null }[],
): ReadonlyMap<string, string> {
  return new Map(
    plugins.flatMap((plugin) => (plugin.logoUrl ? [[plugin.id, plugin.logoUrl] as const] : [])),
  );
}

export function grokBotComposerAtReplacement(label: string): string {
  return `${formatGrokBotComposerAtToken(label)} `;
}

/** Native 0.68.1 rich_text JSON for a grok-bot composer prompt. Runtime send does not take this yet. */
export function serializeGrokBotComposerPrompt(
  prompt: string,
  resources: GrokBotComposerResources | null,
): GrokBotComposerRichTextResult {
  return serializeGrokBotComposerRichText(prompt, {
    skills: resources?.skills ?? [],
    bots: resources?.bots ?? [],
    connectors: resources?.connectors ?? [],
  });
}

export { grokBotConnectorLabel };
