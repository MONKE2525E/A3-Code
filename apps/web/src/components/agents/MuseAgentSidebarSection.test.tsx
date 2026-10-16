// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  threads: [] as Array<{
    id: string;
    providerInstanceId: string;
    archivedAt: null;
    updatedAt: string;
    status: string;
    latestTurn: null;
    lastVisitedAt: null;
    title?: string;
    pinnedAt?: string;
  }>,
  pinned: true,
  openPermission: {},
  canOpen: true,
  open: vi.fn(),
  status: {
    installed: true,
    ready: true,
    sessionPresent: true,
    provider: { instanceId: "muse-test" } as { instanceId: string } | null,
    message: undefined as string | undefined,
    name: "Muse",
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === mocks.threads ? mocks.threads : atom === mocks.openPermission ? mocks.canOpen : true,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => "/muse/activity",
  useParams: () => null,
}));
vi.mock("~/components/ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("~/hooks/useLocalStorage", () => ({ useLocalStorage: () => [mocks.pinned, vi.fn()] }));
vi.mock("~/uiStateStore", () => ({ useUiStateStore: () => ({}) }));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { environmentThreadsAtom: () => mocks.threads },
}));
vi.mock("~/state/museAgent", () => ({
  museAgentStatusQuery: () => ({}),
  museAgentProfileQuery: () => ({}),
  museAgentSetup: { permissionAtom: () => ({}) },
  museAgentOpenThread: { permissionAtom: () => mocks.openPermission },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.status,
    error: null,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));
vi.mock("./useMuseAgentAvatar", () => ({
  useMuseAgentAvatar: () => ({ imageUrl: null, videoUrl: null }),
}));
vi.mock("./MuseAgentConversations", () => ({ MuseAgentConversations: () => null }));
import { MuseAgentSidebarSection } from "./MuseAgentSidebarSection";
import { clearMuseChatOpen } from "./openCachedMuseThread";

beforeEach(() => {
  mocks.threads.length = 0;
  mocks.pinned = true;
  mocks.navigate.mockClear();
  mocks.status.installed = true;
  mocks.status.ready = true;
  mocks.status.sessionPresent = true;
  mocks.status.provider = { instanceId: "muse-test" };
  mocks.status.message = undefined;
  mocks.status.name = "Muse";
  clearMuseChatOpen();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

it.each(["success", "retry", "forbidden"])(
  "opens pinned side chats with native synchronization: %s",
  async (outcome) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.pinned = false;
    mocks.canOpen = outcome !== "forbidden";
    const threadId = `muse-agent:${"a".repeat(64)}:${encodeURIComponent("side:one")}`;
    mocks.threads.push({
      id: threadId,
      title: "Pinned side chat",
      pinnedAt: "2026-01-01T00:00:00Z",
      providerInstanceId: "muse-test",
      archivedAt: null,
      updatedAt: "2026-01-01T00:00:00Z",
      status: "idle",
      latestTurn: null,
      lastVisitedAt: null,
    });
    let finish: (value: unknown) => void = () => {
      throw new Error("not started");
    };
    mocks.open.mockReset().mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MuseAgentSidebarSection
            environmentId={EnvironmentId.make("test-env")}
            onOpenSettings={vi.fn()}
          />,
        ),
      );
      const row = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Pinned side chat",
      )!;
      await act(async () => row.click());
      expect(mocks.navigate).not.toHaveBeenCalled();
      if (outcome === "forbidden") {
        expect(row.disabled).toBe(true);
        expect(mocks.open).not.toHaveBeenCalled();
        return;
      }
      expect(row.disabled).toBe(true);
      expect(mocks.open).toHaveBeenCalledWith({
        environmentId: "test-env",
        input: { providerInstanceId: "muse-test", sessionId: "side:one" },
      });
      if (outcome === "retry") {
        await act(async () =>
          finish({ _tag: "Failure", cause: Cause.fail(new Error("Connection unavailable.")) }),
        );
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(
          "Connection unavailable.",
        );
        mocks.open.mockResolvedValue({ _tag: "Success", value: { threadId } });
        const retry = [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Retry",
        )!;
        await act(async () => retry.click());
        expect(mocks.open).toHaveBeenLastCalledWith({
          environmentId: "test-env",
          input: { providerInstanceId: "muse-test", sessionId: "side:one" },
        });
        expect(container.querySelector('[role="alert"]')).toBeNull();
      } else {
        await act(async () => finish({ _tag: "Success", value: { threadId } }));
      }
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "test-env", threadId },
      });
      expect(row.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      mocks.canOpen = true;
      vi.unstubAllGlobals();
    }
  },
);

it("keeps Activity, Approvals, Routines, and Subagents in the Muse flyout instead of the left sidebar", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const environmentId = EnvironmentId.make("test-env");
  try {
    await act(async () =>
      root.render(
        <MuseAgentSidebarSection environmentId={environmentId} onOpenSettings={vi.fn()} />,
      ),
    );
    for (const [label, section] of [
      ["Activity", "activity"],
      ["Approvals", "approvals"],
      ["Routines", "routines"],
      ["Subagents", "subagents"],
    ]) {
      expect([...container.querySelectorAll("button")].some((x) => x.textContent === label)).toBe(
        false,
      );
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Muse"]')!;
      await act(async () => trigger.click());
      const button = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (x) => x.textContent === label,
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(mocks.navigate).toHaveBeenLastCalledWith({
        to: "/muse/$section",
        params: { section },
        search: { environmentId },
      });
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("disables a pinned Muse tile when opening is forbidden", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.canOpen = false;
  mocks.open.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentSidebarSection
          environmentId={EnvironmentId.make("test-env")}
          onOpenSettings={vi.fn()}
        />,
      ),
    );
    const tile = [...container.querySelectorAll("button")].find(
      (button) => button.querySelector("span.truncate")?.textContent === "Muse",
    )!;
    expect(tile.disabled).toBe(true);
    await act(async () => tile.click());
    expect(mocks.open).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    mocks.canOpen = true;
    vi.unstubAllGlobals();
  }
});
it("disables a pinned Muse tile while a cached chat is opening", async () => {
  mocks.threads.push({
    id: `muse-agent:${"a".repeat(64)}`,
    providerInstanceId: "muse-test",
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    status: "idle",
    latestTurn: null,
    lastVisitedAt: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish: (value: unknown) => void = () => {
    throw new Error("uninitialized");
  };
  mocks.open.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentSidebarSection
          environmentId={EnvironmentId.make("test-env")}
          onOpenSettings={vi.fn()}
        />,
      ),
    );
    const tile = [...container.querySelectorAll("button")].find(
      (button) => button.querySelector("span.truncate")?.textContent === "Muse",
    )!;
    await act(async () => tile.click());
    expect(tile.disabled).toBe(true);
    expect(tile.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish({ _tag: "Success", value: { threadId: "native-main" } }));
    expect(tile.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("navigates into chat immediately on first uncached open", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.open.mockClear();
  const environmentId = EnvironmentId.make("test-env");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentSidebarSection environmentId={environmentId} onOpenSettings={vi.fn()} />,
      ),
    );
    const tile = [...container.querySelectorAll("button")].find(
      (button) => button.querySelector("span.truncate")?.textContent === "Muse",
    )!;
    await act(async () => tile.click());
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/muse/$section",
      params: { section: "chat" },
      search: { environmentId },
    });
    expect(container.textContent).not.toContain("Opening…");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows an open error and Retry beside a pinned tile for a cached chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.threads.push({
    id: `muse-agent:${"a".repeat(64)}`,
    providerInstanceId: "muse-test",
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    status: "idle",
    latestTurn: null,
    lastVisitedAt: null,
  });
  mocks.open.mockReset();
  mocks.open
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Connection unavailable.")),
    })
    .mockResolvedValueOnce({ _tag: "Success", value: { threadId: "native-main" } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentSidebarSection
          environmentId={EnvironmentId.make("test-env")}
          onOpenSettings={vi.fn()}
        />,
      ),
    );
    const tile = [...container.querySelectorAll("button")].find(
      (button) => button.querySelector("span.truncate")?.textContent === "Muse",
    )!;
    await act(async () => tile.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection unavailable.");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.open).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("reconnects a not-ready Muse without also claiming it is connected", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.status.ready = false;
  mocks.status.message = "Muse is connected.";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentSidebarSection
          environmentId={EnvironmentId.make("test-env")}
          onOpenSettings={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain(
      "Muse needs to reconnect before you can chat with it here.",
    );
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Reconnect Muse",
      ),
    ).toBe(true);
    expect(container.textContent).not.toContain("Muse is connected.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("still shows a real reconnect reason from Muse status", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.status.ready = false;
  mocks.status.message = "Session expired";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentSidebarSection
          environmentId={EnvironmentId.make("test-env")}
          onOpenSettings={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain(
      "Muse needs to reconnect before you can chat with it here.",
    );
    expect(container.textContent).toContain("Session expired");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Reconnect Muse",
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
