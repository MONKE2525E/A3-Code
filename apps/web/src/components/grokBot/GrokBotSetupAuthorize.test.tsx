// @vitest-environment jsdom

import type { EnvironmentId, GrokBotPluginConnectionsResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { label?: string }) =>
    atom.label === "permission"
      ? true
      : atom.label === "config"
        ? AsyncResult.success({ setupStatus: { mcpUrl: mocks.published } })
        : (mocks.connection ?? AsyncResult.initial(false)),
  useAtomRefresh: () => mocks.queryRefresh,
}));
vi.mock("~/state/grokBots", () => ({
  grokBotsOrchestratorConfigQuery: vi.fn(() => ({ label: "config" })),
  grokBotsPluginAuthenticate: {
    label: "authenticate",
    permissionAtom: () => ({ label: "permission" }),
  },
  grokBotsPluginCompleteAuth: { label: "complete" },
  grokBotsPluginConnectionsQuery: () => ({ label: "connections" }),
}));
vi.mock("~/state/environments", () => ({ useEnvironmentHttpBaseUrl: () => mocks.httpBaseUrl }));
vi.mock("~/state/use-atom-command", () => ({
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

describe("GrokBotSetupAuthorize", () => {
  let renderer: ReactTestRenderer | undefined;
  let popup: { location: { href: string }; opener: unknown; close: () => void };

  async function renderAndStart() {
    await act(async () => {
      renderer = create(element());
    });
    await act(async () => {
      buttonNamed(renderer!, "Authorize T3 connection").props.onClick();
    });
  }

  async function update(result: NonNullable<typeof mocks.connection>) {
    mocks.connection = result;
    await act(async () => {
      renderer!.update(element());
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    popup = { location: { href: "" }, opener: undefined, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    localStorage.clear();
  });

  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the destination environment's published HTTPS callback over an HTTP tailnet route", async () => {
    await renderAndStart();
    expect(grokBotsOrchestratorConfigQuery).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(mocks.authenticate).toHaveBeenCalledWith({
      environmentId,
      input: {
        serverId: 7,
        accountKey: "default",
        redirectUri: "https://this-environment.example.test/settings/marketplace?grokBotOAuth=1",
      },
    });
    expect(popup.location.href).toBe(authorizationUrl);
  });

  it("does not start OAuth without a secure remote callback", async () => {
    mocks.published = null;
    await renderAndStart();
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain("HTTPS");
  });

  it("rearms polling after a transient failure with retained data, then completes once", async () => {
    const unauthenticated = AsyncResult.success<Connections, Error>(connections(false), {
      timestamp: 1,
    });
    mocks.connection = unauthenticated;
    await renderAndStart();
    await update(AsyncResult.waiting(unauthenticated));
    await advance(20_000);
    expect(mocks.queryRefresh).not.toHaveBeenCalled();

    await update(unauthenticated);
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(1);
    await update(AsyncResult.waiting(unauthenticated));
    await advance(20_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(1);

    const failure = AsyncResult.failure(Cause.fail(new Error("temporary connection failure")), {
      previousSuccess: Option.some(unauthenticated),
    });
    await update(failure);
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(2);
    await update(AsyncResult.waiting(failure));
    await advance(20_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(2);
    await update(AsyncResult.success(connections(true), { timestamp: 2 }));

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PLUGIN_AUTH_STORAGE_PREFIX + stateId)).toBeNull();
    expect(buttonNamed(renderer!, "Authorize T3 connection")).toBeDefined();
    await advance(15 * 60_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("keeps polling through repeated failures even when pending transitions are batched away", async () => {
    const unauthenticated = AsyncResult.success<Connections, Error>(connections(false), {
      timestamp: 1,
    });
    const cause = Cause.fail(new Error("temporarily unavailable"));
    mocks.connection = unauthenticated;
    await renderAndStart();
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(1);

    await update(AsyncResult.failure(cause, { previousSuccess: Option.some(unauthenticated) }));
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(2);
    await update(AsyncResult.failure(cause, { previousSuccess: Option.some(unauthenticated) }));
    await advance(5_000);
    expect(mocks.queryRefresh).toHaveBeenCalledTimes(3);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("cleans up pending polling on unmount", async () => {
    await renderAndStart();
    await act(async () => {
      renderer!.unmount();
    });
    renderer = undefined;
    await advance(15 * 60_000);
    expect(mocks.queryRefresh).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("stops polling when the user abandons the flow", async () => {
    await renderAndStart();
    await act(async () => {
      buttonNamed(renderer!, "Start over").props.onClick();
    });
    await advance(15 * 60_000);
    expect(mocks.queryRefresh).not.toHaveBeenCalled();
    expect(localStorage.getItem(PLUGIN_AUTH_STORAGE_PREFIX + stateId)).toBeNull();
  });
});
