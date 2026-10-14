// @vitest-environment jsdom

import { act } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  primary: "env-primary" as string | null,
  connected: ["env-primary"] as string[],
  complete: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("~/state/environments", () => ({
  useConnectedEnvironmentIds: () => mocks.connected,
  usePrimaryEnvironmentId: () => mocks.primary,
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("~/state/grokBots", () => ({
  grokBotsPluginAuthenticate: { label: "authenticate", permissionAtom: () => null },
  grokBotsPluginCompleteAuth: { label: "complete" },
  grokBotsPluginConnectionsQuery: () => null,
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.complete }));

import { GrokBotPluginAuthCallback } from "./GrokBotPluginAuthCallback";
import { PLUGIN_AUTH_STORAGE_PREFIX } from "./GrokBotPluginAccounts";

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

function landOn(query: string) {
  window.history.replaceState({}, "", `/settings/marketplace?${query}`);
}

async function render() {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<GrokBotPluginAuthCallback />);
  });
  return renderer!;
}

const status = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByProps({ role: "status" }).map(textOf).join("");

describe("GrokBotPluginAuthCallback", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.primary = "env-primary";
    mocks.connected = ["env-primary"];
    mocks.complete.mockReset();
    mocks.complete.mockResolvedValue({ _tag: "Success", value: { accountKey: "work" } });
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("completes a sign-in that another browser started on the environment this page belongs to", async () => {
    // Nothing is stored under this origin: Electron or a phone started the flow elsewhere.
    landOn("grokBotOAuth=1&state=flow.tgd&code=one-time");
    renderer = await render();

    expect(mocks.complete).toHaveBeenCalledWith({
      environmentId: "env-primary",
      input: { stateId: "flow.tgd", code: "one-time" },
    });
    expect(status(renderer)).toContain("Connector connected");
  });

  it("prefers the environment this origin stored for the flow, even when the relay added a port", async () => {
    mocks.connected = ["env-primary", "env-remote"];
    localStorage.setItem(
      `${PLUGIN_AUTH_STORAGE_PREFIX}flow-stored.tgd`,
      JSON.stringify({ environmentId: "env-remote", pluginId: "linear" }),
    );
    landOn("grokBotOAuth=1&state=flow-stored.tgd8787&code=one-time");
    renderer = await render();

    expect(mocks.complete).toHaveBeenCalledWith({
      environmentId: "env-remote",
      input: { stateId: "flow-stored.tgd", code: "one-time" },
    });
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow-stored.tgd`)).toBeNull();
  });

  it("holds the code until the environment is connected instead of calling it expired", async () => {
    mocks.connected = [];
    landOn("grokBotOAuth=1&state=flow-held.tgd&code=one-time");
    renderer = await render();

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(status(renderer)).toContain("Finishing connector authentication");

    mocks.connected = ["env-primary"];
    await act(async () => {
      renderer!.update(<GrokBotPluginAuthCallback />);
    });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("reports a return with no code as expired without contacting any environment", async () => {
    landOn("grokBotOAuth=1&state=flow.tgd");
    renderer = await render();

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(status(renderer)).toContain("expired");
  });
});
