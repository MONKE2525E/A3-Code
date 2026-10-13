import { act } from "react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  requests: [] as Array<{
    requestId: string;
    thresholdMs: number;
    startedAt: string;
    startedAtMs: number;
    tag: string;
  }>,
  add: vi.fn((_toast: { data: { onClose: () => void } }) => "slow-toast"),
  update: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../rpc/requestLatencyState", () => ({ useSlowRpcAckRequests: () => fake.requests }));
vi.mock("./ui/toast", () => ({ toastManager: fake }));
import { SlowRpcRequestToastCoordinator } from "./SlowRpcRequestToastCoordinator";

it("keeps dismissed requests hidden, while allowing a new slow request or a new batch", async () => {
  const request = (requestId: string) => ({
    requestId,
    thresholdMs: 15000,
    startedAt: "2026-10-12T00:00:00Z",
    startedAtMs: 0,
    tag: "Test request",
  });
  fake.requests = [request("first")];
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<SlowRpcRequestToastCoordinator />);
  });
  expect(fake.add).toHaveBeenCalledOnce();
  const toast = fake.add.mock.calls[0]![0];
  toast.data.onClose();
  fake.requests = [request("first")];
  await act(async () => {
    renderer!.update(<SlowRpcRequestToastCoordinator />);
  });
  expect(fake.add).toHaveBeenCalledOnce();
  expect(fake.update).not.toHaveBeenCalled();
  fake.requests = [request("first"), request("second")];
  await act(async () => {
    renderer!.update(<SlowRpcRequestToastCoordinator />);
  });
  expect(fake.add).toHaveBeenCalledTimes(2);
  fake.requests = [];
  await act(async () => {
    renderer!.update(<SlowRpcRequestToastCoordinator />);
  });
  expect(fake.close).toHaveBeenCalledWith("slow-toast");
  fake.requests = [request("first")];
  await act(async () => {
    renderer!.update(<SlowRpcRequestToastCoordinator />);
  });
  expect(fake.add).toHaveBeenCalledTimes(3);
  await act(async () => {
    renderer!.unmount();
  });
});
