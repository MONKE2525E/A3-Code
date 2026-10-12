import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  capturePluginAuthReturn,
  clearPluginAuthReturn,
  finishPluginAuthReturn,
  parseManualCallback,
  pluginAuthStateId,
  readPluginAuthReturn,
} from "./grokBotPluginAuthReturn";

afterEach(() => vi.unstubAllGlobals());
function browser(href: string) {
  const values = new Map<string, string>();
  const replaceState = vi.fn();
  vi.stubGlobal("window", { location: { href }, history: { state: null, replaceState } });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return { values, replaceState };
}
describe("plugin OAuth pairing return", () => {
  it("preserves the return through pairing and clears it after delivery", () => {
    const { replaceState } = browser(
      "https://app.example/settings/marketplace?grokBotOAuth=1&state=flow&code=one-time",
    );
    capturePluginAuthReturn();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/settings/marketplace");
    expect(readPluginAuthReturn()?.get("code")).toBe("one-time");
    finishPluginAuthReturn("connected");
    expect(readPluginAuthReturn()?.has("code")).toBe(false);
    expect(readPluginAuthReturn()?.get("t3AuthResult")).toBe("connected");
    clearPluginAuthReturn();
    expect(readPluginAuthReturn()).toBeNull();
  });
  it("does not capture unrelated navigation or retain expired codes", () => {
    const { values, replaceState } = browser(
      "https://app.example/settings/providers?code=unrelated",
    );
    capturePluginAuthReturn();
    expect(replaceState).not.toHaveBeenCalled();
    expect(readPluginAuthReturn()).toBeNull();
    values.set(
      "t3:grok-plugin-auth-return",
      JSON.stringify({ query: "?code=expired", savedAt: Date.now() - 16 * 60_000 }),
    );
    expect(readPluginAuthReturn()).toBeNull();
  });
});

describe("pasted sign-in address", () => {
  const relayed = "https://localhost:1/callback?state=flow.tgd18787&code=one-time";
  it("matches the issued state across the relay port suffix", () => {
    expect(pluginAuthStateId("flow.tgd18787")).toBe("flow.tgd");
    expect(pluginAuthStateId("flow.tgd")).toBe("flow.tgd");
    expect(parseManualCallback(relayed, "flow.tgd")).toEqual({ _tag: "code", code: "one-time" });
  });
  it("reads the code from a failed-to-load callback address", () => {
    expect(
      parseManualCallback("  http://localhost:8787/callback?state=flow&code=abc  ", "flow"),
    ).toEqual({ _tag: "code", code: "abc" });
  });
  it("rejects an address from another sign-in, unreadable text, and a missing code", () => {
    expect(parseManualCallback("http://localhost/callback?state=other&code=x", "flow")).toEqual({
      _tag: "invalid",
      reason: "otherSignIn",
    });
    expect(parseManualCallback("one-time", "flow")).toEqual({
      _tag: "invalid",
      reason: "unreadable",
    });
    expect(parseManualCallback("", "flow")).toEqual({ _tag: "invalid", reason: "unreadable" });
    expect(parseManualCallback("http://localhost/callback?state=flow", "flow")).toEqual({
      _tag: "invalid",
      reason: "noCode",
    });
  });
  it("reports a provider denial without a code", () => {
    expect(
      parseManualCallback("http://localhost/callback?state=flow&error=access_denied", "flow"),
    ).toEqual({ _tag: "denied" });
  });
});
