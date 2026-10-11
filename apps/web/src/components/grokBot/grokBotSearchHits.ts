import type { EnvironmentId, GrokBot } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";

import type { GrokBotSearchHit } from "../CommandPalette.logic";
import { grokBotIdForSenderThread } from "./grokBotSenderThread";

/**
 * Bot conversations stay out of the thread list, so a global content match on one resolves to
 * its bot here. Each bot appears once, named from the roster when the match is in the roster's
 * environment. Other environments fall back to a generic name.
 */
export function grokBotSearchHitsFromMatches(input: {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly shells: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "modelSelection">
  >;
  readonly rosterEnvironmentId: EnvironmentId | null;
  readonly roster: ReadonlyArray<Pick<GrokBot, "id" | "name" | "avatarShape" | "avatarColor">>;
}): GrokBotSearchHit[] {
  const seen = new Set<string>();
  const hits: GrokBotSearchHit[] = [];
  for (const match of input.matches) {
    if (match.source !== "user" && match.source !== "assistant") continue;
    const botId = grokBotIdForSenderThread(input.shells, {
      environmentId: match.environmentId,
      threadId: match.threadId,
    });
    if (botId === null) continue;
    const key = `${match.environmentId}:${botId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bot =
      match.environmentId === input.rosterEnvironmentId
        ? input.roster.find((candidate) => candidate.id === botId)
        : undefined;
    hits.push({
      environmentId: match.environmentId,
      bot: bot ?? { id: botId, name: "Grok Bot", avatarShape: "", avatarColor: "" },
      source: match.source,
      snippet: match.snippet,
    });
  }
  return hits;
}
