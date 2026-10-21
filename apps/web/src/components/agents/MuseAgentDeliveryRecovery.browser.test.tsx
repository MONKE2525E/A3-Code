import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { act, render as renderScreen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("/src/state/museAgent.ts", () => ({
  museAgentFeatureReadQuery: mocks.query,
  museAgentFeatureUpdate: {},
}));
vi.mock("/src/state/use-atom-command.ts", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("/src/state/query.ts", () => ({
  useEnvironmentQuery: () => ({
    data: {
      operation: "pending_deliveries",
      data: {
        sessionId: "side:chat/1",
        deliveries: [
          { deliveryKey: "attempt-1", status: "accepted", releasable: true, blockedReason: null },
        ],
      },
    },
    refresh: mocks.refresh,
    error: null,
  }),
}));
vi.mock("/src/components/ui/toast.tsx", () => ({ toastManager: { add: vi.fn() } }));

import { MuseAgentDeliveryRecovery } from "./MuseAgentDeliveryRecovery";

it("releases the selected side-chat delivery only after confirmation, then refreshes its pending state", async () => {
  mocks.update.mockResolvedValue({ _tag: "Success", value: { updated: true } });
  const environmentId = EnvironmentId.make("env-1");
  const providerInstanceId = ProviderInstanceId.make("muse-1");
  const container = document.createElement("div");
  document.body.append(container);
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <MuseAgentDeliveryRecovery
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          sessionId="side:chat/1"
          canWrite
        />,
      ),
    );
    expect(mocks.query).toHaveBeenLastCalledWith({
      environmentId,
      input: { operation: "pending_deliveries", providerInstanceId, sessionId: "side:chat/1" },
    });
    expect(container.textContent).toContain("Delivery 1Accepted");
    const release = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Release local tracking",
    )!;
    await act(async () => release.click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Release local tracking?",
    );
    expect(mocks.update).toHaveBeenCalledTimes(0);
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Release tracking",
    )!;
    await act(async () => confirm.click());
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        operation: "delivery_release",
        providerInstanceId,
        sessionId: "side:chat/1",
        deliveryKey: "attempt-1",
      },
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
