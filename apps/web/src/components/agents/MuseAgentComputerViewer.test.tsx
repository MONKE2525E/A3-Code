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

it.each(["renewed", "older-renewal", "foreign", "no-renewal"])(
  "expires only the held lease using heartbeat evidence: %s",
  async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const confirmed = state(15_000);
    let finishHeartbeat: (value: unknown) => void = () => {
      throw new Error("not started");
    };
    mocks.update.mockReset().mockImplementation((request) => {
      if (request.input.command.action === "takeover")
        return Promise.resolve({ _tag: "Success", value: { computerState: confirmed } });
      if (request.input.command.action === "heartbeat")
        return new Promise((resolve) => {
          finishHeartbeat = resolve;
        });
      return Promise.resolve({ _tag: "Success", value: {} });
    });
    mocks.stream
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { socketUrl: "ws://synthetic.test/stream" } });
    mocks.disconnect.mockClear();
    const ready = new Promise<void>((resolve) => {
      mocks.ready = resolve;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (lease: MuseAgentComputerState["lease"]) =>
      root.render(
        <MuseAgentComputerViewer
          environmentId={EnvironmentId.make("environment-one")}
          providerInstanceId={ProviderInstanceId.make("muse-one")}
          sessionId="session-one"
          task={{
            taskId: "task-one",
            title: "Synthetic task",
            readOnly: false,
            previewAvailable: true,
          }}
          lease={lease}
          canWrite
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
      await act(async () => {
        render(confirmed.lease);
      });
      await act(async () => {
        await ready;
        mocks.connect();
      });
      expect(container.textContent).toContain("Live view");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await act(async () =>
        finishHeartbeat({
          _tag: "Success",
          value:
            outcome === "no-renewal"
              ? {}
              : {
                  computerState: state(35_000, outcome === "foreign" ? "other-lease" : "lease-one"),
                },
        }),
      );
      // The task-detail query remains stale at its original 15-second expiry.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_001);
      });
      const releases = () =>
        mocks.update.mock.calls.filter(([request]) => request.input.command.action === "release");
      if (outcome === "renewed" || outcome === "older-renewal") {
        expect(container.textContent).toContain("Live view");
        expect(releases()).toHaveLength(0);
        expect(mocks.disconnect).not.toHaveBeenCalled();
        if (outcome === "older-renewal") {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
          });
          await act(async () =>
            finishHeartbeat({ _tag: "Success", value: { computerState: state(25_000) } }),
          );
          await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
          });
          expect(container.textContent).toContain("Live view");
          expect(releases()).toHaveLength(0);
        }
        await act(async () => {
          await vi.advanceTimersByTimeAsync(outcome === "older-renewal" ? 10_000 : 20_000);
        });
      }
      expect(container.textContent).toContain("Control expired");
      expect(releases()).toHaveLength(1);
      expect(releases()[0]?.[0].input.command.takeoverId).toBe("lease-one");
      expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
