import { isGrokBotBackingThread } from "@t3tools/contracts";
import { DateTime } from "effect";
import type {
  GrokBot,
  GrokBotOrchestratorConfig as GrokBotOrchestratorConfigSchema,
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
} from "@t3tools/contracts";

type GrokBotOrchestratorConfig = typeof GrokBotOrchestratorConfigSchema.Type;

/** The fields that identify a bot thread, from the raw V2 shell list. */
export type GrokBotNativeThreadCandidate = Pick<
  OrchestrationV2ThreadShell,
  "id" | "providerInstanceId" | "modelSelection" | "archivedAt" | "createdAt"
>;

export type GrokBotNativeReadiness =
  | { readonly kind: "pending" }
  | { readonly kind: "denied"; readonly message: string }
  /** Sending is possible: the provider is bound and ready. */
  | { readonly kind: "ready"; readonly instanceId: ProviderInstanceId }
  /**
   * The bound provider is known but cannot send yet (for example, the public endpoint is
   * unavailable). Its bot threads still open, highlight, and pin, because they are keyed
   * by the bound instance rather than by send readiness.
   */
  | {
      readonly kind: "blocked";
      readonly instanceId: ProviderInstanceId;
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly state: Exclude<GrokBotOrchestratorConfig["state"], "ready">;
      readonly message: string;
    };

/**
 * Maps the server's native provider state onto what the sidebar and route can do.
 * The server opens a bot thread for `ready` or `blocked` with a bound provider, so
 * `blocked` keeps browsing available. `account_changed`, `not_configured`, and
 * `native_account_unavailable` stay hard blocks. `denied` means the caller cannot read
 * the provider config without settings write access, so it never guesses a state.
 */
export function grokBotNativeReadiness(
  config: GrokBotOrchestratorConfig | null | undefined,
): GrokBotNativeReadiness {
  if (config === undefined || config === null) return { kind: "pending" };
  if (config.provider !== null && config.state === "ready") {
    return { kind: "ready", instanceId: config.provider.instanceId };
  }
  if (config.provider !== null && config.state === "blocked") {
    return {
      kind: "blocked",
      instanceId: config.provider.instanceId,
      message: grokBotNativeUnavailableMessage("blocked"),
    };
  }
  // A "ready" state without a provider row cannot route a thread, so it reads as blocked.
  const state = config.state === "ready" ? "blocked" : config.state;
  return { kind: "unavailable", state, message: grokBotNativeUnavailableMessage(state) };
}

/**
 * The bound provider instance whenever the server can open bot threads (ready or blocked).
 * Use this for browsing, highlighting, and pin sync; use `kind === "ready"` only to send.
 */
export function grokBotNativeInstanceId(
  readiness: GrokBotNativeReadiness,
): ProviderInstanceId | null {
  return readiness.kind === "ready" || readiness.kind === "blocked" ? readiness.instanceId : null;
}

function grokBotNativeUnavailableMessage(
  state: Exclude<GrokBotOrchestratorConfig["state"], "ready">,
): string {
  switch (state) {
    case "not_configured":
      return "Set up the Grok Bot provider in Settings to chat with bots in threads.";
    case "blocked":
      return "The Grok Bot provider is not ready. Check its status and the public endpoint in Settings.";
    case "account_changed":
      return "The Grok Bot provider belongs to a different account or team. Restore that selection or remove the old provider in Settings.";
    case "native_account_unavailable":
      return "Sign in to the native Grok Bot app, then set up the provider in Settings.";
  }
}

/**
 * Only the server's canonical bot thread counts. An ordinary provider thread that happens to
 * use the bot's instance and model is a user's own chat, so it must not be opened, pinned, or
 * shown as bot activity. The current instance also keeps an old account from matching.
 */
export function findGrokBotNativeThread<T extends GrokBotNativeThreadCandidate>(
  threads: ReadonlyArray<T>,
  input: { readonly instanceId: ProviderInstanceId; readonly botId: GrokBot["id"] },
): T | null {
  let found: T | null = null;
  for (const thread of threads) {
    if (!isGrokBotBackingThread(thread)) continue;
    if (thread.providerInstanceId !== input.instanceId) continue;
    if (thread.modelSelection.model !== input.botId) continue;
    // An active thread wins over an archived one; among equals the newest wins.
    if (found !== null) {
      const foundActive = found.archivedAt === null;
      const threadActive = thread.archivedAt === null;
      if (foundActive !== threadActive) {
        if (!threadActive) continue;
      } else if (
        DateTime.toEpochMillis(thread.createdAt) <= DateTime.toEpochMillis(found.createdAt)
      ) {
        continue;
      }
    }
    found = thread;
  }
  return found;
}
