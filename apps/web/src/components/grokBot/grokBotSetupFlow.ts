import type { GrokBotSetupStatus } from "@t3tools/contracts";

type Phase = GrokBotSetupStatus["phase"];

/** Phases where the server is still working or waiting on the user, so the UI keeps refreshing. */
const ACTIVE_PHASES: ReadonlySet<Phase> = new Set([
  "sending",
  "awaiting_authorization",
  "verifying",
]);

/** Waiting on the user is slow, so poll gently; sending and verifying finish quickly. */
export function grokBotSetupPollMs(phase: Phase): number {
  return phase === "awaiting_authorization" ? 10_000 : 5_000;
}

/** Only an explicit Retry may resend once a run has failed or stalled; no repeats while one is active. */
export function grokBotSetupSendDisabled(status: GrokBotSetupStatus | undefined): boolean {
  return (
    status !== undefined &&
    (ACTIVE_PHASES.has(status.phase) ||
      status.phase === "needs_primary" ||
      (status.phase === "needs_prerequisite" && status.primaryBot === null) ||
      status.retryable === true)
  );
}

/** The terminal fallback only matters while setup is unfinished. */
export function grokBotSetupShowsTerminal(status: GrokBotSetupStatus): boolean {
  return !status.complete && status.phase !== "complete" && Boolean(status.terminalCommand);
}

/** Windows PowerShell needs the call operator when the command starts with a quoted path. */
export function grokBotTerminalHint(command: string): string {
  const base = "Run on the computer hosting this T3 environment.";
  return /^\s*(?:&|\$env:)/.test(command)
    ? `${base} Use Windows PowerShell for this command.`
    : base;
}

export interface GrokBotSetupView {
  readonly title: string;
  readonly description: string;
  readonly active: boolean;
  /** Complete hides the send button; only the server-verified flag counts. */
  readonly showSend: boolean;
  readonly sendLabel: string;
  readonly tone: "neutral" | "success" | "error";
}

/** Copy and affordances derived only from the server's setupStatus, never from provider readiness. */
export function grokBotSetupView(status: GrokBotSetupStatus): GrokBotSetupView {
  const bot = status.primaryBot?.name ?? "your primary bot";
  const base = {
    active: ACTIVE_PHASES.has(status.phase) || status.retryable === true,
    showSend: !status.complete,
  };
  switch (status.phase) {
    case "complete":
      return {
        ...base,
        title: "MCP connection verified",
        description: `${bot} received the setup message and called back through this environment’s authorized T3 connector.`,
        sendLabel: "Send setup prompt",
        tone: "success",
      };
    case "needs_primary":
      return {
        ...base,
        title: "Star a primary bot",
        description:
          "Choose a primary bot in GrokBot. T3 sends setup to the bot marked with the star and installs the setup sender automatically.",
        sendLabel: "Send setup prompt",
        tone: "neutral",
      };
    case "needs_prerequisite":
      return {
        ...base,
        title: "Finish provider setup first",
        description: `${status.primaryBot ? `Primary bot: ${bot}. ` : ""}${status.error ?? "A prerequisite is missing. Send the setup prompt to retry it."}`,
        sendLabel: "Send setup prompt",
        tone: "neutral",
      };
    case "sending":
      return {
        ...base,
        title: "Sending setup prompt",
        description: `Posting to ${bot}.`,
        sendLabel: "Sending…",
        tone: "neutral",
      };
    case "awaiting_authorization":
      return {
        ...base,
        title: "Waiting for authorization",
        description: `${bot} needs you to authorize T3. Use the link or command below.`,
        sendLabel: "Send setup prompt again",
        tone: "neutral",
      };
    case "verifying":
      return {
        ...base,
        title: "Verifying",
        description: "Checking that T3 received the MCP authorization.",
        sendLabel: "Send setup prompt again",
        tone: "neutral",
      };
    case "stalled":
      return {
        ...base,
        title: "Setup stalled",
        description: status.error ?? "No authorization arrived. Retry or check again.",
        sendLabel: "Retry setup",
        tone: "error",
      };
    case "failed":
      return {
        ...base,
        title: status.retryable ? "Setup temporarily unavailable" : "Setup failed",
        description: status.retryable
          ? "Could not read setup status. T3 will check again automatically; the setup message will not be resent."
          : (status.error ?? "Setup could not finish."),
        sendLabel: "Retry setup",
        tone: "error",
      };
    case "needs_setup":
      return {
        ...base,
        title: "Send the setup prompt",
        description: "T3 prepares the provider and sends one prompt to your primary bot.",
        sendLabel: "Send setup prompt",
        tone: "neutral",
      };
  }
}

const GROK_BOT_OAUTH_PATH = "/settings/marketplace?grokBotOAuth=1";

/**
 * OAuth accepts HTTPS or loopback HTTP. A remote HTTP connection returns through the owning
 * environment's published endpoint; the page origin is only a fallback without an environment.
 */
export function resolveGrokBotOAuthRedirect(
  pageOrigin: string,
  environmentHttpBaseUrl: string | null,
  environmentPublishedUrl: string | null = null,
): string | null {
  const web = (value: string | null) => {
    if (value === null) return null;
    try {
      const url = new URL(value);
      return !url.username &&
        !url.password &&
        (url.protocol === "http:" || url.protocol === "https:")
        ? url
        : null;
    } catch {
      return null;
    }
  };
  const callbackOrigin = (url: URL | null) =>
    url !== null &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      ? url.origin
      : null;
  const environment = web(environmentHttpBaseUrl);
  const published = web(environmentPublishedUrl);
  const origin =
    callbackOrigin(environment) ??
    (published?.protocol === "https:" ? published.origin : null) ??
    (environment === null ? callbackOrigin(web(pageOrigin)) : null);
  return origin === null ? null : new URL(GROK_BOT_OAUTH_PATH, origin).href;
}
