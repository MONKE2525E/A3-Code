import type {
  EnvironmentId,
  GrokBotSecretRequest,
  GrokBotSecretSubmitInput,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

import { grokBotIdForThreadShell } from "./grokBotSenderThread";

export type GrokBotSecretRequestItem = typeof GrokBotSecretRequest.Type;
export type GrokBotSecretSubmitPayload = typeof GrokBotSecretSubmitInput.Type;

/**
 * The native bot's main session. Transcript reads and managed runs use the same empty id, so a
 * secret the bot asks in its ordinary chat is listed under it.
 */
export const GROK_BOT_MAIN_SESSION_ID = "";

/**
 * Only a pending request can be answered; a responded one is already settled on the native side.
 * A repeated entry in one snapshot is listed once, so it never stacks a second form.
 */
export function grokBotPendingSecretRequests(
  requests: ReadonlyArray<GrokBotSecretRequestItem>,
): ReadonlyArray<GrokBotSecretRequestItem> {
  const seen = new Set<string>();
  return requests.filter((request) => {
    if (request.state !== "pending") return false;
    const key = `${request.sessionId}:${request.entryId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Requests this client has saved or dismissed, keyed by environment, bot and entry. A snapshot can
 * still list a settled request as pending for a moment, or after a remount, so the card stays
 * closed until native reports it responded. Only ids live here, never a value.
 */
const settledSecretRequestKeys = new Set<string>();

export function grokBotSecretRequestKey(
  target: { readonly environmentId: EnvironmentId; readonly botId: string },
  request: Pick<GrokBotSecretRequestItem, "sessionId" | "entryId">,
): string {
  return `${target.environmentId}:${target.botId}:${request.sessionId}:${request.entryId}`;
}

export function markGrokBotSecretRequestSettled(key: string): void {
  settledSecretRequestKeys.add(key);
}

export function isGrokBotSecretRequestSettled(key: string): boolean {
  return settledSecretRequestKeys.has(key);
}

/** Native's own answer is authoritative, so a settled key can be forgotten once native reports it. */
export function forgetRespondedGrokBotSecretRequests(
  target: { readonly environmentId: EnvironmentId; readonly botId: string },
  requests: ReadonlyArray<GrokBotSecretRequestItem>,
): void {
  const responded: string[] = [];
  for (const request of requests) {
    if (request.state !== "responded") continue;
    const key = grokBotSecretRequestKey(target, request);
    settledSecretRequestKeys.delete(key);
    responded.push(key);
  }
  if (responded.length > 0) useHiddenGrokBotSecretRequests.getState().forget(responded);
}

/**
 * Requests the user hid on this device because native would not take a dismissal. Hiding is local
 * only: the bot is not told and nothing is deleted. Keys persist so a reload keeps the card away,
 * and the list is capped so it never grows without bound. Only ids live here, never a value.
 */
export const GROK_BOT_HIDDEN_SECRET_REQUESTS_MAX = 200;

/**
 * Reading `window.localStorage` can throw when the browser blocks storage. Writes can also fail, so
 * the store only persists when a probe write succeeds; otherwise the hidden list lasts until reload.
 */
function localStorageForHiddenSecretRequests(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function isStorageWritable(storage: Storage | undefined): boolean {
  if (storage === undefined) return false;
  const probe = "t3code:grok-bot-hidden-secret-requests:probe";
  try {
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

const hiddenSecretRequestsStorage = localStorageForHiddenSecretRequests();
/** False when hidden requests only last until the page reloads. */
export const grokBotHiddenSecretRequestsPersist = isStorageWritable(hiddenSecretRequestsStorage);

interface HiddenGrokBotSecretRequestsState {
  /** Oldest first. */
  readonly keys: ReadonlyArray<string>;
  readonly hide: (key: string) => void;
  readonly forget: (keys: ReadonlyArray<string>) => void;
}

export const useHiddenGrokBotSecretRequests = create<HiddenGrokBotSecretRequestsState>()(
  persist(
    (set) => ({
      keys: [],
      hide: (key) =>
        set((state) => ({
          keys: [...state.keys.filter((candidate) => candidate !== key), key].slice(
            -GROK_BOT_HIDDEN_SECRET_REQUESTS_MAX,
          ),
        })),
      forget: (keys) =>
        set((state) => {
          const drop = new Set(keys);
          return { keys: state.keys.filter((candidate) => !drop.has(candidate)) };
        }),
    }),
    {
      name: "t3code:grok-bot-hidden-secret-requests:v1",
      storage: createJSONStorage(() =>
        resolveStorage(
          grokBotHiddenSecretRequestsPersist ? hiddenSecretRequestsStorage : undefined,
        ),
      ),
      partialize: ({ keys }) => ({ keys }),
      merge: (persisted, current) => {
        const keys = (persisted as Partial<Pick<HiddenGrokBotSecretRequestsState, "keys">> | null)
          ?.keys;
        return {
          ...current,
          keys: Array.isArray(keys)
            ? keys
                .filter((key): key is string => typeof key === "string")
                .slice(-GROK_BOT_HIDDEN_SECRET_REQUESTS_MAX)
            : [],
        };
      },
    },
  ),
);

export function hideGrokBotSecretRequest(key: string): void {
  useHiddenGrokBotSecretRequests.getState().hide(key);
}

/**
 * A failure that means native no longer asks for this request. Nothing was delivered by this
 * attempt, so the card closes without claiming a value was stored.
 */
export function grokBotSecretFailureEndsRequest(failure: unknown): boolean {
  return hasGrokBotSecretErrorReason(failure, ["already_answered", "request_not_found"]);
}

/**
 * Native has no dismissal for a secure input, so the server answers `unsupported` and the bot is
 * never told. The client hides the card locally in that case, as one action.
 */
export function grokBotSecretDismissIsUnsupported(failure: unknown): boolean {
  return hasGrokBotSecretErrorReason(failure, ["unsupported"]);
}

function hasGrokBotSecretErrorReason(failure: unknown, reasons: ReadonlyArray<string>): boolean {
  return (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "GrokBotSecretError" &&
    "reason" in failure &&
    typeof failure.reason === "string" &&
    reasons.includes(failure.reason)
  );
}

/**
 * The bot whose secure inputs a chat should poll and show. Only a canonical bot thread on a
 * connection that can operate it, once its messages have loaded, qualifies. Anything else returns
 * null, so nothing is polled and no panel mounts.
 */
export function grokBotSecretChatTarget(input: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "modelSelection"> | null;
  readonly canOperate: boolean;
  readonly loading: boolean;
}): { readonly environmentId: EnvironmentId; readonly botId: string } | null {
  if (input.thread === null || !input.canOperate || input.loading) return null;
  const botId = grokBotIdForThreadShell(input.thread);
  if (botId === null || botId.length === 0) return null;
  return { environmentId: input.thread.environmentId, botId };
}

/**
 * Builds the submit payload from a field value that is still in the DOM. Returns null for a blank
 * value, so the caller keeps Save disabled. The value is trimmed like the chat secret card does.
 */
export function grokBotSecretSubmitInput(
  request: Pick<GrokBotSecretRequestItem, "entryId" | "sessionId">,
  botId: string,
  value: string,
): GrokBotSecretSubmitPayload | null {
  const secret = value.trim();
  if (secret.length === 0) return null;
  return { botId, sessionId: request.sessionId, entryId: request.entryId, value: secret };
}

/**
 * Inline copy for a failed submit. The server's `GrokBotSecretError` messages are fixed copy and
 * never echo the value, so only that tag passes its message through. Anything else gets generic copy.
 */
export function grokBotSecretFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "GrokBotSecretError" &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not send the secure input. Try again.";
}

/**
 * Inline copy for a dismissal native did not take. The save copy says "delivered", which is wrong
 * for a dismissal, so this one names the action and points at the local fallback.
 */
export function grokBotSecretDismissFailureMessage(): string {
  return "Grok Bot did not confirm the dismissal. Try again, or hide it on this device.";
}
