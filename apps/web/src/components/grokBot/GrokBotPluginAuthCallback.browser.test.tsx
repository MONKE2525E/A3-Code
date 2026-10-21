import { render, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  primary: "env-primary" as string | null,
  connected: ["env-primary"] as string[],
  complete: vi.fn(),
}));

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("/src/state/environments.ts", () => ({
  useConnectedEnvironmentIds: () => mocks.connected,
  usePrimaryEnvironmentId: () => mocks.primary,
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("/src/state/grokBots.ts", () => ({
  grokBotsPluginAuthenticate: { label: "authenticate", permissionAtom: () => null },
  grokBotsPluginCompleteAuth: { label: "complete" },
  grokBotsOrchestratorConfigQuery: () => null,
  grokBotsPluginConnectionsQuery: () => null,
}));
vi.mock("/src/state/query.ts", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("/src/state/use-atom-command.ts", () => ({ useAtomCommand: () => mocks.complete }));

import { GrokBotPluginAuthCallback } from "./GrokBotPluginAuthCallback";
import { PLUGIN_AUTH_STORAGE_PREFIX } from "./GrokBotPluginAccounts";

function landOn(query: string) {
  window.history.replaceState({}, "", `/settings/marketplace?${query}`);
}

const status = (screen: Screen) => screen.container.textContent ?? "";

function setup() {
  mocks.primary = "env-primary";
  mocks.connected = ["env-primary"];
  mocks.complete.mockReset();
  mocks.complete.mockResolvedValue({ _tag: "Success", value: { accountKey: "work" } });
  localStorage.clear();
  sessionStorage.clear();
}

describe("GrokBotPluginAuthCallback", () => {
  it("completes a sign-in that another browser started on the environment this page belongs to", async () => {
    setup();
    // Nothing is stored under this origin: Electron or a phone started the flow elsewhere.
    landOn("grokBotOAuth=1&state=flow.tgd&code=one-time");
    await using screen = await render(<GrokBotPluginAuthCallback />);

    expect(mocks.complete).toHaveBeenCalledWith({
      environmentId: "env-primary",
      input: { stateId: "flow.tgd", code: "one-time" },
    });
    expect(status(screen)).toContain("Connector connected");
  });

  it("prefers the environment this origin stored for the flow, even when the relay added a port", async () => {
    setup();
    mocks.connected = ["env-primary", "env-remote"];
    localStorage.setItem(
      `${PLUGIN_AUTH_STORAGE_PREFIX}flow-stored.tgd`,
      JSON.stringify({ environmentId: "env-remote", pluginId: "linear" }),
    );
    landOn("grokBotOAuth=1&state=flow-stored.tgd8787&code=one-time");
    await using _screen = await render(<GrokBotPluginAuthCallback />);

    expect(mocks.complete).toHaveBeenCalledWith({
      environmentId: "env-remote",
      input: { stateId: "flow-stored.tgd", code: "one-time" },
    });
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow-stored.tgd`)).toBeNull();
  });

  it("holds the code until the environment is connected instead of calling it expired", async () => {
    setup();
    mocks.connected = [];
    landOn("grokBotOAuth=1&state=flow-held.tgd&code=one-time");
    await using screen = await render(<GrokBotPluginAuthCallback />);

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(status(screen)).toContain("Finishing connector authentication");

    mocks.connected = ["env-primary"];
    await screen.rerender(<GrokBotPluginAuthCallback />);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("reports a return with no code as expired without contacting any environment", async () => {
    setup();
    landOn("grokBotOAuth=1&state=flow.tgd");
    await using screen = await render(<GrokBotPluginAuthCallback />);

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(status(screen)).toContain("expired");
  });
});
