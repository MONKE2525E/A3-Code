import {
  nativeAgentSourceForDriver,
  nativeAgentSourceForThread,
  type EnvironmentId,
  type MuseAgentOpenThreadInput,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "@t3tools/client-runtime/rpc";

/**
 * Whether a Muse thread is the conversation for a native session. A null session is Main chat;
 * a side chat's thread id ends with its percent-encoded session id.
 */
export function isMuseSessionThread(threadId: string, sessionId: string | null): boolean {
  if (sessionId === null) return /^muse-agent:[0-9a-f]{64}$/.test(threadId);
  const match = /^muse-agent:[0-9a-f]{64}:(.+)$/.exec(threadId);
  return match?.[1] === encodeURIComponent(sessionId);
}

/** The native side-chat session encoded in a canonical T3 thread id. */
export function museSessionForThread(threadId: string | undefined): string | undefined {
  const session = /^muse-agent:[0-9a-f]{64}:([^:]+)$/.exec(threadId ?? "")?.[1];
  if (session === undefined) return undefined;
  try {
    return decodeURIComponent(session);
  } catch {
    return undefined;
  }
}

export type MuseAgentNativeOpenProvider = {
  readonly instanceId: string;
  readonly driver: string;
};

type MuseAgentNativeOpenPlan =
  | { readonly kind: "wait" }
  | {
      readonly kind: "skip";
      readonly reason: "not-muse" | "malformed" | "capability-absent";
    }
  | {
      readonly kind: "open";
      readonly providerInstanceId: ProviderInstanceId;
      readonly sessionId?: string;
    };

/**
 * Native `museAgents.open` is fork-only. Official nightly does not advertise a muse-agent
 * provider, so Muse threads skip the RPC and keep the generic route. Ordinary threads never
 * reach the method.
 */
export function resolveMuseAgentNativeOpenPlan(input: {
  readonly threadId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providers: ReadonlyArray<MuseAgentNativeOpenProvider> | null;
}): MuseAgentNativeOpenPlan {
  if (nativeAgentSourceForThread({ id: input.threadId }) !== "muse-agent") {
    return { kind: "skip", reason: "not-muse" };
  }
  const sessionId = museSessionForThread(input.threadId);
  if (!isMuseSessionThread(input.threadId, sessionId ?? null)) {
    return { kind: "skip", reason: "malformed" };
  }
  if (input.providers === null) return { kind: "wait" };
  const advertised = input.providers.some(
    (provider) =>
      provider.instanceId === input.providerInstanceId &&
      nativeAgentSourceForDriver(provider.driver) === "muse-agent",
  );
  if (!advertised) return { kind: "skip", reason: "capability-absent" };
  return {
    kind: "open",
    providerInstanceId: input.providerInstanceId,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

/** Reattach the selected account's live Muse conversation onto its cached shell. */
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

const MUSE_NATIVE_OPEN_RETRY_MESSAGE = "Could not reconnect this Muse conversation.";

/**
 * Absence is preflight-only (`capability-absent`). After an open attempt, transport,
 * unavailable, and unknown-method RPC stay retryable without leaking the raw cause.
 */
export function describeMuseNativeOpenFailure(cause: unknown): string {
  if (cause instanceof EnvironmentRpcUnavailableError || isRpcClientError(cause)) {
    return MUSE_NATIVE_OPEN_RETRY_MESSAGE;
  }
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return MUSE_NATIVE_OPEN_RETRY_MESSAGE;
}
