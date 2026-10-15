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
  }>,
  openPermission: {},
  canOpen: true,
  open: vi.fn(),
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
vi.mock("~/hooks/useLocalStorage", () => ({ useLocalStorage: () => [true, vi.fn()] }));
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
    data: {
      installed: true,
      ready: true,
      sessionPresent: true,
      provider: { instanceId: "muse-test" },
      name: "Muse",
    },
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));
vi.mock("./useMuseAgentAvatar", () => ({
  useMuseAgentAvatar: () => ({ imageUrl: null, videoUrl: null }),
}));
vi.mock("./MuseAgentConversations", () => ({ MuseAgentConversations: () => null }));
import { MuseAgentSidebarSection } from "./MuseAgentSidebarSection";

beforeEach(() => {
  mocks.threads.length = 0;
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

it("keeps Activity and Approvals in the Muse flyout instead of the left sidebar", async () => {
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
it.each([false, true])("disables a pinned Muse tile while opening (cached=%s)", async (cached) => {
  if (cached)
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

it.each([false, true])(
  "shows an open error and Retry beside a pinned tile (cached=%s)",
  async (cached) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    if (cached)
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
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Connection unavailable.",
      );
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
  },
);
