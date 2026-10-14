// @vitest-environment jsdom

import type { EnvironmentId, GrokBotPluginConnectionsResult } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  status: "needsAuth" as "connected" | "needsAuth",
  httpBaseUrl: "http://100.64.0.2:3773" as string | null,
  publishedUrl: "https://relay.example.test/mcp" as string | null,
  dataUpdatedAt: 0,
  isPending: false,
  isSuccess: true,
  revision: 0,
  listeners: new Set<() => void>(),
  otherServers: [] as Array<(typeof GrokBotPluginConnectionsResult.Type.servers)[number]>,
  otherAccounts: [] as Array<
    (typeof GrokBotPluginConnectionsResult.Type.servers)[number]["accounts"][number]
  >,
  refresh: vi.fn(),
  authenticate: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("~/state/grokBots", () => ({
  grokBotsPluginAuthenticate: { label: "authenticate", permissionAtom: () => null },
  grokBotsPluginCompleteAuth: { label: "complete" },
  grokBotsPluginConnectionsQuery: () => null,
  grokBotsOrchestratorConfigQuery: () => ({ kind: "config" }),
}));
vi.mock("~/state/environments", () => ({ useEnvironmentHttpBaseUrl: () => mocks.httpBaseUrl }));
vi.mock("~/state/query", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  };
  return {
    useEnvironmentQuery: (query: { kind?: string } | null) => {
      useSyncExternalStore(subscribe, () => mocks.revision);
      return query?.kind === "config"
        ? {
            data: { setupStatus: { mcpUrl: mocks.publishedUrl } },
            error: null,
            isPending: false,
            refresh: vi.fn(),
          }
        : {
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
                    ...mocks.otherAccounts,
                  ],
                },
                ...mocks.otherServers,
              ],
            },
            dataUpdatedAt: mocks.dataUpdatedAt,
            error: mocks.isSuccess ? null : "Request failed",
            isSuccess: mocks.isSuccess,
            isPending: mocks.isPending,
            refresh: mocks.refresh,
          };
    },
  };
});
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
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function notifyQuery() {
  mocks.revision += 1;
  for (const listener of mocks.listeners) listener();
}

function settleQuery() {
  mocks.isPending = false;
  mocks.isSuccess = true;
  mocks.dataUpdatedAt = Math.max(Date.now(), mocks.dataUpdatedAt + 1);
  notifyQuery();
}

async function callbackSignal(stateId = "flow.tgd") {
  await act(async () => {
    const key = PLUGIN_AUTH_STORAGE_PREFIX + stateId;
    const oldValue = localStorage.getItem(key);
    localStorage.removeItem(key);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        oldValue,
        newValue: null,
      }),
    );
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
    mocks.publishedUrl = "https://relay.example.test/mcp";
    mocks.dataUpdatedAt = Date.now() - 1_000;
    mocks.isPending = false;
    mocks.isSuccess = true;
    mocks.revision = 0;
    mocks.otherServers = [];
    mocks.otherAccounts = [];
    mocks.refresh.mockReset().mockImplementation(settleQuery);
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

    await act(async () => {
      mocks.status = "connected";
      settleQuery();
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
        redirectUri: "https://relay.example.test/settings/marketplace?grokBotOAuth=1",
      },
    });
  });

  it("does not open a sign-in tab when the environment has no web address", async () => {
    vi.stubGlobal("location", new URL("t3code://app/settings/marketplace"));
    mocks.httpBaseUrl = null;
    mocks.publishedUrl = null;
    renderer = await render();
    await clickAuthenticate(renderer);

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("p").map(textOf).join("\n")).toContain("no web address");
  });

  it.each([8787, null])(
    "ends with a retry message when the sign-in tab closes before the account connects (loopback port %s)",
    async (loopbackPort) => {
      mocks.authenticate.mockResolvedValue({
        _tag: "Success",
        value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort },
      });
      renderer = await render();
      await clickAuthenticate(renderer);

      popup.closed = true;
      await advance(9_000);
      expect(bodyText(renderer)).toContain("Finish signing in in the new tab");
      await advance(4_000);
      expect(bodyText(renderer)).toContain("The sign-in tab closed before sign-in finished.");
      expect(bodyText(renderer)).not.toContain("Finish signing in");
      expect(mocks.complete).not.toHaveBeenCalled();
      const refreshCount = mocks.refresh.mock.calls.length;
      await advance(4_000);
      expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    },
  );

  it.each([8787, null])(
    "gives up after fifteen minutes without a completion (loopback port %s)",
    async (loopbackPort) => {
      mocks.authenticate.mockResolvedValue({
        _tag: "Success",
        value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort },
      });
      renderer = await render();
      await clickAuthenticate(renderer);

      await advance(15 * 60_000);
      expect(bodyText(renderer)).toContain("Sign-in did not finish in time.");
      expect(bodyText(renderer)).not.toContain("Finish signing in");
      expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).toBeNull();
      expect(mocks.complete).not.toHaveBeenCalled();
      const refreshCount = mocks.refresh.mock.calls.length;
      await advance(4_000);
      expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    },
  );

  it("reconciles an HTTPS callback signal only after the matching account is freshly connected", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    await callbackSignal();
    expect(bodyText(renderer)).toContain("Finish signing in");
    expect(bodyText(renderer)).not.toContain("Connector connected.");

    mocks.status = "connected";
    await callbackSignal();
    expect(bodyText(renderer)).toContain("Connector connected.");
    expect(bodyText(renderer)).not.toContain("Finish signing in");
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).toBeNull();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("polls HTTPS completion when the return page cannot signal this origin", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    mocks.status = "connected";
    await advance(2_000);
    expect(bodyText(renderer)).toContain("Connector connected.");
    expect(bodyText(renderer)).not.toContain("Finish signing in");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("keeps a denied HTTPS return pending until a closed tab is verified disconnected", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    popup.closed = true;
    // The callback route removes the same marker for a provider denial as for successful completion.
    await callbackSignal();
    expect(bodyText(renderer)).toContain("Finish signing in");
    expect(bodyText(renderer)).not.toContain("Connector connected.");
    await advance(12_000);
    expect(bodyText(renderer)).toContain("The sign-in tab closed before sign-in finished.");
    expect(bodyText(renderer)).not.toContain("Finish signing in");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("refreshes HTTPS completion when the initiating page regains focus", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    mocks.status = "connected";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(bodyText(renderer)).toContain("Connector connected.");
    expect(bodyText(renderer)).not.toContain("Finish signing in");
  });

  it("waits for the final status refresh instead of racing a closed HTTPS callback tab", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    popup.closed = true;
    await advance(10_000);
    mocks.refresh.mockImplementation(() => {
      mocks.isPending = true;
      notifyQuery();
    });
    await advance(2_000);
    const refreshCount = mocks.refresh.mock.calls.length;
    await advance(20_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    expect(bodyText(renderer)).toContain("Finish signing in");
    expect(bodyText(renderer)).not.toContain("tab closed before sign-in finished");

    await act(async () => {
      mocks.status = "connected";
      settleQuery();
    });
    expect(bodyText(renderer)).toContain("Connector connected.");
    expect(bodyText(renderer)).not.toContain("tab closed before sign-in finished");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("gives a callback signal time to settle after a closed-popup check has begun", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);
    popup.closed = true;
    await advance(10_000);
    mocks.refresh.mockImplementation(() => {
      mocks.isPending = true;
      notifyQuery();
    });
    await advance(2_000);
    await callbackSignal();
    await act(async () => {
      settleQuery();
    });
    expect(bodyText(renderer)).toContain("Finish signing in");

    await act(async () => {
      mocks.status = "connected";
      settleQuery();
    });
    expect(bodyText(renderer)).toContain("Connector connected.");
    expect(bodyText(renderer)).not.toContain("tab closed before sign-in finished");
  });

  it("does not accept another flow's signal or another server/account's connection", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);
    const refreshCount = mocks.refresh.mock.calls.length;
    await callbackSignal("other-flow");
    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    expect(bodyText(renderer)).toContain("Finish signing in");

    mocks.otherAccounts = [{ accountKey: "personal", authenticated: true, status: "connected" }];
    mocks.otherServers = [
      {
        id: 8,
        name: "Other connector",
        supportsOAuth: true,
        accounts: [{ accountKey: "work", authenticated: true, status: "connected" }],
      },
    ];
    await callbackSignal();
    expect(bodyText(renderer)).toContain("Finish signing in");
    expect(bodyText(renderer)).not.toContain("Connector connected.");

    mocks.status = "connected";
    await callbackSignal();
    expect(bodyText(renderer)).toContain("Connector connected.");
  });

  it("does not mistake cached connected data during reconnect for fresh completion", async () => {
    mocks.authenticate.mockImplementation(async () => {
      mocks.status = "connected";
      settleQuery();
      return {
        _tag: "Success",
        value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
      };
    });
    mocks.refresh.mockImplementation(() => {});
    renderer = await render();
    await clickAuthenticate(renderer);
    expect(bodyText(renderer)).toContain("Finish signing in");

    await callbackSignal();
    expect(bodyText(renderer)).toContain("Finish signing in");
    expect(bodyText(renderer)).not.toContain("Connector connected.");

    await act(async () => {
      mocks.isPending = true;
      mocks.dataUpdatedAt += 1;
      notifyQuery();
    });
    expect(bodyText(renderer)).toContain("Finish signing in");
    await act(async () => {
      mocks.isPending = false;
      mocks.isSuccess = false;
      notifyQuery();
    });
    expect(bodyText(renderer)).toContain("Finish signing in");

    await act(async () => {
      settleQuery();
    });
    expect(bodyText(renderer)).toContain("Connector connected.");
    expect(bodyText(renderer)).not.toContain("Finish signing in");
  });

  it("abandons an old flow when the environment changes instead of matching a new environment's account", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);

    await act(async () => {
      mocks.status = "connected";
      mocks.dataUpdatedAt += 1;
      renderer!.update(
        <GrokBotPluginAccounts environmentId={"env-2" as EnvironmentId} pluginId="linear" />,
      );
    });
    expect(bodyText(renderer)).not.toContain("Finish signing in");
    expect(bodyText(renderer)).not.toContain("Connector connected.");
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).toBeNull();
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

  it("does not retry a one-time code after manual completion fails", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow", loopbackPort: null },
    });
    mocks.complete.mockResolvedValue({ _tag: "Failure" });
    renderer = await render();
    await clickAuthenticate(renderer);

    await act(async () => {
      const value = "https://relay.example.test/callback?state=flow&code=one-time";
      renderer!.root.findAllByType("input")[0]!.props.onChange({
        target: { value },
        currentTarget: { value },
      });
    });
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });
    await advance(30_000);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(bodyText(renderer)).toContain("Authentication could not finish.");
    expect(bodyText(renderer)).not.toContain("Finish signing in");
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
  });

  it("ignores a late manual-completion failure belonging to a canceled flow", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "old-flow", loopbackPort: null },
    });
    let finishOldFlow: ((result: { _tag: "Failure" }) => void) | undefined;
    mocks.complete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOldFlow = resolve;
        }),
    );
    renderer = await render();
    await clickAuthenticate(renderer);

    await act(async () => {
      const value = "https://relay.example.test/callback?state=old-flow&code=one-time";
      renderer!.root.findAllByType("input")[0]!.props.onChange({
        target: { value },
        currentTarget: { value },
      });
    });
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });
    await act(async () => {
      buttonNamed(renderer!, "Cancel").props.onClick();
    });
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "new-flow", loopbackPort: null },
    });
    await clickAuthenticate(renderer);
    await act(async () => {
      finishOldFlow!({ _tag: "Failure" });
    });

    expect(bodyText(renderer)).toContain("Finish signing in");
    expect(bodyText(renderer)).not.toContain("Authentication could not finish.");
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}new-flow`)).not.toBeNull();
  });

  it("stops polling and expiry timers when a pending HTTPS flow is unmounted", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    renderer = await render();
    await clickAuthenticate(renderer);
    const refreshCount = mocks.refresh.mock.calls.length;
    await act(async () => {
      renderer!.unmount();
    });
    renderer = undefined;
    await advance(15 * 60_000);

    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).not.toBeNull();
  });

  it("expires HTTPS sign-in even when a status request stalls and the page regains focus", async () => {
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    mocks.refresh.mockImplementation(() => {
      mocks.isPending = true;
      notifyQuery();
    });
    renderer = await render();
    await clickAuthenticate(renderer);
    const refreshCount = mocks.refresh.mock.calls.length;
    await advance(14 * 60_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(60_000);

    expect(bodyText(renderer)).toContain("Sign-in did not finish in time.");
    expect(bodyText(renderer)).not.toContain("Finish signing in");
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
