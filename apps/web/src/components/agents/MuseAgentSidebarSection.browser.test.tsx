import { act, render as renderScreen } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
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
vi.mock("@effect/atom-react", async () => ({
  ...(await vi.importActual<typeof import("@effect/atom-react")>("@effect/atom-react")),
  useAtomValue: (atom: unknown) =>
    atom === mocks.threads ? mocks.threads : atom === mocks.openPermission ? mocks.canOpen : true,
}));
vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  useNavigate: () => mocks.navigate,
  useLocation: () => "/muse/activity",
  useParams: () => null,
}));
vi.mock("/src/components/ui/sidebar.tsx", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("/src/hooks/useLocalStorage.ts", async () => ({
  ...(await vi.importActual<typeof import("~/hooks/useLocalStorage")>(
    "/src/hooks/useLocalStorage.ts",
  )),
  useLocalStorage: () => [mocks.pinned, vi.fn()],
}));
vi.mock("/src/uiStateStore.ts", () => ({ useUiStateStore: () => ({}) }));
vi.mock("/src/state/threads.ts", () => ({
  environmentThreadShells: { environmentThreadsAtom: () => mocks.threads },
}));
vi.mock("/src/state/museAgent.ts", () => ({
  refreshMuseAgent: vi.fn(),
  museAgentStatusQuery: () => ({}),
  museAgentProfileQuery: () => ({}),
  museAgentSetup: { permissionAtom: () => ({}) },
  museAgentOpenThread: { permissionAtom: () => mocks.openPermission },
}));
vi.mock("/src/state/query.ts", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.status,
    error: null,
  }),
}));
vi.mock("/src/state/use-atom-command.ts", () => ({ useAtomCommand: () => mocks.open }));
vi.mock("/src/components/agents/useMuseAgentAvatar.ts", () => ({
  useMuseAgentAvatar: () => ({ imageUrl: null, videoUrl: null }),
}));
vi.mock("/src/components/agents/MuseAgentConversations.tsx", () => ({
  MuseAgentConversations: () => null,
}));
import { MuseAgentSidebarSection } from "./MuseAgentSidebarSection";
import { clearMuseChatOpen } from "./openCachedMuseThread";

function setup() {
  vi.clearAllMocks();
  mocks.threads.length = 0;
  mocks.pinned = true;
  mocks.canOpen = true;
  mocks.open.mockReset();
  mocks.navigate.mockClear();
  mocks.status.installed = true;
  mocks.status.ready = true;
  mocks.status.sessionPresent = true;
  mocks.status.provider = { instanceId: "muse-test" };
  mocks.status.message = undefined;
  mocks.status.name = "Muse";
  clearMuseChatOpen();
}

it.each(["success", "retry", "forbidden"])(
  "opens pinned side chats with native synchronization: %s",
  async (outcome) => {
    setup();
    await using screen = await renderScreen(<></>);
    const { container } = screen;
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
    await act(async () =>
      screen.rerender(
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
      await vi.waitFor(() => expect(row.disabled).toBe(true));
      expect(mocks.open).not.toHaveBeenCalled();
      return;
    }
    await vi.waitFor(() => expect(row.disabled).toBe(true));
    expect(mocks.open).toHaveBeenCalledWith({
      environmentId: "test-env",
      input: { providerInstanceId: "muse-test", sessionId: "side:one" },
    });
    if (outcome === "retry") {
      await act(async () =>
        finish({ _tag: "Failure", cause: Cause.fail(new Error("Connection unavailable.")) }),
      );
      expect(mocks.navigate).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(
          "Connection unavailable.",
        ),
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
      await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull());
    } else {
      await act(async () => finish({ _tag: "Success", value: { threadId } }));
    }
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "test-env", threadId },
    });
    await vi.waitFor(() => expect(row.disabled).toBe(false));
  },
);

it("keeps Activity, Approvals, Routines, and Subagents in the Muse flyout instead of the left sidebar", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;

  const environmentId = EnvironmentId.make("test-env");
  await act(async () =>
    screen.rerender(
      <MuseAgentSidebarSection environmentId={environmentId} onOpenSettings={vi.fn()} />,
    ),
  );
  for (const [label, section] of [
    ["Activity", "activity"],
    ["Approvals", "approvals"],
    ["Routines", "routines"],
    ["Subagents", "subagents"],
  ]) {
    await vi.waitFor(() =>
      expect([...container.querySelectorAll("button")].some((x) => x.textContent === label)).toBe(
        false,
      ),
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
});

it("disables a pinned Muse tile when opening is forbidden", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  mocks.canOpen = false;
  mocks.open.mockClear();
  await act(async () =>
    screen.rerender(
      <MuseAgentSidebarSection
        environmentId={EnvironmentId.make("test-env")}
        onOpenSettings={vi.fn()}
      />,
    ),
  );
  const tile = [...container.querySelectorAll("button")].find(
    (button) => button.querySelector("span.truncate")?.textContent === "Muse",
  )!;
  await vi.waitFor(() => expect(tile.disabled).toBe(true));
  await act(async () => tile.click());
  expect(mocks.open).not.toHaveBeenCalled();
});
it("disables a pinned Muse tile while a cached chat is opening", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  mocks.threads.push({
    id: `muse-agent:${"a".repeat(64)}`,
    providerInstanceId: "muse-test",
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    status: "idle",
    latestTurn: null,
    lastVisitedAt: null,
  });
  let finish: (value: unknown) => void = () => {
    throw new Error("uninitialized");
  };
  mocks.open.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () =>
    screen.rerender(
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
  await vi.waitFor(() => expect(tile.disabled).toBe(true));
  await vi.waitFor(() => expect(tile.getAttribute("aria-busy")).toBe("true"));
  await act(async () => finish({ _tag: "Success", value: { threadId: "native-main" } }));
  await vi.waitFor(() => expect(tile.disabled).toBe(false));
});

it("navigates into chat immediately on first uncached open", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  mocks.open.mockClear();
  const environmentId = EnvironmentId.make("test-env");
  await act(async () =>
    screen.rerender(
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
  await vi.waitFor(() => expect(container.textContent).not.toContain("Opening…"));
});

it("shows an open error and Retry beside a pinned tile for a cached chat", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
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
  await act(async () =>
    screen.rerender(
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
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection unavailable."),
  );
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull());
  expect(mocks.open).toHaveBeenCalledTimes(2);
});

it("reconnects a not-ready Muse without also claiming it is connected", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  mocks.status.ready = false;
  mocks.status.message = "Muse is connected.";
  await act(async () =>
    screen.rerender(
      <MuseAgentSidebarSection
        environmentId={EnvironmentId.make("test-env")}
        onOpenSettings={vi.fn()}
      />,
    ),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "Muse needs to reconnect before you can chat with it here.",
    ),
  );
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Reconnect Muse",
      ),
    ).toBe(true),
  );
  await vi.waitFor(() => expect(container.textContent).not.toContain("Muse is connected."));
});

it("still shows a real reconnect reason from Muse status", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  mocks.status.ready = false;
  mocks.status.message = "Session expired";
  await act(async () =>
    screen.rerender(
      <MuseAgentSidebarSection
        environmentId={EnvironmentId.make("test-env")}
        onOpenSettings={vi.fn()}
      />,
    ),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "Muse needs to reconnect before you can chat with it here.",
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Session expired"));
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Reconnect Muse",
      ),
    ).toBe(true),
  );
});
