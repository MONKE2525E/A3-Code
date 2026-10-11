import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();
const openBot = vi.fn();
const listQuery = vi.fn();
const state = vi.hoisted(() => ({
  readiness: { kind: "pending" } as { kind: string; instanceId?: string },
  cachedThreadId: null as string | null,
  /** Stands in for the fresh server config; false means it rejects the account. */
  accountValid: true,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => ({}) },
}));
vi.mock("./grokBotCachedThread", () => ({
  cachedGrokBotNativeInstanceId: (_config: unknown, readiness: { instanceId?: string }) =>
    state.accountValid ? (readiness.instanceId ?? null) : null,
}));
vi.mock("../../state/grokBots", () => ({
  grokBotsListQuery: (input: unknown) => input,
  grokBotsOpenThread: { permissionAtom: () => ({}) },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    if (query !== null) listQuery(query);
    return query === null
      ? { data: null, error: null }
      : { data: [{ id: "bot-1", name: "Pip", featured: false }], error: null };
  },
}));
vi.mock("./grokBotNativeThread", () => ({
  grokBotNativeInstanceId: (readiness: { kind: string; instanceId?: string }) =>
    readiness.kind === "ready" ? (readiness.instanceId ?? null) : null,
}));
vi.mock("./GrokBotAvatar", () => ({ GrokBotAvatar: () => null }));
vi.mock("./useGrokBotNative", () => ({
  useGrokBotNativeReadiness: () => state.readiness,
  useCachedGrokBotNativeThread: () => state.cachedThreadId,
  useGrokBotNativeActions: () => ({ openBot }),
}));

import { GrokBotNativeEntry } from "./GrokBotNativeEntry";

const environmentId = EnvironmentId.make("env-1");
let renderer: ReactTestRenderer | null = null;

async function render(connected: boolean) {
  await act(() => {
    renderer = create(
      <GrokBotNativeEntry environmentId={environmentId} botId="bot-1" connected={connected} />,
    );
  });
  return JSON.stringify(renderer!.toJSON());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  navigate.mockReset();
  openBot.mockReset().mockResolvedValue(ThreadId.make("opened"));
  listQuery.mockReset();
  state.readiness = { kind: "ready", instanceId: "grok-bot" };
  state.cachedThreadId = null;
  state.accountValid = true;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("GrokBotNativeEntry", () => {
  it("redirects a cached thread without a loading screen, roster read, or open request", async () => {
    state.cachedThreadId = "cached";
    const output = await render(true);
    expect(output).toBe("null");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]![0]).toMatchObject({ replace: true });
    expect(JSON.stringify(navigate.mock.calls[0]![0].params)).toContain("cached");
    expect(listQuery).not.toHaveBeenCalled();
    expect(openBot).not.toHaveBeenCalled();
  });

  it("opens a cached thread from a disconnected environment on the same environment", async () => {
    state.readiness = { kind: "pending" };
    state.cachedThreadId = "cached";
    expect(await render(false)).toBe("null");
    expect(JSON.stringify(navigate.mock.calls[0]![0].params)).toContain("env-1");
    expect(openBot).not.toHaveBeenCalled();
  });

  it("asks to reconnect when disconnected and nothing is cached", async () => {
    const output = await render(false);
    expect(output).toContain("Reconnect this environment");
    expect(navigate).not.toHaveBeenCalled();
    expect(listQuery).not.toHaveBeenCalled();
    expect(openBot).not.toHaveBeenCalled();
  });

  it("still reads the roster and opens the bot when nothing is cached", async () => {
    await render(true);
    expect(listQuery).toHaveBeenCalled();
    expect(openBot).toHaveBeenCalledWith("bot-1");
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
  });

  it("does not navigate from an open request whose account the fresh config rejected", async () => {
    let resolveOpen!: (threadId: ThreadId) => void;
    openBot.mockReset().mockReturnValue(
      new Promise<ThreadId>((resolve) => {
        resolveOpen = resolve;
      }),
    );
    await render(true);
    expect(openBot).toHaveBeenCalledTimes(1);

    state.accountValid = false;
    await act(() => {
      renderer!.update(
        <GrokBotNativeEntry environmentId={environmentId} botId="bot-1" connected />,
      );
    });
    await act(async () => {
      resolveOpen(ThreadId.make("old-account"));
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(openBot).toHaveBeenCalledTimes(1);
  });
});
