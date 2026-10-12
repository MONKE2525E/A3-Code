import { isGrokBotBackingThread, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

/**
 * A canonical bot thread is keyed by the bot it talks to, so its model is the bot id.
 * Titles are never read: an ordinary coding thread can have any title.
 */
export function grokBotIdForThreadShell(
  shell: Pick<EnvironmentThreadShell, "id" | "modelSelection">,
): string | null {
  return isGrokBotBackingThread(shell) ? shell.modelSelection.model : null;
}

/** Resolves a generic agent sender to its bot when the sender is a canonical bot thread in the same environment. */
export function grokBotIdForSenderThread(
  shells: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id" | "modelSelection">>,
  sender: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): string | null {
  const shell = shells.find(
    (candidate) =>
      candidate.environmentId === sender.environmentId && candidate.id === sender.threadId,
  );
  return shell === undefined ? null : grokBotIdForThreadShell(shell);
}
