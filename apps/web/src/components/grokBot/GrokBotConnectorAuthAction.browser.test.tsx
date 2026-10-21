import { EnvironmentId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

import {
  createGrokBotConnectorAuthLinkOverride,
  GrokBotConnectorAuthAction,
} from "./GrokBotConnectorAuthAction";

describe("GrokBotConnectorAuthAction", () => {
  it("opens the marketplace for the conversation's own environment, not the raw sign-in link", async () => {
    navigate.mockReset();
    const environmentId = EnvironmentId.make("env-1");
    await using screen = await render(<GrokBotConnectorAuthAction environmentId={environmentId} />);
    await screen.getByRole("button", { name: "Connect in Settings" }).click();
    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/marketplace",
      search: { machine: environmentId },
    });
  });

  it("claims only native sign-in links in a Grok Bot transcript and routes them to the conversation's environment", async () => {
    navigate.mockReset();
    const environmentId = EnvironmentId.make("env-2");
    const override = createGrokBotConnectorAuthLinkOverride(environmentId);
    const nativeHref =
      "https://auth.example.test/authorize?redirect_uri=https%3A%2F%2Fwww.cursor.com%2Fagents%2Fmcp%2Foauth%2Fcallback&state=synthetic.tgd";
    expect(override({ href: "https://example.test/docs", label: "docs" })).toBeUndefined();
    await using screen = await render(<>{override({ href: nativeHref, label: "Linear" })}</>);
    await screen.getByRole("button", { name: "Connect in Settings" }).click();
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/settings/marketplace",
      search: { machine: environmentId },
    });
  });
});
