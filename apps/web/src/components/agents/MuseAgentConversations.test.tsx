// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  archived: false,
  canWrite: true,
  canOpen: true,
  writePermission: {},
  openPermission: {},
  update: vi.fn(),
  open: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  context: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === mocks.writePermission ? mocks.canWrite : mocks.canOpen,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("~/components/ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => mocks.toast(...args) },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("~/hooks/useThreadActions", () => ({
  useThreadActions: () => ({ archiveThread: vi.fn(), pinThread: vi.fn(), unpinThread: vi.fn() }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: mocks.context } }) }));
vi.mock("~/uiStateStore", () => ({ useUiStateStore: () => undefined }));
vi.mock("~/state/museAgent", () => ({
  museAgentFeatureReadQuery: (query: unknown) => query,
  museAgentFeatureUpdate: { permissionAtom: () => mocks.writePermission },
  museAgentOpenThread: { permissionAtom: () => mocks.openPermission },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: { input: { view: string } }) => ({
    data: {
      operation: "sessions",
      data:
        (query.input.view === "archived") === mocks.archived
          ? [
              {
                sessionId: "side-chat",
                isPrimary: false,
                isThread: true,
                status: "idle",
                archived: mocks.archived,
                title: "Side chat",
              },
            ]
          : [],
    },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { permissionAtom: () => unknown }) =>
    command.permissionAtom() === mocks.writePermission ? mocks.update : mocks.open,
}));
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { MuseAgentConversations } from "./MuseAgentConversations";
const environmentId = EnvironmentId.make("test-env");
const providerInstanceId = ProviderInstanceId.make("muse-test");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  mocks.archived = false;
  mocks.canWrite = true;
  mocks.canOpen = true;
  mocks.update.mockImplementation(async ({ input }: { input: { archived: boolean } }) => {
    mocks.archived = input.archived;
    return { _tag: "Success", value: undefined };
  });
  mocks.open.mockResolvedValue({ _tag: "Success", value: { threadId: "canonical-side-chat" } });
  mocks.context.mockResolvedValue("archive");
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function item(text: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === text,
  )!;
}
it("archives a side chat, restores it from Archived conversations, and opens it again", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async () =>
    act(async () =>
      root.render(
        <Menu defaultOpen>
          <MenuTrigger>Conversations</MenuTrigger>
          <MenuPopup>
            <MuseAgentConversations
              environmentId={environmentId}
              providerInstanceId={providerInstanceId}
              threads={[]}
            />
          </MenuPopup>
        </Menu>,
      ),
    );
  try {
    await render();
    await act(async () =>
      item("Side chat").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(mocks.update).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        operation: "session_archive",
        providerInstanceId,
        sessionId: "side-chat",
        archived: true,
      },
    });
    await render();
    expect(item("Side chat")).toBeUndefined();
    await act(async () => item("Archived conversations").click());
    expect(item("Unarchive Side chat").textContent).toBe("Unarchive Side chat");
    await act(async () => item("Unarchive Side chat").click());
    expect(mocks.update).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        operation: "session_archive",
        providerInstanceId,
        sessionId: "side-chat",
        archived: false,
      },
    });
    await render();
    // Menu selection closes the popup; reopen to see the restored active conversation.
    const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Conversations",
    )!;
    await act(async () => trigger.click());
    expect(item("Side chat").textContent).toBe("Side chat");
    await act(async () => item("Side chat").click());
    expect(mocks.open).toHaveBeenLastCalledWith({
      environmentId,
      input: { providerInstanceId, sessionId: "side-chat" },
    });
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: "canonical-side-chat" },
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it.each([false, true])(
  "disables conversation actions without permission (archived=%s)",
  async (archived) => {
    mocks.archived = archived;
    mocks.canWrite = false;
    mocks.canOpen = false;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <Menu defaultOpen>
            <MenuTrigger>Conversations</MenuTrigger>
            <MenuPopup>
              <MuseAgentConversations
                environmentId={environmentId}
                providerInstanceId={providerInstanceId}
                threads={[]}
              />
            </MenuPopup>
          </Menu>,
        ),
      );
      if (archived) await act(async () => item("Archived conversations").click());
      const label = archived ? "Unarchive Side chat" : "Side chat";
      const restore = item(label);
      expect(restore.getAttribute("aria-disabled")).toBe("true");
      await act(async () => restore.click());
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(restore.textContent).toBe(label);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("keeps a conversation archived when the native restore fails", async () => {
  mocks.archived = true;
  mocks.update.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Restore refused")),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Menu defaultOpen>
          <MenuTrigger>Conversations</MenuTrigger>
          <MenuPopup>
            <MuseAgentConversations
              environmentId={environmentId}
              providerInstanceId={providerInstanceId}
              threads={[]}
            />
          </MenuPopup>
        </Menu>,
      ),
    );
    await act(async () => item("Archived conversations").click());
    await act(async () => item("Unarchive Side chat").click());
    expect(mocks.archived).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not unarchive conversation",
      description: "Error: Restore refused",
    });
    expect(mocks.open).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
