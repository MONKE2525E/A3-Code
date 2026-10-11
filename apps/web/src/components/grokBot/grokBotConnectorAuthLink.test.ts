import { describe, expect, it } from "vite-plus/test";

import { isNativeConnectorAuthLink } from "./grokBotConnectorAuthLink";

const relay = "https://www.cursor.com/agents/mcp/oauth/callback";
const nativeLink = (state: string) =>
  `https://auth.example.test/authorize?client_id=c1&response_type=code&redirect_uri=${encodeURIComponent(relay)}&state=${state}`;

describe("isNativeConnectorAuthLink", () => {
  it("recognizes the relay link native writes, default and alternate listener ports", () => {
    expect(isNativeConnectorAuthLink(nativeLink("flow.tgd"))).toBe(true);
    expect(isNativeConnectorAuthLink(nativeLink("flow.tgd18787"))).toBe(true);
  });

  it("refuses links that would not be a native sign-in", () => {
    // A local redirect is the broken flow this replaces; the state is native's, so only redirect differs.
    expect(
      isNativeConnectorAuthLink(
        "https://auth.example.test/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8787%2Fcallback&state=flow.tgd",
      ),
    ).toBe(false);
    expect(isNativeConnectorAuthLink(nativeLink("flow"))).toBe(false);
    expect(isNativeConnectorAuthLink(nativeLink("flow.tgdx"))).toBe(false);
    expect(
      isNativeConnectorAuthLink(
        `http://auth.example.test/authorize?redirect_uri=${encodeURIComponent(relay)}&state=flow.tgd`,
      ),
    ).toBe(false);
    expect(isNativeConnectorAuthLink("https://www.cursor.com/docs")).toBe(false);
    expect(isNativeConnectorAuthLink("not a url")).toBe(false);
  });
});
