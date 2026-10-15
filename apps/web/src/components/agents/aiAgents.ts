import {
  type AgentStatusDot,
  type AgentUnreadThreadShell,
  hasUnseenAssistantMessage,
  resolveAgentStatusDot,
} from "./agentStatusDot";

/** Shared vocabulary for the AI Agents sidebar section, which lists Grok Bots and native Muse. */
export const AI_AGENTS_SECTION_LABEL = "AI Agents";

/** Native Muse chats are ordinary threads on this provider driver; Muse Code keeps `muse`. */
export const MUSE_AGENT_DRIVER = "muse-agent";

/** Mirrors the server's native Muse status: runtime found, session found, both usable. */
export type MuseAgentStatusInput = {
  readonly installed: boolean;
  readonly sessionPresent: boolean;
  readonly ready: boolean;
  readonly message?: string | null | undefined;
};

export type MuseAgentNotice =
  | { readonly kind: "ready"; readonly message: string; readonly actionLabel?: undefined }
  | { readonly kind: "checking"; readonly message: string; readonly actionLabel?: undefined }
  | {
      readonly kind: "install" | "sign-in" | "error";
      readonly message: string;
      readonly actionLabel: string;
    };

/**
 * Maps detected status to the one thing the user should do next. Detection is automatic, so the
 * notice never asks for configuration beyond installing Muse or signing in to it.
 */
export function resolveMuseAgentNotice(input: {
  readonly status: MuseAgentStatusInput | null | undefined;
  readonly error?: string | null | undefined;
}): MuseAgentNotice {
  const error = input.error?.trim();
  if (error) return { kind: "error", message: error, actionLabel: "Retry" };
  const status = input.status;
  if (!status) return { kind: "checking", message: "Checking Muse…" };
  if (status.ready) return { kind: "ready", message: "Muse is connected." };
  const detail = status.message?.trim();
  if (!status.installed) {
    return {
      kind: "install",
      message: detail || "Install Muse on this machine to chat with it here.",
      actionLabel: "Refresh",
    };
  }
  if (!status.sessionPresent) {
    return {
      kind: "sign-in",
      message: detail || "Open Muse and sign in, then refresh.",
      actionLabel: "Refresh",
    };
  }
  return {
    kind: "error",
    message: detail || "Muse is installed and signed in but not ready yet.",
    actionLabel: "Refresh",
  };
}

/**
 * Muse art may be a video. It plays only for an active agent that is on screen in a visible
 * document with motion allowed; every other case shows the still frame.
 */
export function resolveMuseAvatarPlayback(input: {
  readonly hasVideo: boolean;
  readonly active: boolean;
  readonly reducedMotion: boolean;
  readonly onScreen: boolean;
  readonly documentVisible: boolean;
}): "playing" | "parked" {
  return input.hasVideo &&
    input.active &&
    !input.reducedMotion &&
    input.onScreen &&
    input.documentVisible
    ? "playing"
    : "parked";
}

/** Timestamps are `DateTime.Utc` on real thread shells and ISO strings in fixtures. */
type MuseThreadCandidate = {
  readonly id: string;
  readonly providerInstanceId: string;
  readonly archivedAt: unknown;
  readonly updatedAt?: unknown;
};

function timestampMillis(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === "object" && value !== null && "epochMilliseconds" in value) {
    return Number(value.epochMilliseconds) || 0;
  }
  return 0;
}

/**
 * The persistent Muse thread for one provider instance, or null. Archived threads are skipped
 * because only the server open path can restore them; a replaced account never reuses another's.
 */
export function findCachedMuseAgentThread<T extends MuseThreadCandidate>(
  threads: ReadonlyArray<T>,
  instanceId: string,
): T | null {
  let best: T | null = null;
  for (const thread of threads) {
    if (
      !thread.id.startsWith("muse-agent:") ||
      thread.providerInstanceId !== instanceId ||
      (thread.archivedAt ?? null) !== null
    ) {
      continue;
    }
    if (best === null || timestampMillis(thread.updatedAt) > timestampMillis(best.updatedAt)) {
      best = thread;
    }
  }
  return best;
}

export type MuseAgentSidebarState =
  | { readonly kind: "hidden" }
  | { readonly kind: "setup"; readonly notice: Exclude<MuseAgentNotice, { kind: "ready" }> }
  | {
      /** Signed in but no provider yet, or a provider that is not ready: setup must run. */
      readonly kind: "enable";
      readonly mode: "connect" | "reconnect";
      readonly detail: string | null;
    }
  | { readonly kind: "row"; readonly instanceId: string };

/**
 * What the AI Agents section shows for native Muse. A machine without Muse shows nothing, so the
 * section is not nagged by an agent the user never installed. `ready` stays false until setup has
 * verified the account, so a signed-in Muse with no provider offers setup instead of a refresh.
 */
export function resolveMuseAgentSidebarState(input: {
  readonly status:
    | (MuseAgentStatusInput & { readonly provider: { readonly instanceId: string } | null })
    | null
    | undefined;
  readonly error?: string | null | undefined;
}): MuseAgentSidebarState {
  if (input.error) {
    return {
      kind: "setup",
      notice: { kind: "error", message: input.error, actionLabel: "Retry" },
    };
  }
  const status = input.status;
  if (!status || !status.installed) return { kind: "hidden" };
  if (status.ready && status.provider) {
    return { kind: "row", instanceId: status.provider.instanceId };
  }
  if (status.sessionPresent) {
    const detail = status.message?.trim() || null;
    return { kind: "enable", mode: status.provider ? "reconnect" : "connect", detail };
  }
  const notice = resolveMuseAgentNotice({ status });
  if (notice.kind === "ready") {
    return {
      kind: "setup",
      notice: { kind: "error", message: "Muse is not ready.", actionLabel: "Refresh" },
    };
  }
  return { kind: "setup", notice };
}

/** What Muse is doing, as far as its avatar is concerned. Each state plays its own clip. */
export type MuseAvatarState = "idle" | "connecting" | "working" | "waiting";

/** Muse's run status to avatar state. Only a status that is actually running leaves idle. */
export function museAvatarStateForStatus(status: string | null | undefined): MuseAvatarState {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
      return "connecting";
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    default:
      return "idle";
  }
}

/** Variant names to try for each state, in order. Muse's keys may use hyphens or underscores. */
const AVATAR_VARIANT_CHAIN: Readonly<Record<MuseAvatarState, ReadonlyArray<string>>> = {
  idle: ["idle", "default"],
  connecting: ["connecting", "working", "talk"],
  working: ["working", "talk"],
  waiting: ["waiting_for_subagents", "working", "talk"],
};

/**
 * One clip from the profile's video variants for an avatar state. A state with no clip of its own
 * falls back to the idle clip, then to any clip Muse sent.
 */
export function pickMuseAvatarVideo(
  variants: Readonly<Record<string, string>> | null | undefined,
  state: MuseAvatarState = "idle",
): string | null {
  if (!variants) return null;
  const byName = new Map(
    Object.entries(variants).map(([key, url]) => [key.toLowerCase().replace(/-/g, "_"), url]),
  );
  for (const name of AVATAR_VARIANT_CHAIN[state]) {
    const url = byName.get(name);
    if (url) return url;
  }
  return byName.get("idle") ?? byName.get("default") ?? Object.values(variants)[0] ?? null;
}

/**
 * Muse's sidebar dot, under the same rule as Grok Bots: green while its run is active, blue for a
 * reply the user has not opened. Without a thread there is nothing to be unread.
 */
export function resolveMuseAgentStatusDot(input: {
  readonly active: boolean;
  readonly thread: AgentUnreadThreadShell | null;
  readonly localVisitedAt: string | undefined;
}): AgentStatusDot | null {
  const unread =
    input.thread !== null && hasUnseenAssistantMessage(input.thread, input.localVisitedAt);
  return resolveAgentStatusDot({ active: input.active, unread });
}

/**
 * Whether a Muse thread is the conversation for a native session. A null session is Main chat, the
 * account's own thread; a side chat's thread id ends with its percent-encoded session id.
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
