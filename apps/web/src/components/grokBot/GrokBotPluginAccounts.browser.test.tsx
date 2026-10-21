import type { EnvironmentId, GrokBotPluginConnectionsResult } from "@t3tools/contracts";
import { act, render, fakeTimers, type Screen } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  pageOrigin: "t3code://app",
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

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("/src/state/grokBots.ts", () => ({
  grokBotsPluginAuthenticate: { label: "authenticate", permissionAtom: () => null },
  grokBotsPluginCompleteAuth: { label: "complete" },
  grokBotsPluginConnectionsQuery: () => null,
  grokBotsOrchestratorConfigQuery: () => ({ kind: "config" }),
}));
vi.mock("/src/state/environments.ts", () => ({
  useEnvironmentHttpBaseUrl: () => mocks.httpBaseUrl,
}));
vi.mock("/src/state/query.ts", async () => {
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
vi.mock("/src/state/use-atom-command.ts", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "authenticate" ? mocks.authenticate : mocks.complete,
}));

vi.mock("/src/components/grokBot/grokBotSetupFlow.ts", async (original) => {
  const actual = await original<typeof import("./grokBotSetupFlow")>();
  return {
    ...actual,
    resolveGrokBotOAuthRedirect: (_origin: string, ...args: [string | null, string | null]) =>
      actual.resolveGrokBotOAuthRedirect(mocks.pageOrigin, ...args),
  };
});

import { GrokBotPluginAccounts, PLUGIN_AUTH_STORAGE_PREFIX } from "./GrokBotPluginAccounts";

const environmentId = "env-1" as EnvironmentId;
const authorizationUrl = "https://auth.example.test/authorize?state=flow.tgd";

const EPOCH = 1_800_000_000_000;
const bodyText = (screen: Screen) => screen.container.textContent ?? "";
async function clickAuthenticate(screen: Screen) {
  await act(() =>
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Authenticate")!
      .click(),
  );
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
  mocks.dataUpdatedAt = Math.max(
    vi.getMockedSystemTime()?.getTime() ?? EPOCH,
    mocks.dataUpdatedAt + 1,
  );
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

function setup() {
  const disposables = new DisposableStack();
  mocks.status = "needsAuth";
  mocks.httpBaseUrl = "http://100.64.0.2:3773";
  mocks.publishedUrl = "https://relay.example.test/mcp";
  mocks.dataUpdatedAt = EPOCH - 1_000;
  mocks.isPending = false;
  mocks.isSuccess = true;
  mocks.revision = 0;
  mocks.otherServers = [];
  mocks.otherAccounts = [];
  mocks.refresh.mockReset().mockImplementation(settleQuery);
  mocks.authenticate.mockReset();
  mocks.complete.mockReset();
  const popup = { closed: false, location: { href: "" }, opener: undefined, close: vi.fn() };
  disposables.use(vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window));
  localStorage.clear();
  return Object.assign(disposables, { popup });
}

describe("GrokBotPluginAccounts sign-in", () => {
  it("opens the provider page in the popup and ends when the server reports the account connected", async () => {
    using fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: 8787 },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    expect(fixture.popup.location.href).toBe(authorizationUrl);
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).not.toBeNull();
    expect(bodyText(screen)).toContain("Finish signing in in the new tab");

    await advance(2_000);
    expect(mocks.refresh).toHaveBeenCalled();

    await act(async () => {
      mocks.status = "connected";
      settleQuery();
    });
    expect(bodyText(screen)).toContain("Connector connected.");
    expect(bodyText(screen)).not.toContain("Finish signing in");
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).toBeNull();
  });

  it("returns sign-in to the environment's web address, not the page that started it", async () => {
    using _fixture = setup();
    // Electron's page origin is not a web address the provider can redirect to.
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

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
    using _fixture = setup();
    mocks.httpBaseUrl = null;
    mocks.publishedUrl = null;
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(bodyText(screen)).toContain("no web address");
  });

  it.each([8787, null])(
    "ends with a retry message when the sign-in tab closes before the account connects (loopback port %s)",
    async (loopbackPort) => {
      using fixture = setup();
      mocks.authenticate.mockResolvedValue({
        _tag: "Success",
        value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort },
      });
      await using screen = await render(
        <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
      );
      using _timers = fakeTimers();
      vi.setSystemTime(EPOCH);
      await clickAuthenticate(screen);

      fixture.popup.closed = true;
      await advance(9_000);
      expect(bodyText(screen)).toContain("Finish signing in in the new tab");
      await advance(4_000);
      expect(bodyText(screen)).toContain("The sign-in tab closed before sign-in finished.");
      expect(bodyText(screen)).not.toContain("Finish signing in");
      expect(mocks.complete).not.toHaveBeenCalled();
      const refreshCount = mocks.refresh.mock.calls.length;
      await advance(4_000);
      expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    },
  );

  it.each([8787, null])(
    "gives up after fifteen minutes without a completion (loopback port %s)",
    async (loopbackPort) => {
      using _fixture = setup();
      mocks.authenticate.mockResolvedValue({
        _tag: "Success",
        value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort },
      });
      await using screen = await render(
        <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
      );
      using _timers = fakeTimers();
      vi.setSystemTime(EPOCH);
      await clickAuthenticate(screen);

      await advance(15 * 60_000);
      expect(bodyText(screen)).toContain("Sign-in did not finish in time.");
      expect(bodyText(screen)).not.toContain("Finish signing in");
      expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).toBeNull();
      expect(mocks.complete).not.toHaveBeenCalled();
      const refreshCount = mocks.refresh.mock.calls.length;
      await advance(4_000);
      expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    },
  );

  it("reconciles an HTTPS callback signal only after the matching account is freshly connected", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    await callbackSignal();
    expect(bodyText(screen)).toContain("Finish signing in");
    expect(bodyText(screen)).not.toContain("Connector connected.");

    mocks.status = "connected";
    await callbackSignal();
    expect(bodyText(screen)).toContain("Connector connected.");
    expect(bodyText(screen)).not.toContain("Finish signing in");
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).toBeNull();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("polls HTTPS completion when the return page cannot signal this origin", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    mocks.status = "connected";
    await advance(2_000);
    expect(bodyText(screen)).toContain("Connector connected.");
    expect(bodyText(screen)).not.toContain("Finish signing in");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("keeps a denied HTTPS return pending until a closed tab is verified disconnected", async () => {
    using fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    fixture.popup.closed = true;
    // The callback route removes the same marker for a provider denial as for successful completion.
    await callbackSignal();
    expect(bodyText(screen)).toContain("Finish signing in");
    expect(bodyText(screen)).not.toContain("Connector connected.");
    await advance(12_000);
    expect(bodyText(screen)).toContain("The sign-in tab closed before sign-in finished.");
    expect(bodyText(screen)).not.toContain("Finish signing in");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("refreshes HTTPS completion when the initiating page regains focus", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    mocks.status = "connected";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(bodyText(screen)).toContain("Connector connected.");
    expect(bodyText(screen)).not.toContain("Finish signing in");
  });

  it("waits for the final status refresh instead of racing a closed HTTPS callback tab", async () => {
    using fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    fixture.popup.closed = true;
    await advance(10_000);
    mocks.refresh.mockImplementation(() => {
      mocks.isPending = true;
      notifyQuery();
    });
    await advance(2_000);
    const refreshCount = mocks.refresh.mock.calls.length;
    await advance(20_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    expect(bodyText(screen)).toContain("Finish signing in");
    expect(bodyText(screen)).not.toContain("tab closed before sign-in finished");

    await act(async () => {
      mocks.status = "connected";
      settleQuery();
    });
    expect(bodyText(screen)).toContain("Connector connected.");
    expect(bodyText(screen)).not.toContain("tab closed before sign-in finished");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("gives a callback signal time to settle after a closed-popup check has begun", async () => {
    using fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);
    fixture.popup.closed = true;
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
    expect(bodyText(screen)).toContain("Finish signing in");

    await act(async () => {
      mocks.status = "connected";
      settleQuery();
    });
    expect(bodyText(screen)).toContain("Connector connected.");
    expect(bodyText(screen)).not.toContain("tab closed before sign-in finished");
  });

  it("does not accept another flow's signal or another server/account's connection", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);
    const refreshCount = mocks.refresh.mock.calls.length;
    await callbackSignal("other-flow");
    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    expect(bodyText(screen)).toContain("Finish signing in");

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
    expect(bodyText(screen)).toContain("Finish signing in");
    expect(bodyText(screen)).not.toContain("Connector connected.");

    mocks.status = "connected";
    await callbackSignal();
    expect(bodyText(screen)).toContain("Connector connected.");
  });

  it("does not mistake cached connected data during reconnect for fresh completion", async () => {
    using _fixture = setup();
    mocks.authenticate.mockImplementation(async () => {
      mocks.status = "connected";
      settleQuery();
      return {
        _tag: "Success",
        value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
      };
    });
    mocks.refresh.mockImplementation(() => {});
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);
    expect(bodyText(screen)).toContain("Finish signing in");

    await callbackSignal();
    expect(bodyText(screen)).toContain("Finish signing in");
    expect(bodyText(screen)).not.toContain("Connector connected.");

    await act(async () => {
      mocks.isPending = true;
      mocks.dataUpdatedAt += 1;
      notifyQuery();
    });
    expect(bodyText(screen)).toContain("Finish signing in");
    await act(async () => {
      mocks.isPending = false;
      mocks.isSuccess = false;
      notifyQuery();
    });
    expect(bodyText(screen)).toContain("Finish signing in");

    await act(async () => {
      settleQuery();
    });
    expect(bodyText(screen)).toContain("Connector connected.");
    expect(bodyText(screen)).not.toContain("Finish signing in");
  });

  it("abandons an old flow when the environment changes instead of matching a new environment's account", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    await act(async () => {
      mocks.status = "connected";
      mocks.dataUpdatedAt += 1;
      screen.rerender(
        <GrokBotPluginAccounts environmentId={"env-2" as EnvironmentId} pluginId="linear" />,
      );
    });
    expect(bodyText(screen)).not.toContain("Finish signing in");
    expect(bodyText(screen)).not.toContain("Connector connected.");
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).toBeNull();
  });

  it("finishes a flow without a loopback listener from a pasted address, then clears the field", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow", loopbackPort: null },
    });
    mocks.complete.mockResolvedValue({ _tag: "Success", value: { accountKey: "work" } });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    const value = "http://localhost:8787/callback?state=flow&code=abc";
    await userEvent.fill(screen.container.querySelector<HTMLInputElement>("input")!, value);
    await act(async () => {
      screen.container.querySelector("form")!.requestSubmit();
    });

    expect(mocks.complete).toHaveBeenCalledWith({
      environmentId,
      input: { stateId: "flow", code: "abc" },
    });
    // A completed flow ends, so its paste field is gone along with the code it held.
    expect([...screen.container.querySelectorAll<HTMLInputElement>("input")]).toHaveLength(0);
    expect(bodyText(screen)).toContain("Connector connected.");
  });

  it("explains an unreadable address without completing, and still clears the field", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    const value = "one-time";
    await userEvent.fill(screen.container.querySelector<HTMLInputElement>("input")!, value);
    await act(async () => {
      screen.container.querySelector("form")!.requestSubmit();
    });

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(bodyText(screen)).toContain("That is not a full address.");
    expect(screen.container.querySelector<HTMLInputElement>("input")!.value).toBe("");
  });

  it("does not retry a one-time code after manual completion fails", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow", loopbackPort: null },
    });
    mocks.complete.mockResolvedValue({ _tag: "Failure" });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    const value = "https://relay.example.test/callback?state=flow&code=one-time";
    await userEvent.fill(screen.container.querySelector<HTMLInputElement>("input")!, value);
    await act(async () => {
      screen.container.querySelector("form")!.requestSubmit();
    });
    await advance(30_000);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(bodyText(screen)).toContain("Authentication could not finish.");
    expect(bodyText(screen)).not.toContain("Finish signing in");
    expect([...screen.container.querySelectorAll<HTMLInputElement>("input")]).toHaveLength(0);
  });

  it("ignores a late manual-completion failure belonging to a canceled flow", async () => {
    using _fixture = setup();
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
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);

    const value = "https://relay.example.test/callback?state=old-flow&code=one-time";
    await userEvent.fill(screen.container.querySelector<HTMLInputElement>("input")!, value);
    await act(async () => {
      screen.container.querySelector("form")!.requestSubmit();
    });
    await act(async () => {
      [...screen.container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Cancel"))!
        .click();
    });
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "new-flow", loopbackPort: null },
    });
    await clickAuthenticate(screen);
    await act(async () => {
      finishOldFlow!({ _tag: "Failure" });
    });

    expect(bodyText(screen)).toContain("Finish signing in");
    expect(bodyText(screen)).not.toContain("Authentication could not finish.");
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}new-flow`)).not.toBeNull();
  });

  it("stops polling and expiry timers when a pending HTTPS flow is unmounted", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);
    const refreshCount = mocks.refresh.mock.calls.length;
    await act(async () => {
      await screen.unmount();
    });
    await advance(15 * 60_000);

    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    expect(localStorage.getItem(`${PLUGIN_AUTH_STORAGE_PREFIX}flow.tgd`)).not.toBeNull();
  });

  it("expires HTTPS sign-in even when a status request stalls and the page regains focus", async () => {
    using _fixture = setup();
    mocks.authenticate.mockResolvedValue({
      _tag: "Success",
      value: { authenticated: false, authorizationUrl, stateId: "flow.tgd", loopbackPort: null },
    });
    mocks.refresh.mockImplementation(() => {
      mocks.isPending = true;
      notifyQuery();
    });
    await using screen = await render(
      <GrokBotPluginAccounts environmentId={environmentId} pluginId="linear" />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime(EPOCH);
    await clickAuthenticate(screen);
    const refreshCount = mocks.refresh.mock.calls.length;
    await advance(14 * 60_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(refreshCount);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(60_000);

    expect(bodyText(screen)).toContain("Sign-in did not finish in time.");
    expect(bodyText(screen)).not.toContain("Finish signing in");
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
