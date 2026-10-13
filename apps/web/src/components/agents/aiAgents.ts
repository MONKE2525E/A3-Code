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

/** One clip from the profile's video variants: a calm idle loop, or a working clip while `working`. */
export function pickMuseAvatarVideo(
  variants: Readonly<Record<string, string>> | null | undefined,
  working = false,
): string | null {
  if (!variants) return null;
  const active = working ? (variants.working ?? variants.talk) : undefined;
  return active ?? variants.idle ?? variants.default ?? Object.values(variants)[0] ?? null;
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

/** Route search for opening a source-aware agent chat; Grok keeps its `/grok-bots/$botId` route. */
export function museAgentOpenSearch(environmentId: string | null | undefined): {
  readonly environmentId?: string;
} {
  return environmentId ? { environmentId } : {};
}
