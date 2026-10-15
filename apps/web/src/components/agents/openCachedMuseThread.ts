import type {
  EnvironmentId,
  MuseAgentOpenThreadInput,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { isMuseSessionThread, museSessionForThread } from "./aiAgents";

/** Reattach the selected account's live Muse conversation before navigating to its cached shell. */
export async function openCachedMuseThread(input: {
  readonly hit: { readonly environmentId: EnvironmentId; readonly threadId: string };
  readonly shells: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
  readonly openThread: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: MuseAgentOpenThreadInput;
  }) => Promise<{ readonly threadId: ThreadId } | null>;
  readonly navigate: (target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => Promise<void>;
}): Promise<void> {
  const { hit } = input;
  const shell = input.shells.find(
    (thread) => thread.environmentId === hit.environmentId && thread.id === hit.threadId,
  );
  const sessionId = museSessionForThread(hit.threadId);
  if (!shell || !isMuseSessionThread(hit.threadId, sessionId ?? null)) {
    throw new Error("This Muse conversation is unavailable. Refresh search and try again.");
  }
  const opened = await input.openThread({
    environmentId: hit.environmentId,
    input: {
      providerInstanceId: shell.providerInstanceId,
      ...(sessionId === undefined ? {} : { sessionId }),
    },
  });
  if (opened === null) return;
  if (opened.threadId !== hit.threadId) {
    throw new Error(
      "This conversation belongs to a different Muse account. Reconnect that account to open it.",
    );
  }
  await input.navigate({ environmentId: hit.environmentId, threadId: opened.threadId });
}
