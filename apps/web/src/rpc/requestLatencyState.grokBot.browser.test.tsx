import { WS_METHODS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import { AppAtomRegistryProvider } from "./atomRegistry";
import {
  acknowledgeRpcRequest,
  trackRpcRequestSent,
  useSlowRpcAckRequests,
} from "./requestLatencyState";

function SlowRequests() {
  return (
    <output>
      {useSlowRpcAckRequests()
        .map((request) => request.requestId)
        .join(",")}
    </output>
  );
}
it("allows normal voice long polls while warning when a voice request gets stuck", async () => {
  // This headless request tracker has no routing behavior.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <SlowRequests />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  using _timers = fakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const requestId = "voice-long-poll";
  try {
    await act(() => trackRpcRequestSent(requestId, WS_METHODS.grokBotsVoiceTool));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(screen.container.textContent).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(100_000));
    expect(screen.container.textContent).toBe(requestId);
    await act(() => acknowledgeRpcRequest(requestId));
    expect(screen.container.textContent).toBe("");
  } finally {
    acknowledgeRpcRequest(requestId);
  }
});
