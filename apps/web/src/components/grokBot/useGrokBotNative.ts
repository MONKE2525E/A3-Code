import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isGrokBotBackingThread,
  type EnvironmentId,
  type GrokBot,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { grokBotsOpenThread, grokBotsOrchestratorConfigQuery } from "~/state/grokBots";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { environmentThreadShells, environmentThreads, threadEnvironment } from "~/state/threads";
import { serverEnvironment } from "~/state/server";
import { createThreadPrefetchAtom } from "~/state/threadPrefetch";
import {
  cachedGrokBotNativeInstanceId,
  findCachedGrokBotNativeThread,
  isGrokBotReadinessTransportFailure,
} from "./grokBotCachedThread";

import {
  findGrokBotNativeThread,
  grokBotNativeReadiness,
  type GrokBotNativeReadiness,
} from "./grokBotNativeThread";

/**
 * The native provider state for one environment. The status read is not write-guarded
 * on the server, so every signed-in client can read it. Only explicit setup changes it.
 */
export function useGrokBotNativeReadiness(environmentId: EnvironmentId): GrokBotNativeReadiness {
  const config = useEnvironmentQuery(grokBotsOrchestratorConfigQuery({ environmentId, input: {} }));
  return (() => {
    if (config.error && !isGrokBotReadinessTransportFailure(config.failure)) {
      return { kind: "denied", message: config.error };
    }
    return grokBotNativeReadiness(config.data);
  })();
}

/** Resolve the canonical shell without waiting for a roster refresh or an open RPC. */
export function useCachedGrokBotNativeThread(
  environmentId: EnvironmentId,
  botId: string,
  readiness: GrokBotNativeReadiness,
): ThreadId | null {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const instanceId = cachedGrokBotNativeInstanceId(config, readiness);
  return instanceId === null
    ? null
    : (findCachedGrokBotNativeThread(threads, { instanceId, botId })?.id ?? null);
}

/** Prefetch existing pinned conversations only. The normal detail cache owns all messages and cursors. */
export function usePrefetchPinnedGrokBotThreads(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId | null,
): void {
  const prefetch = createThreadPrefetchAtom({
    threadIdsAtom: Atom.make((get) =>
      instanceId === null
        ? []
        : get(environmentThreadShells.environmentThreadsAtom(environmentId))
            .filter(
              (thread) =>
                isGrokBotBackingThread(thread) &&
                thread.providerInstanceId === instanceId &&
                thread.archivedAt === null &&
                thread.pinnedAt != null,
            )
            .map((thread) => thread.id),
    ),
    stateAtom: (threadId) => environmentThreads.stateAtom(environmentId, threadId),
    limit: 4,
  });
  useAtomMount(prefetch);
}

function reportNativeFailure(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not open the Grok Bot thread",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Opens the one native thread that belongs to a bot. The server finds or creates that
 * thread for the current provider instance, so a replaced account never reuses an old
 * account's thread. Opening never changes pin state: the server keeps a manual unpin,
 * and explicit pin toggles go through `syncBotPin`.
 */
export function useGrokBotNativeActions(environmentId: EnvironmentId) {
  const openThreadCommand = useAtomCommand(grokBotsOpenThread, { reportFailure: false });
  const pinThread = useOrchestrationCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinThread = useOrchestrationCommand(threadEnvironment.unpin, { reportFailure: false });

  const threadsNow = () =>
    appAtomRegistry.get(environmentThreadShells.environmentThreadsAtom(environmentId));

  const setPinned = async (threadId: ThreadId, pinned: boolean) => {
    const result = await (pinned ? pinThread : unpinThread)({
      environmentId,
      input: { threadId },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  };

  /**
   * Resolves the bot's native thread. The server always places it in no project, so the
   * caller picks nothing. Rejects with the failure so the caller can show it where the user is looking.
   */
  const openBot = async (botId: string): Promise<ThreadId> => {
    const result = await openThreadCommand({
      environmentId,
      input: { botId },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const threadId = result._tag === "Success" ? result.value.threadId : null;
    if (threadId === null) throw new Error("Grok Bot did not return a thread.");
    return threadId;
  };

  /** Mirrors a bot pin change onto its existing thread. A bot without a thread has nothing to pin yet. */
  const syncBotPin = async (bot: GrokBot, instanceId: ProviderInstanceId) => {
    const existing = findGrokBotNativeThread(threadsNow(), { instanceId, botId: bot.id });
    if (existing === null) return;
    try {
      await setPinned(existing.id, bot.pinned);
    } catch (error) {
      reportNativeFailure(error);
    }
  };

  return { openBot, syncBotPin };
}

/**
 * The bot whose native thread is open in the current route, so a bot stays highlighted
 * while its ordinary thread is on screen. Null when another thread or environment is open.
 */
export function useOpenGrokBotNativeBotId(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId | null,
): string | null {
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => params.environmentId ?? null,
  });
  const routeThreadId = useParams({ strict: false, select: (params) => params.threadId ?? null });
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  return (() => {
    if (instanceId === null || routeThreadId === null || routeEnvironmentId !== environmentId) {
      return null;
    }
    const thread = threads.find((entry) => entry.id === routeThreadId);
    if (
      thread === undefined ||
      !isGrokBotBackingThread(thread) ||
      thread.providerInstanceId !== instanceId
    ) {
      return null;
    }
    return thread.modelSelection.model;
  })();
}
