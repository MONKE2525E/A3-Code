import { act, render as renderScreen } from "../../../test/render";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
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
  archive: vi.fn(),
}));
vi.mock("@effect/atom-react", async () => ({
  ...(await vi.importActual<typeof import("@effect/atom-react")>("@effect/atom-react")),
  useAtomValue: (atom: unknown) =>
    atom === mocks.writePermission ? mocks.canWrite : mocks.canOpen,
}));
vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  useNavigate: () => mocks.navigate,
}));
vi.mock("/src/components/ui/sidebar.tsx", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("/src/components/ui/toast.tsx", () => ({
  toastManager: { add: (...args: unknown[]) => mocks.toast(...args) },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("/src/hooks/useThreadActions.ts", () => ({
  useThreadActions: () => ({
    archiveThread: mocks.archive,
    pinThread: vi.fn(),
    unpinThread: vi.fn(),
  }),
}));
vi.mock("/src/localApi.ts", () => ({
  readLocalApi: () => ({ contextMenu: { show: mocks.context } }),
}));
vi.mock("/src/uiStateStore.ts", () => ({ useUiStateStore: () => undefined }));
vi.mock("/src/state/museAgent.ts", () => ({
  museAgentFeatureReadQuery: (query: unknown) => query,
  museAgentFeatureUpdate: { permissionAtom: () => mocks.writePermission },
  museAgentOpenThread: { permissionAtom: () => mocks.openPermission },
}));
vi.mock("/src/state/query.ts", () => ({
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
vi.mock("/src/state/use-atom-command.ts", () => ({
  useAtomCommand: (command: { permissionAtom: () => unknown }) =>
    command.permissionAtom() === mocks.writePermission ? mocks.update : mocks.open,
}));
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { makeThreadProjectionFixture } from "~/test-fixtures";
import { MuseAgentConversations } from "./MuseAgentConversations";
const environmentId = EnvironmentId.make("test-env");
const providerInstanceId = ProviderInstanceId.make("muse-test");
function setup() {
  vi.clearAllMocks();
  mocks.archived = false;
  mocks.canWrite = true;
  mocks.canOpen = true;
  mocks.update.mockReset();
  mocks.update.mockImplementation(async ({ input }: { input: { archived: boolean } }) => {
    mocks.archived = input.archived;
    return { _tag: "Success", value: undefined };
  });
  mocks.open.mockResolvedValue({ _tag: "Success", value: { threadId: "canonical-side-chat" } });
  mocks.context.mockResolvedValue("archive");
}
function item(text: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === text,
  )!;
}
it("archives a side chat, restores it from Archived conversations, and opens it again", async () => {
  setup();
  await using screen = await renderScreen(<></>);

  const render = async () =>
    act(async () =>
      screen.rerender(
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
  await vi.waitFor(() => expect(item("Side chat")).toBeUndefined());
  await act(async () => item("Archived conversations").click());
  await vi.waitFor(() =>
    expect(item("Unarchive Side chat").textContent).toBe("Unarchive Side chat"),
  );
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
  await vi.waitFor(() => expect(item("Side chat").textContent).toBe("Side chat"));
  await act(async () => item("Side chat").click());
  expect(mocks.open).toHaveBeenLastCalledWith({
    environmentId,
    input: { providerInstanceId, sessionId: "side-chat" },
  });
  expect(mocks.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "canonical-side-chat" },
  });
});
it.each([false, true])(
  "disables conversation actions without permission (archived=%s)",
  async (archived) => {
    setup();
    await using screen = await renderScreen(<></>);
    mocks.archived = archived;
    mocks.canWrite = false;
    mocks.canOpen = false;
    await act(async () =>
      screen.rerender(
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
    await vi.waitFor(() => expect(restore.getAttribute("aria-disabled")).toBe("true"));
    await act(async () => restore.click());
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(restore.textContent).toBe(label));
  },
);

it("keeps a conversation archived when the native restore fails", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  mocks.archived = true;
  mocks.update.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Restore refused")),
  });
  await act(async () =>
    screen.rerender(
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
});

it.each([true, false])(
  "reports a paired server archive failure without a second client mutation (recovery=%s)",
  async (recovered) => {
    setup();
    await using screen = await renderScreen(<></>);
    const message = recovered
      ? "Muse restored the previous archive state."
      : "Muse could not restore the previous archive state.";
    mocks.update.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error(message)) });
    const base = makeThreadProjectionFixture().thread;
    const id = ThreadId.make(`muse-agent:${"a".repeat(64)}:side-chat`);
    const shell: OrchestrationV2ThreadShell = {
      ...base,
      id,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "muse" },
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
    };
    await act(async () =>
      screen.rerender(
        <Menu defaultOpen>
          <MenuTrigger>Conversations</MenuTrigger>
          <MenuPopup>
            <MuseAgentConversations
              environmentId={environmentId}
              providerInstanceId={providerInstanceId}
              threads={[shell]}
            />
          </MenuPopup>
        </Menu>,
      ),
    );
    await act(async () =>
      item("Side chat").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        operation: "session_archive",
        providerInstanceId,
        sessionId: "side-chat",
        archived: true,
      },
    });
    expect(mocks.toast).toHaveBeenLastCalledWith({
      type: "error",
      title: "Could not archive conversation",
      description: "Error: " + message,
    });
  },
);

it("reports partial rename success and lets the same native title be retried", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  mocks.context.mockResolvedValue("rename");
  mocks.update.mockResolvedValue({
    _tag: "Success",
    value: { updated: true, title: "Side chat", titleSyncPending: true },
  });
  await act(async () =>
    screen.rerender(
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
  for (let attempt = 0; attempt < 2; attempt++) {
    await act(async () =>
      item("Side chat").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    const form = document.querySelector('input[aria-label="Conversation title"]')!.closest("form")!;
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(mocks.update).toHaveBeenCalledTimes(attempt + 1);
    expect(mocks.update).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        operation: "session_rename",
        providerInstanceId,
        sessionId: "side-chat",
        title: "Side chat",
      },
    });
    expect(mocks.toast).toHaveBeenLastCalledWith({
      type: "warning",
      title: "Conversation renamed in Muse",
      description:
        "T3 could not sync its title. Reconnect Muse if needed, then rename again to retry.",
    });
  }
});
