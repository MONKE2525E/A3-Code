import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  openBot: vi.fn(),
  listQuery: vi.fn(),
  readiness: { kind: "pending" } as { kind: string; instanceId?: string },
  cachedThreadId: null as string | null,
  /** Stands in for the fresh server config; false means it rejects the account. */
  accountValid: true,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("/src/state/server.ts", () => ({
  serverEnvironment: { configValueAtom: () => ({}) },
}));
vi.mock("/src/components/grokBot/grokBotCachedThread.ts", () => ({
  cachedGrokBotNativeInstanceId: (_config: unknown, readiness: { instanceId?: string }) =>
    state.accountValid ? (readiness.instanceId ?? null) : null,
}));
vi.mock("/src/state/grokBots.ts", () => ({
  grokBotsListQuery: (input: unknown) => input,
  grokBotsOpenThread: { permissionAtom: () => ({}) },
}));
vi.mock("/src/state/query.ts", () => ({
  useEnvironmentQuery: (query: unknown) => {
    if (query !== null) state.listQuery(query);
    return query === null
      ? { data: null, error: null }
      : { data: [{ id: "bot-1", name: "Pip", featured: false }], error: null };
  },
}));
vi.mock("/src/components/grokBot/grokBotNativeThread.ts", () => ({
  grokBotNativeInstanceId: (readiness: { kind: string; instanceId?: string }) =>
    readiness.kind === "ready" ? (readiness.instanceId ?? null) : null,
}));
vi.mock("/src/components/grokBot/GrokBotAvatar.tsx", () => ({ GrokBotAvatar: () => null }));
vi.mock("/src/components/grokBot/useGrokBotNative.ts", () => ({
  useGrokBotNativeReadiness: () => state.readiness,
  useCachedGrokBotNativeThread: () => state.cachedThreadId,
  useGrokBotNativeActions: () => ({ openBot: state.openBot }),
}));

import { GrokBotNativeEntry } from "./GrokBotNativeEntry";

const environmentId = EnvironmentId.make("env-1");
function setup() {
  state.navigate.mockReset();
  state.openBot.mockReset().mockResolvedValue(ThreadId.make("opened"));
  state.listQuery.mockReset();
  state.readiness = { kind: "ready", instanceId: "grok-bot" };
  state.cachedThreadId = null;
  state.accountValid = true;
}

const entry = (connected: boolean) => (
  <GrokBotNativeEntry environmentId={environmentId} botId="bot-1" connected={connected} />
);

describe("GrokBotNativeEntry", () => {
  it("redirects a cached thread without a loading screen, roster read, or open request", async () => {
    setup();
    state.cachedThreadId = "cached";
    await using screen = await render(entry(true));
    expect(screen.container.textContent).toBe("");
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(state.navigate.mock.calls[0]![0]).toMatchObject({ replace: true });
    expect(JSON.stringify(state.navigate.mock.calls[0]![0].params)).toContain("cached");
    expect(state.listQuery).not.toHaveBeenCalled();
    expect(state.openBot).not.toHaveBeenCalled();
  });

  it("opens a cached thread from a disconnected environment on the same environment", async () => {
    setup();
    state.readiness = { kind: "pending" };
    state.cachedThreadId = "cached";
    await using screen = await render(entry(false));
    expect(screen.container.textContent).toBe("");
    expect(JSON.stringify(state.navigate.mock.calls[0]![0].params)).toContain("env-1");
    expect(state.openBot).not.toHaveBeenCalled();
  });

  it("asks to reconnect when disconnected and nothing is cached", async () => {
    setup();
    await using screen = await render(entry(false));
    await expect.element(screen.getByText(/Reconnect this environment/)).toBeVisible();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.listQuery).not.toHaveBeenCalled();
    expect(state.openBot).not.toHaveBeenCalled();
  });

  it("still reads the roster and opens the bot when nothing is cached", async () => {
    setup();
    await using _screen = await render(entry(true));
    expect(state.listQuery).toHaveBeenCalled();
    expect(state.openBot).toHaveBeenCalledWith("bot-1");
    expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
  });

  it("does not navigate from an open request whose account the fresh config rejected", async () => {
    setup();
    let resolveOpen!: (threadId: ThreadId) => void;
    state.openBot.mockReset().mockReturnValue(
      new Promise<ThreadId>((resolve) => {
        resolveOpen = resolve;
      }),
    );
    await using screen = await render(entry(true));
    expect(state.openBot).toHaveBeenCalledTimes(1);

    state.accountValid = false;
    state.readiness = { ...state.readiness };
    await screen.rerender(entry(true));
    await act(async () => {
      resolveOpen(ThreadId.make("old-account"));
    });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.openBot).toHaveBeenCalledTimes(1);
  });
});
