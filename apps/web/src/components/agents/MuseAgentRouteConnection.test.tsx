// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ open: vi.fn(), allowed: true }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.allowed }));
vi.mock("~/state/museAgent", () => ({ museAgentOpenThread: { permissionAtom: () => ({}) } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));
import { MuseAgentRouteConnection } from "./MuseAgentRouteConnection";

const environmentId = EnvironmentId.make("remote-env");
const providerInstanceId = ProviderInstanceId.make("historical-muse-provider");
const main = ThreadId.make(`muse-agent:${"a".repeat(64)}`);
const side = ThreadId.make(`${main}:${encodeURIComponent("side:one")}`);
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
          {...{ environmentId, providerInstanceId, threadId, connected, hasMessages: true }}
        />,
      );
    try {
      await act(async () => render(false));
      expect(mocks.open).not.toHaveBeenCalled();
      await act(async () => render(true));
      expect(mocks.open).toHaveBeenCalledTimes(1);
      expect(mocks.open).toHaveBeenLastCalledWith({
        environmentId,
        input: { providerInstanceId, ...(threadId === side ? { sessionId: "side:one" } : {}) },
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
        />,
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("active Muse turn");
    await act(async () => container.querySelector("button")!.click());
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.open.mock.calls[1]).toEqual(mocks.open.mock.calls[0]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows a chat loading pane until the first history arrives", async () => {
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
        />,
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Opening Muse");
    expect(container.textContent).toContain("Loading conversation history.");
    expect(container.textContent).not.toContain("Nothing is sent to Muse");
    expect(container.textContent).not.toContain("Connecting Muse history");
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
        />,
      ),
    );
    expect(mocks.open).not.toHaveBeenCalled();
    expect(container.textContent).toContain("permission");
  } finally {
    await act(async () => root.unmount());
  }
});
