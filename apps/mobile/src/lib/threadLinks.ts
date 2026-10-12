import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export type ThreadLink = { readonly environmentId: string; readonly threadId: string };
export type ParsedThreadLink =
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" }
  | { readonly kind: "thread"; readonly target: ThreadLink };

/** Split before decoding so an encoded slash remains part of its ID. */
export function parseThreadLink(input: string): ParsedThreadLink {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: "ignored" };
  }
  const isTailnet = url.protocol === "https:" && url.hostname.endsWith(".ts.net");
  const isThreadScheme =
    ["t3code:", "t3code-custom:", "t3code-dev:", "t3code-preview:"].includes(url.protocol) &&
    url.hostname === "thread";
  if (!isTailnet && !isThreadScheme) return { kind: "ignored" };
  if (url.username || url.password || (isThreadScheme && url.port)) return { kind: "invalid" };
  // Read the original path, since URL normalizes dot segments before exposing pathname.
  const path = input.match(/^[^:]+:\/\/[^/?#]+([^?#]*)/)?.[1] ?? "";
  const segments = path.replace(/\/$/, "").split("/");
  if (segments.length !== 3 || segments[0] !== "") return { kind: "invalid" };
  try {
    const ids = segments.slice(1).map(decodeURIComponent);
    if (
      ids.some(
        (id) =>
          !id.trim() ||
          id !== id.trim() ||
          id === "." ||
          id === ".." ||
          Array.from(id).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
      )
    ) {
      return { kind: "invalid" };
    }
    return { kind: "thread", target: { environmentId: ids[0]!, threadId: ids[1]! } };
  } catch {
    return { kind: "invalid" };
  }
}

export function resolveThreadLink(input: {
  readonly isReady: boolean;
  readonly environment:
    | { readonly isEnabled: boolean; readonly connectionState: EnvironmentConnectionPhase }
    | undefined;
  readonly shellStatus: "empty" | "cached" | "synchronizing" | "live";
  readonly shellHasError: boolean;
  readonly threadExists: boolean;
}): "waiting" | "open" | string {
  if (!input.isReady) return "waiting";
  if (!input.environment)
    return "This environment is not saved on this device. Pair it in Connections, then open the link again.";
  if (!input.environment.isEnabled)
    return "This environment is switched off. Enable it in Connections, then open the link again.";
  const phase = input.environment.connectionState;
  if (phase === "available" || phase === "connecting" || phase === "reconnecting") return "waiting";
  if (phase !== "connected")
    return "This environment is not connected. Check its connection in Connections, then open the link again.";
  if (input.shellHasError)
    return "The environment's thread list could not be loaded. Try reconnecting in Connections.";
  if (input.shellStatus !== "live") return "waiting";
  return input.threadExists
    ? "open"
    : "This thread was not found in the linked environment. It may have been deleted.";
}
