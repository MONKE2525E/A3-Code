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
const MUSE_NATIVE_CONNECTING_SEND_REASON = "Connecting Muse history…";
const MUSE_NATIVE_PERMISSION_SEND_REASON =
  "Live Muse history needs permission to operate on this environment.";
const MUSE_NATIVE_RETRY_SEND_REASON = "Retry Muse connection to send";

export type MuseNativeAttachSendGate = {
  readonly sendAllowed: boolean;
  readonly sendBlockedReason: string | null;
};

/**
 * Send is allowed only after a verified native attach, or when preflight skipped
 * the RPC (ordinary threads and non-advertised Muse). First paint before the
 * open effect is blocked because `attached` starts false.
 */
export function museNativeAttachSendGate(input: {
  readonly planKind: "wait" | "skip" | "open";
  readonly connected: boolean;
  readonly canOpen: boolean;
  readonly attached: boolean;
  readonly error: string | null;
}): MuseNativeAttachSendGate {
  if (input.planKind === "skip") {
    return { sendAllowed: true, sendBlockedReason: null };
  }
  if (input.planKind === "wait" || !input.connected) {
    return { sendAllowed: false, sendBlockedReason: MUSE_NATIVE_CONNECTING_SEND_REASON };
  }
  if (!input.canOpen) {
    return { sendAllowed: false, sendBlockedReason: MUSE_NATIVE_PERMISSION_SEND_REASON };
  }
  if (input.attached) {
    return { sendAllowed: true, sendBlockedReason: null };
  }
  if (input.error !== null) {
    return { sendAllowed: false, sendBlockedReason: MUSE_NATIVE_RETRY_SEND_REASON };
  }
  return { sendAllowed: false, sendBlockedReason: MUSE_NATIVE_CONNECTING_SEND_REASON };
}

/** Shared submit boundary so composer keybindings cannot bypass the attach gate. */
export async function guardMuseNativeSend<T>(
  sendBlockedReason: string | null | undefined,
  send: () => Promise<T>,
): Promise<T | null> {
  if (sendBlockedReason != null) return null;
  return send();
}

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

export type QueuedMuseOutboxIdentity =
  | { readonly kind: "ordinary" }
  | { readonly kind: "unverified" }
  | { readonly kind: "wait" }
  | {
      readonly kind: "muse";
      readonly providerInstanceId: ProviderInstanceId;
      readonly sessionId?: string;
    };

/**
 * Expected Muse identity is the canonical queued thread id plus the historical
 * provider. New outbox rows already persist `modelSelection.instanceId`; old
 * rows may infer that provider only from the exact live thread when it is
 * advertised as muse-agent. Anything else stays unverified so drain cannot
 * pretend the session is attached.
 */
export function resolveQueuedMuseOutboxIdentity(input: {
  readonly threadId: string;
  readonly queuedProviderInstanceId?: ProviderInstanceId;
  readonly liveThread: {
    readonly id: string;
    readonly providerInstanceId: ProviderInstanceId;
  } | null;
  readonly providers: ReadonlyArray<MuseAgentNativeOpenProvider> | null;
}): QueuedMuseOutboxIdentity {
  if (nativeAgentSourceForThread({ id: input.threadId }) !== "muse-agent") {
    return { kind: "ordinary" };
  }
  const sessionId = museSessionForThread(input.threadId);
  if (!isMuseSessionThread(input.threadId, sessionId ?? null)) {
    return { kind: "unverified" };
  }
  const queuedProviderInstanceId = input.queuedProviderInstanceId;
  if (queuedProviderInstanceId !== undefined && queuedProviderInstanceId.length > 0) {
    return {
      kind: "muse",
      providerInstanceId: queuedProviderInstanceId,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }
  if (input.providers === null) {
    return { kind: "wait" };
  }
  if (
    input.liveThread !== null &&
    input.liveThread.id === input.threadId &&
    input.providers.some(
      (provider) =>
        provider.instanceId === input.liveThread?.providerInstanceId &&
        nativeAgentSourceForDriver(provider.driver) === "muse-agent",
    )
  ) {
    return {
      kind: "muse",
      providerInstanceId: input.liveThread.providerInstanceId,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }
  return { kind: "unverified" };
}

export type MuseOutboxAttachAction =
  | { readonly action: "proceed" }
  | { readonly action: "park" }
  | {
      readonly action: "open";
      readonly providerInstanceId: ProviderInstanceId;
      readonly sessionId?: string;
      readonly expectedThreadId: string;
    };

/**
 * Outbox `startTurn` may run with no mounted route. Ordinary threads proceed
 * without Muse RPC. Muse rows open only when identity, live connection, and
 * operate permission are present and the historical instance is advertised.
 * Capability-absent Muse never claims attached.
 */
export function resolveMuseOutboxAttachAction(input: {
  readonly threadId: string;
  readonly queuedProviderInstanceId?: ProviderInstanceId;
  readonly liveThread: {
    readonly id: string;
    readonly providerInstanceId: ProviderInstanceId;
  } | null;
  readonly providers: ReadonlyArray<MuseAgentNativeOpenProvider> | null;
  readonly connected: boolean;
  readonly canOpen: boolean;
}): MuseOutboxAttachAction {
  const identity = resolveQueuedMuseOutboxIdentity(input);
  if (identity.kind === "ordinary") {
    return { action: "proceed" };
  }
  if (identity.kind === "unverified" || identity.kind === "wait") {
    return { action: "park" };
  }
  if (!input.connected || !input.canOpen) {
    return { action: "park" };
  }
  const plan = resolveMuseAgentNativeOpenPlan({
    threadId: input.threadId,
    providerInstanceId: identity.providerInstanceId,
    providers: input.providers,
  });
  if (plan.kind !== "open") {
    return { action: "park" };
  }
  return {
    action: "open",
    providerInstanceId: plan.providerInstanceId,
    ...(plan.sessionId === undefined ? {} : { sessionId: plan.sessionId }),
    expectedThreadId: input.threadId,
  };
}
