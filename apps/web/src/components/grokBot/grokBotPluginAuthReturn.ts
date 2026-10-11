const CALLBACK_KEY = "t3:grok-plugin-auth-return";
const MAX_AGE = 15 * 60_000;

/** Keep a short-lived OAuth return through T3 pairing without putting its code in the pairing URL. */
export function capturePluginAuthReturn() {
  const url = new URL(window.location.href);
  if (url.pathname !== "/settings/marketplace" || url.searchParams.get("grokBotOAuth") !== "1")
    return;
  try {
    sessionStorage.setItem(
      CALLBACK_KEY,
      JSON.stringify({ query: url.search, savedAt: Date.now() }),
    );
    window.history.replaceState(window.history.state, "", url.pathname);
  } catch {
    /* The current URL remains available when browser storage is disabled. */
  }
}

export function readPluginAuthReturn() {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(CALLBACK_KEY) ?? "null");
    if (
      typeof value !== "object" ||
      value === null ||
      !("query" in value) ||
      typeof value.query !== "string" ||
      !("savedAt" in value) ||
      typeof value.savedAt !== "number" ||
      Date.now() - value.savedAt > MAX_AGE
    ) {
      sessionStorage.removeItem(CALLBACK_KEY);
      return null;
    }
    return new URLSearchParams(value.query);
  } catch {
    return null;
  }
}

export function clearPluginAuthReturn() {
  try {
    sessionStorage.removeItem(CALLBACK_KEY);
  } catch {
    /* Storage may be disabled. */
  }
}

/** The server appends a loopback port to the relayed state; the issued state id does not carry it. */
export function pluginAuthStateId(state: string) {
  return state.replace(/(\.tgd)\d{1,5}$/, "$1");
}

export type ManualCallbackResult =
  | { readonly _tag: "code"; readonly code: string }
  | { readonly _tag: "denied" }
  | { readonly _tag: "invalid"; readonly reason: "unreadable" | "otherSignIn" | "noCode" };

/**
 * Read the address a user copied from the sign-in tab. It may be the page that failed to load, so
 * only its query is used. The code is returned to the caller and never stored here.
 */
export function parseManualCallback(value: string, expectedStateId: string): ManualCallbackResult {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { _tag: "invalid", reason: "unreadable" };
  }
  const state = url.searchParams.get("state");
  if (!state || pluginAuthStateId(state) !== pluginAuthStateId(expectedStateId))
    return { _tag: "invalid", reason: "otherSignIn" };
  if (url.searchParams.has("error")) return { _tag: "denied" };
  const code = url.searchParams.get("code")?.trim();
  if (!code) return { _tag: "invalid", reason: "noCode" };
  return { _tag: "code", code };
}

export function finishPluginAuthReturn(result: "connected" | "failed") {
  const params = readPluginAuthReturn();
  if (!params) return;
  params.delete("code");
  params.set("t3AuthResult", result);
  try {
    sessionStorage.setItem(
      CALLBACK_KEY,
      JSON.stringify({ query: params.toString(), savedAt: Date.now() }),
    );
  } catch {
    /* Storage may be disabled. */
  }
}
