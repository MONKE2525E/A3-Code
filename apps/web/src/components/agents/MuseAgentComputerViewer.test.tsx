// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId, type MuseAgentComputerState } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  stream: vi.fn(),
  disconnect: vi.fn(),
  connect: () => {},
  ready: () => {},
  updateCommand: {},
  streamCommand: {},
}));
vi.mock("~/state/museAgent", () => ({
  museAgentFeatureUpdate: mocks.updateCommand,
  museAgentComputerStreamCommand: mocks.streamCommand,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.updateCommand ? mocks.update : mocks.stream,
}));
vi.mock("@novnc/novnc", () => ({
  default: class {
    disconnect = mocks.disconnect;
    addEventListener(name: string, callback: () => void) {
      if (name === "connect") {
        mocks.connect = callback;
        mocks.ready();
      }
    }
  },
}));
import { MuseAgentComputerViewer } from "./MuseAgentComputerViewer";

const state = (expires: number, takeoverId = "lease-one"): MuseAgentComputerState => ({
  sessionId: "session-one",
  presentedTaskId: "task-one",
  activeTab: null,
  deviceClipboardSupported: false,
  lease: { taskId: "task-one", controlOwner: "user", takeoverId, controlExpiresAtMs: expires },
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  "expiry",
  "refreshed-deadline",
  "close",
  "unmount",
  "replacement",
  "target",
  "permission",
])("keeps live control bounded by its receipt without lease mutations: %s", async (outcome) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const confirmed = state(25_000);
  mocks.update.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { computerState: confirmed },
  });
  mocks.stream.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { socketUrl: "ws://synthetic.test/stream" },
  });
  mocks.disconnect.mockClear();
  const ready = new Promise<void>((resolve) => {
    mocks.ready = resolve;
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  const render = (
    lease: MuseAgentComputerState["lease"],
    sessionId = "session-one",
    canWrite = true,
  ) =>
    root.render(
      <MuseAgentComputerViewer
        environmentId={EnvironmentId.make("environment-one")}
        providerInstanceId={ProviderInstanceId.make("muse-one")}
        sessionId={sessionId}
        task={{
          taskId: "task-one",
          title: "Synthetic task",
          readOnly: false,
          previewAvailable: true,
        }}
        lease={lease}
        canWrite={canWrite}
        onTakeover={() => {}}
      />,
    );
  const click = async (label: string) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].findLast(
        (button) => button.textContent === label,
      );
      expect(button).toBeDefined();
      button!.click();
    });
  try {
    await act(async () => render(null));
    await click("Take control");
    await click("Take control");
    await act(async () => render(confirmed.lease));
    await act(async () => {
      await ready;
      mocks.connect();
    });
    expect(container.textContent).toContain("Live view");
    expect(mocks.stream).toHaveBeenCalledWith({
      environmentId: "environment-one",
      input: {
        providerInstanceId: "muse-one",
        sessionId: "session-one",
        taskId: "task-one",
        takeoverId: "lease-one",
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });
    expect(container.textContent).toContain("Live view");
    expect(mocks.disconnect).not.toHaveBeenCalled();
    if (outcome === "close") {
      await click("Close view");
      expect(container.textContent).toContain(
        "Muse resumes when the current control lease expires",
      );
      expect(container.textContent).not.toContain("Control released");
    } else if (outcome === "unmount") {
      await act(async () => root.unmount());
      unmounted = true;
    } else if (outcome === "replacement") {
      await act(async () => render(state(40_000, "lease-two").lease));
      expect(container.textContent).not.toContain("Live view");
      expect(mocks.stream).toHaveBeenCalledTimes(1);
    } else if (outcome === "target") {
      await act(async () => render(confirmed.lease, "session-two"));
      expect(container.textContent).not.toContain("Live view");
      expect(mocks.stream).toHaveBeenCalledTimes(1);
    } else if (outcome === "permission") {
      await act(async () => render(confirmed.lease, "session-one", false));
      expect(container.textContent).not.toContain("Live view");
    } else {
      if (outcome === "refreshed-deadline") {
        await act(async () => render(state(60_000).lease));
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_998);
      });
      expect(container.textContent).toContain("Live view");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(container.textContent).toContain("Control expired");
    }
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0]?.[0].input.command.action).toBe("takeover");
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["target-roundtrip", "unmount", "permission", "missing-expiry"])(
  "does not attach a late or unusable takeover receipt: %s",
  async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let finish: (value: unknown) => void = () => {
      throw new Error("not started");
    };
    mocks.update.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.stream.mockReset();
    mocks.disconnect.mockClear();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let unmounted = false;
    const render = (sessionId = "session-one", canWrite = true) =>
      root.render(
        <MuseAgentComputerViewer
          environmentId={EnvironmentId.make("environment-one")}
          providerInstanceId={ProviderInstanceId.make("muse-one")}
          sessionId={sessionId}
          task={{
            taskId: "task-one",
            title: "Synthetic task",
            readOnly: false,
            previewAvailable: true,
          }}
          lease={state(25_000).lease}
          canWrite={canWrite}
          onTakeover={() => {}}
        />,
      );
    const click = () =>
      act(async () => {
        const button = [...document.querySelectorAll("button")].findLast(
          (button) => button.textContent === "Take control",
        );
        expect(button).toBeDefined();
        button!.click();
      });
    try {
      await act(async () => render());
      await click();
      await click();
      if (outcome === "target-roundtrip") {
        await act(async () => render("session-two"));
        await act(async () => render());
      } else if (outcome === "unmount") {
        await act(async () => root.unmount());
        unmounted = true;
      } else if (outcome === "permission") {
        await act(async () => render("session-one", false));
      }
      const receipt = state(25_000, "new-lease");
      await act(async () =>
        finish({
          _tag: "Success",
          value: {
            computerState:
              outcome === "missing-expiry"
                ? { ...receipt, lease: { ...receipt.lease, controlExpiresAtMs: null } }
                : receipt,
          },
        }),
      );
      expect(mocks.stream).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.disconnect).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Waiting for control");
    } finally {
      if (!unmounted) await act(async () => root.unmount());
      container.remove();
    }
  },
);
