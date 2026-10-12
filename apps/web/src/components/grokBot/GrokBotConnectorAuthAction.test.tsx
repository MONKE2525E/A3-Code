import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

import {
  createGrokBotConnectorAuthLinkOverride,
  GrokBotConnectorAuthAction,
} from "./GrokBotConnectorAuthAction";

describe("GrokBotConnectorAuthAction", () => {
  it("opens the marketplace for the conversation's own environment, not the raw sign-in link", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("env-1");
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<GrokBotConnectorAuthAction environmentId={environmentId} />);
    });
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/marketplace",
      search: { machine: environmentId },
    });
    await act(async () => {
      renderer?.unmount();
    });
    vi.unstubAllGlobals();
  });

  it("claims only native sign-in links in a Grok Bot transcript and routes them to the conversation's environment", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("env-2");
    const override = createGrokBotConnectorAuthLinkOverride(environmentId);
    const nativeHref =
      "https://auth.example.test/authorize?redirect_uri=https%3A%2F%2Fwww.cursor.com%2Fagents%2Fmcp%2Foauth%2Fcallback&state=synthetic.tgd";
    expect(override({ href: "https://example.test/docs", label: "docs" })).toBeUndefined();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<>{override({ href: nativeHref, label: "Linear" })}</>);
    });
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
    });
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/settings/marketplace",
      search: { machine: environmentId },
    });
    await act(async () => {
      renderer?.unmount();
    });
    vi.unstubAllGlobals();
  });
});
