// @vitest-environment jsdom
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as RpcClientError from "effect/rpc/RpcClientError";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ open: vi.fn(), allowed: true }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.allowed }));
vi.mock("../../state/museAgent", () => ({ museAgentOpenThread: { permissionAtom: () => ({}) } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));
vi.mock("react-native", () => ({
  View: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  Pressable: ({ children, onPress, ...props }: { children?: ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress} {...props}>
      {children}
    </button>
  ),
  ActivityIndicator: () => <span>spinner</span>,
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children, ...props }: { children?: ReactNode }) => <span {...props}>{children}</span>,
}));
vi.mock("../../components/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <span>spinner</span>,
}));

import { MuseAgentRouteConnection } from "./MuseAgentRouteConnection";

const environmentId = EnvironmentId.make("remote-env");
const providerInstanceId = ProviderInstanceId.make("historical-muse-provider");
const main = ThreadId.make(`muse-agent:${"a".repeat(64)}`);
const side = ThreadId.make(`${main}:${encodeURIComponent("side:one")}`);
const museProviders = [{ instanceId: providerInstanceId, driver: "muse-agent" }];

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.allowed = true;
});

it.each([main, side])(
  "reattaches restored %s after connection and again after reconnect",
  async (threadId) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.open.mockReset().mockResolvedValue({ _tag: "Success", value: { threadId } });
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (connected: boolean) =>
      root.render(
        <MuseAgentRouteConnection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId={threadId}
          connected={connected}
          hasMessages
          providers={museProviders}
        />,
      );
    try {
      await act(async () => render(false));
      expect(mocks.open).not.toHaveBeenCalled();
      await act(async () => render(true));
      expect(mocks.open).toHaveBeenCalledTimes(1);
      expect(mocks.open).toHaveBeenLastCalledWith({
        environmentId,
        input: {
          providerInstanceId,
          ...(threadId === side ? { sessionId: "side:one" } : {}),
        },
      });
      expect(container.textContent).toBe("");
      await act(async () => render(true));
      expect(mocks.open).toHaveBeenCalledTimes(1);
      await act(async () => render(false));
      await act(async () => render(true));
      expect(mocks.open).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("surfaces attach errors and retries the restored conversation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.open
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Wait for the active Muse turn and retry.")),
    })
    .mockResolvedValue({ _tag: "Success", value: { threadId: side } });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentRouteConnection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId={side}
          connected
          hasMessages
          providers={museProviders}
        />,
      ),
    );
    expect(container.textContent).toContain("active Muse turn");
    await act(async () => container.querySelector("button")!.click());
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.open.mock.calls[1]).toEqual(mocks.open.mock.calls[0]);
    expect(container.textContent).not.toContain("active Muse turn");
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  [
    "unavailable",
    new EnvironmentRpcUnavailableError({
      environmentId: "env",
      message: "socket timeout token=secret",
    }),
  ],
  [
    "unknown-method",
    new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "method not found",
        cause: new Error("method not found"),
      }),
    }),
  ],
] as const)(
  "shows a retryable error after %s RPC failure instead of silent absence",
  async (_label, failure) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.open.mockReset().mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(failure),
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MuseAgentRouteConnection
            environmentId={environmentId}
            providerInstanceId={providerInstanceId}
            threadId={main}
            connected
            hasMessages
            providers={museProviders}
          />,
        ),
      );
      expect(container.textContent).toContain("Could not reconnect this Muse conversation.");
      expect(container.textContent).not.toContain("socket timeout");
      expect(container.textContent).not.toContain("secret");
      expect(container.textContent).not.toContain("method not found");
      expect(container.querySelector("button")?.textContent).toContain("Retry Muse connection");
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("shows history loading copy until the first page arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish: (value: unknown) => void = () => {
    throw new Error("not started");
  };
  mocks.open.mockReset().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentRouteConnection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId={main}
          connected
          hasMessages={false}
          providers={museProviders}
        />,
      ),
    );
    expect(container.textContent).toContain("Loading conversation history.");
    expect(container.textContent).not.toContain("Nothing is sent to Muse");
    await act(async () => finish({ _tag: "Success", value: { threadId: main } }));
    expect(container.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not attach without destination permission", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.allowed = false;
  mocks.open.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentRouteConnection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId={main}
          connected
          hasMessages
          providers={museProviders}
        />,
      ),
    );
    expect(mocks.open).not.toHaveBeenCalled();
    expect(container.textContent).toContain("permission");
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not call fork RPC for ordinary threads or official nightly", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.open.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentRouteConnection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId={ThreadId.make("ordinary-thread")}
          connected
          hasMessages
          providers={museProviders}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <MuseAgentRouteConnection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId={main}
          connected
          hasMessages
          providers={[{ instanceId: providerInstanceId, driver: "codex" }]}
        />,
      ),
    );
    expect(mocks.open).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
  }
});

it("suppresses local state after unmount while the in-flight RPC still settles", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish: (value: unknown) => void = () => {
    throw new Error("not started");
  };
  mocks.open.mockReset().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MuseAgentRouteConnection
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        threadId={main}
        connected
        hasMessages
        providers={museProviders}
      />,
    ),
  );
  expect(mocks.open).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  await act(async () => finish({ _tag: "Success", value: { threadId: main } }));
  expect(mocks.open).toHaveBeenCalledTimes(1);
});
