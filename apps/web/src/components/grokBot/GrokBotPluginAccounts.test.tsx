// @vitest-environment jsdom

import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  status: "needsAuth" as "connected" | "needsAuth",
  httpBaseUrl: "http://100.64.0.2:3773" as string | null,
  refresh: vi.fn(),
  authenticate: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("~/state/grokBots", () => ({
  grokBotsPluginAuthenticate: { label: "authenticate", permissionAtom: () => null },
  grokBotsPluginCompleteAuth: { label: "complete" },
  grokBotsPluginConnectionsQuery: () => null,
}));
vi.mock("~/state/environments", () => ({ useEnvironmentHttpBaseUrl: () => mocks.httpBaseUrl }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      servers: [
        {
          id: 7,
          name: "Linear",
          supportsOAuth: true,
          accounts: [
            {
              accountKey: "work",
              authenticated: mocks.status === "connected",
              status: mocks.status,
            },
          ],
        },
      ],
    },
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "authenticate" ? mocks.authenticate : mocks.complete,
}));

import { GrokBotPluginAccounts, PLUGIN_AUTH_STORAGE_PREFIX } from "./GrokBotPluginAccounts";

const environmentId = "env-1" as EnvironmentId;
const authorizationUrl = "https://auth.example.test/authorize?state=flow.tgd";

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

function buttonNamed(renderer: ReactTestRenderer, name: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((candidate) => textOf(candidate).includes(name));
  if (!button) throw new Error(`No button named ${name}`);
  return button;
}

function bodyText(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("p").map(textOf).join("\n");
}

async function render() {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />);
  });
  return renderer!;
}

async function clickAuthenticate(renderer: ReactTestRenderer) {
  await act(async () => {
    buttonNamed(renderer, "Authenticate").props.onClick();
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("GrokBotPluginAccounts sign-in", () => {
  let popup: { closed: boolean; location: { href: string }; opener: unknown; close: () => void };
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.status = "needsAuth";
    mocks.httpBaseUrl = "http://100.64.0.2:3773";
    mocks.refresh.mockReset();
    mocks.authenticate.mockReset();
    mocks.complete.mockReset();
    popup = { closed: false, location: { href: "" }, opener: undefined, close: vi.fn() };
    window.open = vi.fn(() => popup as unknown as Window);
    localStorage.clear();
  });

  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the provider page in the popup and ends when the server reports the account connected", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: 8787 },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    expect(popup.location.href).toBe(authorizationUrl);
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).not.toBeNull();
    expect(bodyText(renderer)).toContain("Finish signing in in the new tab");

    await advance(2_000);
    expect(mocks.refresh).toHaveBeenCalled();

    mocks.status = "connected";
    await act(async () => {
      renderer!.update(<GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />);
    });
    expect(bodyText(renderer)).toContain("Connector connected.");
    expect(bodyText(renderer)).not.toContain("Finish signing in");
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).toBeNull();
  });

  it("returns sign-in to the environment's web address, not the page that started it", async () => {
    // Electron's page origin is not a web address the provider can redirect to.
    vi.stubGlobal("location", new URL("t3code://app/settings/marketplace"));
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    expect(mocks.authenticate).toHaveBeenCalledWith({
      environmentId,
      input: {
        serverId: 7,
        accountKey: "work",
        redirectUri: "http://100.64.0.2:3773/settings/marketplace?grokBotOAuth=1",
      },
    });
  });

  it("does not open a sign-in tab when the environment has no web address", async () => {
    vi.stubGlobal("location", new URL("t3code://app/settings/marketplace"));
    mocks.httpBaseUrl = null;
    renderer = await render();
    await clickAuthenticate(renderer);

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("p").map(textOf).join("\n")).toContain("no web address");
  });

  it("ends with a retry message when the sign-in tab closes before the account connects", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: 8787 },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    popup.closed = true;
    await advance(9_000);
    expect(bodyText(renderer)).toContain("Finish signing in in the new tab");
    await advance(2_000);
    expect(bodyText(renderer)).toContain("The sign-in tab closed before sign-in finished.");
    expect(bodyText(renderer)).not.toContain("Finish signing in");
  });

  it("gives up after fifteen minutes without a completion", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: 8787 },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    await advance(15 * 60_000);
    expect(bodyText(renderer)).toContain("Sign-in did not finish in time.");
  });

  it("finishes a flow without a loopback listener from a pasted address, then clears the field", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow", loopbackPort: null },
    });
    mocks.complete.mockResolvedValue({ _tag: "Success", value: { accountKey: "work" } });
    renderer = await render();
    await clickAuthenticate(renderer);

    const value = "http://localhost:8787/callback?state=flow&code=abc";
    await act(async () => {
      renderer!.root
        .findAllByType("input")[0]!
        .props.onChange({ target: { value }, currentTarget: { value } });
    });
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });

    expect(mocks.complete).toHaveBeenCalledWith({
      environmentId,
      input: { stateId: "flow", code: "abc" },
    });
    // A completed flow ends, so its paste field is gone along with the code it held.
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(bodyText(renderer)).toContain("Connector connected.");
  });

  it("explains an unreadable address without completing, and still clears the field", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    await act(async () => {
      const value = "one-time";
      renderer!.root
        .findAllByType("input")[0]!
        .props.onChange({ target: { value }, currentTarget: { value } });
    });
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(bodyText(renderer)).toContain("That is not a full address.");
    expect(renderer.root.findAllByType("input")[0]!.props.value).toBe("");
  });
});
