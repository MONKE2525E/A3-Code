import type { EnvironmentId, GrokBotPluginConnectionsResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act, render, fakeTimers, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

type Connections = typeof GrokBotPluginConnectionsResult.Type;

const mocks = vi.hoisted(() => ({
  httpBaseUrl: "http://100.64.0.2:3773" as string | null,
  connection: null as AsyncResult.AsyncResult<Connections, Error> | null,
  published: "https://this-environment.example.test/mcp" as string | null,
  queryRefresh: vi.fn(),
  refresh: vi.fn(),
  authenticate: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: { label?: string }) =>
    atom.label === "permission"
      ? true
      : atom.label === "config"
        ? AsyncResult.success({ setupStatus: { mcpUrl: mocks.published } })
        : (mocks.connection ?? AsyncResult.initial(false)),
  useAtomRefresh: () => mocks.queryRefresh,
}));
vi.mock("/src/state/grokBots.ts", () => ({
  grokBotsOrchestratorConfigQuery: vi.fn(() => ({ label: "config" })),
  grokBotsPluginAuthenticate: {
    label: "authenticate",
    permissionAtom: () => ({ label: "permission" }),
  },
  grokBotsPluginCompleteAuth: { label: "complete" },
  grokBotsPluginConnectionsQuery: () => ({ label: "connections" }),
}));
vi.mock("/src/state/environments.ts", () => ({
  useEnvironmentHttpBaseUrl: () => mocks.httpBaseUrl,
}));
vi.mock("/src/state/use-atom-command.ts", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "authenticate" ? mocks.authenticate : mocks.complete,
}));

import { grokBotsOrchestratorConfigQuery } from "~/state/grokBots";
import { GrokBotSetupAuthorize } from "./GrokBotSetupAuthorize";
import { PLUGIN_AUTH_STORAGE_PREFIX } from "./GrokBotPluginAccounts";

const environmentId = "env-1" as EnvironmentId;
const stateId = "setup-flow";
const authorizationUrl = `https://auth.example.test/authorize?state=${stateId}`;
const connections = (authenticated: boolean): Connections => ({
  servers: [
    {
      id: 7,
      name: "T3",
      supportsOAuth: true,
      accounts: [
        { accountKey: "default", authenticated, status: authenticated ? "connected" : "needsAuth" },
      ],
    },
  ],
});
const element = () => (
  <GrokBotSetupAuthorize environmentId={environmentId} serverId={7} refresh={mocks.refresh} />
);

async function update(screen: Screen, result: NonNullable<typeof mocks.connection>) {
  mocks.connection = result;
  await screen.rerender(element());
}
async function click(screen: Screen, label: string) {
  const button = [...screen.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(label),
  );
  if (!button) throw new Error(`No button named ${label}`);
  await act(() => button.click());
}
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function setup() {
  const disposables = new DisposableStack();
  mocks.httpBaseUrl = "http://100.64.0.2:3773";
  mocks.published = "https://this-environment.example.test/mcp";
  mocks.connection = AsyncResult.success(connections(false), { timestamp: 1 });
  mocks.queryRefresh.mockReset();
  mocks.refresh.mockReset();
  mocks.authenticate.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { authenticated: false, authorizationUrl, stateId, loopbackPort: 8787 },
  });
  mocks.complete.mockReset();
  vi.mocked(grokBotsOrchestratorConfigQuery).mockClear();
  const popup = { location: { href: "" }, opener: undefined, close: vi.fn() };
  disposables.use(vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window));
  localStorage.clear();
  return Object.assign(disposables, { popup });
}

describe("GrokBotSetupAuthorize", () => {
  it("uses the destination environment's published HTTPS callback over an HTTP tailnet route", async () => {
    using fixture = setup();
    await using screen = await render(element());
    using _timers = fakeTimers();
    await click(screen, "Authorize T3 connection");
    expect(grokBotsOrchestratorConfigQuery).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(mocks.authenticate).toHaveBeenCalledWith({
      environmentId,
      input: {
        serverId: 7,
        accountKey: "default",
        redirectUri: "https://this-environment.example.test/settings/marketplace?grokBotOAuth=1",
      },
    });
    expect(fixture.popup.location.href).toBe(authorizationUrl);
  });

  it("does not start OAuth without a secure remote callback", async () => {
    using _fixture = setup();
    mocks.published = null;
    await using screen = await render(element());
    using _timers = fakeTimers();
    await click(screen, "Authorize T3 connection");
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.container.querySelector("[role=alert]")?.textContent).toContain("HTTPS");
  });

  it("rearms polling after a transient failure with retained data, then completes once", async () => {
    using _fixture = setup();
    const unauthenticated = AsyncResult.success<Connections, Error>(connections(false), {
      timestamp: 1,
    });
    mocks.connection = unauthenticated;
    await using screen = await render(element());
    using _timers = fakeTimers();
    await click(screen, "Authorize T3 connection");
    await update(screen, AsyncResult.waiting(unauthenticated));
    await advance(20_000);
    expect(mocks.queryRefresh).not.toHaveBeenCalled();

    await update(screen, unauthenticated);
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(1);
    await update(screen, AsyncResult.waiting(unauthenticated));
    await advance(20_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(1);

    const failure = AsyncResult.failure(Cause.fail(new Error("temporary connection failure")), {
      previousSuccess: Option.some(unauthenticated),
    });
    await update(screen, failure);
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(2);
    await update(screen, AsyncResult.waiting(failure));
    await advance(20_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(2);
    await update(screen, AsyncResult.success(connections(true), { timestamp: 2 }));

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PLUGIN_AUTH_STORAGE_PREFIX + stateId)).toBeNull();
    await expect
      .element(screen.getByRole("button", { name: "Authorize T3 connection" }))
      .toBeVisible();
    await advance(15 * 60_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.container.querySelectorAll("[role=alert]")).toHaveLength(0);
  });

  it("keeps polling through repeated failures even when pending transitions are batched away", async () => {
    using _fixture = setup();
    const unauthenticated = AsyncResult.success<Connections, Error>(connections(false), {
      timestamp: 1,
    });
    const cause = Cause.fail(new Error("temporarily unavailable"));
    mocks.connection = unauthenticated;
    await using screen = await render(element());
    using _timers = fakeTimers();
    await click(screen, "Authorize T3 connection");
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(1);

    await update(
      screen,
      AsyncResult.failure(cause, { previousSuccess: Option.some(unauthenticated) }),
    );
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(2);
    await update(
      screen,
      AsyncResult.failure(cause, { previousSuccess: Option.some(unauthenticated) }),
    );
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(3);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("cleans up pending polling on unmount", async () => {
    using _fixture = setup();
    await using screen = await render(element());
    using _timers = fakeTimers();
    await click(screen, "Authorize T3 connection");
    await screen.unmount();
    await advance(15 * 60_000);
    expect(mocks.queryRefresh).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("stops polling when the user abandons the flow", async () => {
    using _fixture = setup();
    await using screen = await render(element());
    using _timers = fakeTimers();
    await click(screen, "Authorize T3 connection");
    await click(screen, "Start over");
    await advance(15 * 60_000);
    expect(mocks.queryRefresh).not.toHaveBeenCalled();
    expect(localStorage.getItem(PLUGIN_AUTH_STORAGE_PREFIX + stateId)).toBeNull();
  });
});
