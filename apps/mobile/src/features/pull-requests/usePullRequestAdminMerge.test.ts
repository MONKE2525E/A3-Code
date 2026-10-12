import { EnvironmentId } from "@t3tools/contracts";
import type { TerminalBufferState } from "@t3tools/client-runtime/state/terminal";
import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
} from "@t3tools/client-runtime/state/terminal";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePullRequestAdminMerge, type AdminMergeResult } from "./usePullRequestAdminMerge";

const state = vi.hoisted(() => ({
  registry: undefined as AtomRegistry.AtomRegistry | undefined,
  observed: undefined as
    | Atom.Writable<AsyncResult.AsyncResult<TerminalBufferState, Error>>
    | undefined,
  open: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useContext: () => state.registry,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: {
    open: state.open,
    write: state.write,
    close: state.close,
    observe: () => state.observed,
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  state.registry = AtomRegistry.make();
  state.observed = Atom.make<AsyncResult.AsyncResult<TerminalBufferState, Error>>(
    AsyncResult.initial(),
  );
  state.open.mockResolvedValue({ _tag: "Success" });
  state.close.mockResolvedValue({ _tag: "Success" });
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  state.registry?.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const target = {
  repository: "acme/app",
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  workspaceRoot: "/tmp/admin-merge-test",
};

describe("admin merge observation failures", () => {
  it("returns a subscription failure immediately and cleans up the terminal", async () => {
    state.write.mockImplementation(async () => {
      state.registry!.set(
        state.observed!,
        AsyncResult.failure(Cause.fail(new Error("Terminal observation denied."))),
      );
      return { _tag: "Success" };
    });
    let result: AdminMergeResult | null = null;
    const pending = usePullRequestAdminMerge(EnvironmentId.make("test"))
      .run(target, "squash")
      .then((value) => {
        result = value;
      });
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ kind: "failed", message: "Terminal observation denied." });
    await pending;
    expect(state.close).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ deleteHistory: true }) }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns when an observed terminal closes without a completion marker", async () => {
    state.write.mockImplementation(async () => {
      state.registry!.set(
        state.observed!,
        AsyncResult.success({ ...EMPTY_TERMINAL_BUFFER_STATE, status: "closed", version: 1 }),
      );
      return { _tag: "Success" };
    });
    let result: AdminMergeResult | null = null;
    const pending = usePullRequestAdminMerge(EnvironmentId.make("test"))
      .run(target, "squash")
      .then((value) => {
        result = value;
      });
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({
      kind: "failed",
      message: "The terminal closed before the merge finished.",
    });
    await pending;
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it("waits past the initial closed seed and accepts completion before closure", async () => {
    state.registry!.set(state.observed!, AsyncResult.success(EMPTY_TERMINAL_BUFFER_STATE));
    state.write.mockImplementation(async () => {
      const completed = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
        type: "output",
        threadId: "test",
        terminalId: "merge-test",
        data: "\r\n__T3_ADMIN_MERGE_EXIT:0\r\n",
      });
      state.registry!.set(
        state.observed!,
        AsyncResult.success(
          applyTerminalAttachStreamEvent(completed, {
            type: "closed",
            threadId: "test",
            terminalId: "merge-test",
          }),
        ),
      );
      return { _tag: "Success" };
    });
    await expect(
      usePullRequestAdminMerge(EnvironmentId.make("test")).run(target, "squash"),
    ).resolves.toEqual({ kind: "merged" });
    expect(state.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
