import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useUiStateStore } from "~/uiStateStore";
import { environmentThreadDetails, environmentThreadShells } from "~/state/threads";

import type { GrokBotThreadActivity } from "./grokBotThreadActivity";
import { selectGrokBotToolActivities } from "./grokBotThreadActivity";
import { selectGrokBotUnreadBotIds } from "./grokBotStatusDots";

const NO_TOOL_ACTIVITIES: ReadonlyMap<string, GrokBotThreadActivity> = new Map();
const NO_UNREAD_BOT_IDS: ReadonlySet<string> = new Set();

const EMPTY_TOOL_ACTIVITIES_ATOM = Atom.make(NO_TOOL_ACTIVITIES).pipe(
  Atom.withLabel("web-grok-bot-tool-activity:empty"),
);

function sameToolActivities(
  left: ReadonlyMap<string, GrokBotThreadActivity>,
  right: ReadonlyMap<string, GrokBotThreadActivity>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [botId, activity] of right) {
    if (left.get(botId) !== activity) return false;
  }
  return true;
}

const toolActivityAtomFamily = Atom.family((key: string) => {
  const { environmentId, instanceId } = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly instanceId: ProviderInstanceId;
  };
  let previous = NO_TOOL_ACTIVITIES;
  return Atom.make((get) => {
    const next = selectGrokBotToolActivities({
      threads: get(environmentThreadShells.environmentThreadsAtom(environmentId)),
      instanceId,
      readTurnItems: (thread) => {
        // Only called for a matched bot thread with an active run; see selectGrokBotToolActivities.
        const state = get(
          environmentThreadDetails.stateAtom(scopeThreadRef(environmentId, thread.id)),
        );
        if (state.status !== "live") return null;
        return Option.getOrNull(state.data)?.turnItems ?? null;
      },
    });
    if (sameToolActivities(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-grok-bot-tool-activity:${key}`));
});

/**
 * Native activity keyed by bot id, including work between tool calls. Resting bots
 * are absent, so callers fall back to their stored activity. One subscription
 * serves the whole roster; the map keeps its identity until an entry changes.
 */
export function useGrokBotToolActivities(
  environmentId: EnvironmentId | null,
  instanceId: ProviderInstanceId | null,
): ReadonlyMap<string, GrokBotThreadActivity> {
  return useAtomValue(
    environmentId !== null && instanceId !== null
      ? toolActivityAtomFamily(JSON.stringify({ environmentId, instanceId }))
      : EMPTY_TOOL_ACTIVITIES_ATOM,
  );
}

/**
 * Bot ids whose native thread has a run completed after the user last viewed it. Reads the
 * same shells and browser watermarks as the sidebar rows, so it never writes read state.
 */
export function useGrokBotUnreadBotIds(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId | null,
): ReadonlySet<string> {
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById);
  return useMemo(
    () =>
      instanceId === null
        ? NO_UNREAD_BOT_IDS
        : selectGrokBotUnreadBotIds({ environmentId, threads, instanceId, localLastVisitedAt }),
    [environmentId, instanceId, localLastVisitedAt, threads],
  );
}
