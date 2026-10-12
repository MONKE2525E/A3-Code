/**
 * A connector sign-in link the native app writes into a transcript. Native mints it when the user
 * clicks its card, so the link is bound to a server and account that the transcript does not
 * record. T3 never adopts its state or exchanges its code; the link is only routed to Settings,
 * where the account's own Authenticate starts a flow T3 owns.
 */

// Keep in sync with RELAY_REDIRECT_URI in apps/server/src/grokBot/GrokBotOAuthLoopback.ts. The web
// bundle cannot import that module, which pulls in node:http.
const NATIVE_RELAY_REDIRECT_URI = "https://www.cursor.com/agents/mcp/oauth/callback";
// Native appends `.tgd`, and the port for any non-default listener.
const NATIVE_STATE_SUFFIX = /\.tgd\d*$/;

export function isNativeConnectorAuthLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.searchParams.get("redirect_uri") === NATIVE_RELAY_REDIRECT_URI &&
    NATIVE_STATE_SUFFIX.test(url.searchParams.get("state") ?? "")
  );
}
