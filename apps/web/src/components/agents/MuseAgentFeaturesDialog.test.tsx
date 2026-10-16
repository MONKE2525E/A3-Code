// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { useRightPanelStore, selectThreadRightPanelState } from "~/rightPanelStore";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  connected: "muse-current",
  settings: true,
  operate: true,
  blockNavigation: (() => false) as () => boolean | Promise<boolean>,
  read: vi.fn(),
  refresh: vi.fn(),
  update: vi.fn(),
  navigate: vi.fn(),
  threads: [] as Array<{ id: string; providerInstanceId: string }>,
  skills: [] as Array<{
    name: string;
    description: string;
    category: string;
    title?: string;
    enabled?: boolean;
    disabled?: boolean;
    userDisabled?: boolean;
    eligible?: boolean;
  }>,
  tasks: [] as Array<{ id: string; title?: string; scheduleKey: string }>,
  sessions: [] as Array<{
    sessionId: string;
    status: string;
    isPrimary: boolean;
    isThread: boolean;
    title?: string;
    snippet?: string;
  }>,
  profile: {
    data: { name: "Muse" } as { name: string } | null,
    error: null as string | null,
    isPending: false,
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "settings" ? mocks.settings : atom === "threads" ? mocks.threads : mocks.operate,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useBlocker: (options: {
    shouldBlockFn: (route: {
      current: { pathname: string };
      next: { pathname: string };
    }) => boolean | Promise<boolean>;
  }) => {
    mocks.blockNavigation = () =>
      options.shouldBlockFn({
        current: { pathname: "/thread-a" },
        next: { pathname: "/thread-b" },
      });
  },
}));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { environmentThreadsAtom: () => "threads" },
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/museAgent", () => ({
  museAgentFeatureReadQuery: (query: unknown) => {
    mocks.read(query);
    return query;
  },
  museAgentStatusQuery: () => "status",
  museAgentProfileQuery: () => "profile",
  museAgentFeatureUpdate: {
    permissionAtom: (_environment: unknown, input?: { operation: string }) =>
      input?.operation === "profile_save" || input?.operation === "connector_auth"
        ? "settings"
        : "operate",
  },
  museAgentOpenThread: { permissionAtom: () => true },
  refreshMuseAgent: vi.fn(),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    if (query === "profile") {
      return {
        data: mocks.profile.data,
        error: mocks.profile.error,
        isPending: mocks.profile.isPending,
        refresh: mocks.refresh,
      };
    }
    let data: unknown = null;
    if (query === "status") data = { ready: true, provider: { instanceId: mocks.connected } };
    else if (query && typeof query === "object" && "input" in query) {
      const input = query.input as { operation: string };
      data =
        input.operation === "inventory"
          ? {
              operation: "inventory",
              data: {
                features: [{ feature: "profile", operations: ["read_document", "save_document"] }],
              },
            }
          : input.operation === "profile_document"
            ? { operation: "profile_document", data: { content: "Original", revision: "r1" } }
            : input.operation === "skills"
              ? { operation: "skills", data: mocks.skills }
              : input.operation === "tasks"
                ? { operation: "tasks", data: mocks.tasks }
                : input.operation === "sessions"
                  ? { operation: "sessions", data: mocks.sessions }
                  : null;
    }
    return { data, error: null, isPending: false, refresh: mocks.refresh };
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("./useMuseAgentAvatar", () => ({
  useMuseAgentAvatar: () => ({ imageUrl: null, videoUrl: null }),
}));
vi.mock("./MuseAgentComputerSection", () => ({ MuseAgentComputerSection: () => null }));
vi.mock("./MuseAgentConnectionsSection", () => ({ MuseAgentConnectionsSection: () => null }));
vi.mock("./MuseAgentDeliveryRecovery", () => ({ MuseAgentDeliveryRecovery: () => null }));
vi.mock("~/components/chat/ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: ({ threadId }: { threadId: string }) => (
    <div>T3 child tasks for {threadId}</div>
  ),
}));
vi.mock("~/components/chat/ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: ({ threadId }: { threadId: string }) => (
    <div>T3 scheduled tasks for {threadId}</div>
  ),
}));

import {
  MuseAgentChatEntry,
  MuseAgentFeaturesButton,
  MuseAgentFeaturesPanel,
  MuseAgentHeaderFeatures,
  MuseAgentSectionPage,
  MuseAgentSkillsSection,
} from "./MuseAgentFeaturesDialog";
import { clearMuseChatOpen, queueMuseChatOpen } from "./openCachedMuseThread";
const environmentId = EnvironmentId.make("test-env");
const providerInstanceId = ProviderInstanceId.make("muse-current");
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mocks.connected = "muse-current";
  mocks.settings = true;
  mocks.operate = true;
  mocks.read.mockClear();
  mocks.refresh.mockClear();
  mocks.update.mockReset();
  mocks.navigate.mockReset();
  mocks.skills = [];
  mocks.tasks = [];
  mocks.sessions = [];
  mocks.threads = [];
  mocks.profile = { data: { name: "Muse" }, error: null, isPending: false };
  clearMuseChatOpen();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (x) => x.textContent === label || x.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

it.each(["Escape", "Close"])(
  "keeps an unsaved profile draft when sheet dismissal uses %s",
  async (dismiss) => {
    await act(async () =>
      root.render(
        <MuseAgentFeaturesButton
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
        />,
      ),
    );
    await click(" Muse features");
    const editor = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Muse Identity"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        editor,
        "Unsaved draft",
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (dismiss === "Escape")
      await act(async () =>
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
    else await click("Close");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Discard unsaved changes?",
    );
    await click("Keep editing");
    expect(editor.isConnected).toBe(true);
    expect(editor.value).toBe("Unsaved draft");
    await click("Close");
    await click("Discard changes");
    expect(editor.isConnected).toBe(false);
  },
);

it("does not mount feature reads or the header toggle for another provider's historical thread", async () => {
  const old = ProviderInstanceId.make("muse-old");
  await act(async () =>
    root.render(
      <>
        <MuseAgentFeaturesPanel
          environmentId={environmentId}
          providerInstanceId={old}
          threadId="old-thread"
          onClose={vi.fn()}
        />
        <MuseAgentHeaderFeatures
          environmentId={environmentId}
          providerInstanceId={old}
          pressed={false}
          onToggle={vi.fn()}
        />
      </>,
    ),
  );
  expect(container.textContent).toBe("");
  expect(container.querySelector('button[aria-label="Muse features"]')).toBeNull();
  expect(mocks.read).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <MuseAgentFeaturesPanel
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        threadId="current-thread"
        onClose={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector('textarea[aria-label="Muse Identity"]')).not.toBeNull();
  expect(mocks.read).toHaveBeenCalledWith({
    environmentId,
    input: { operation: "profile_document", providerInstanceId, document: "identity" },
  });
  mocks.connected = "muse-next";
  mocks.read.mockClear();
  await act(async () =>
    root.render(
      <MuseAgentFeaturesPanel
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        threadId="current-thread"
        onClose={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toBe("");
  expect(mocks.read).not.toHaveBeenCalled();
});

it("keeps the profile read-only without settings permission while conversation operation remains granted", async () => {
  mocks.settings = false;
  await act(async () =>
    root.render(
      <MuseAgentFeaturesPanel
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        threadId="current-thread"
        onClose={vi.fn()}
      />,
    ),
  );
  const editor = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Muse Identity"]',
  )!;
  expect(editor.value).toBe("Original");
  expect(editor.readOnly).toBe(true);
  expect(button("Save").disabled).toBe(true);
  mocks.settings = true;
  mocks.operate = false;
  await act(async () =>
    root.render(
      <MuseAgentFeaturesPanel
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        threadId="current-thread"
        onClose={vi.fn()}
      />,
    ),
  );
  expect(editor.readOnly).toBe(false);
});

const panelRef = scopeThreadRef(environmentId, ThreadId.make("guarded-thread"));
function PanelHost() {
  const state = useRightPanelStore((store) =>
    selectThreadRightPanelState(store.byThreadKey, panelRef),
  );
  return state.isOpen && state.activeSurfaceId === "muse-features" ? (
    <MuseAgentFeaturesPanel
      environmentId={environmentId}
      providerInstanceId={providerInstanceId}
      threadId={panelRef.threadId}
      onClose={() => useRightPanelStore.getState().close(panelRef)}
    />
  ) : (
    <div>Other surface</div>
  );
}
async function openDirtyPanel() {
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.getState().open(panelRef, "muse-features");
  await act(async () => root.render(<PanelHost />));
  const editor = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Muse Identity"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      editor,
      "Panel draft",
    );
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return editor;
}
it.each(["switch", "close-tab", "header-toggle", "hide"])(
  "guards an unsaved right-panel draft on %s",
  async (action) => {
    const editor = await openDirtyPanel();
    const leave = () => {
      const store = useRightPanelStore.getState();
      if (action === "switch") store.open(panelRef, "files");
      else if (action === "close-tab") store.closeSurface(panelRef, "muse-features");
      else if (action === "header-toggle") store.toggle(panelRef, "muse-features");
      else store.close(panelRef);
    };
    await act(async () => leave());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Discard unsaved changes?",
    );
    await click("Keep editing");
    expect(editor.isConnected).toBe(true);
    expect(editor.value).toBe("Panel draft");
    await act(async () => leave());
    await click("Discard changes");
    expect(editor.isConnected).toBe(false);
    expect(container.textContent).toBe("Other surface");
  },
);
it("blocks thread navigation until a dirty right-panel draft is discarded", async () => {
  const editor = await openDirtyPanel();
  let first!: boolean | Promise<boolean>;
  await act(async () => {
    first = mocks.blockNavigation();
  });
  await click("Keep editing");
  expect(await first).toBe(true);
  expect(editor.value).toBe("Panel draft");
  let second!: boolean | Promise<boolean>;
  await act(async () => {
    second = mocks.blockNavigation();
  });
  await click("Discard changes");
  expect(await second).toBe(false);
});

it("opens Computer from the ability list instead of a settings gear", async () => {
  await act(async () =>
    root.render(
      <MuseAgentFeaturesButton
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
      />,
    ),
  );
  await click(" Muse features");
  expect(container.querySelector('button[aria-label="Muse\'s computer"]')).toBeNull();
  expect(container.textContent).not.toContain("Dictation");
  expect(container.textContent).not.toContain("Search what Muse remembers");
  await click("ComputerMuse's computer");
  expect(
    [...document.querySelectorAll("button")].some((item) => item.textContent?.includes("Profile")),
  ).toBe(true);
});

it("browses skills as a searchable card grid and hides unknown status badges", async () => {
  mocks.skills = [
    { name: "alpha", title: "Alpha", description: "one", category: "uncategorized" },
    { name: "beta", title: "Beta", description: "two", category: "uncategorized" },
    { name: "gamma", title: "Gamma", description: "three", category: "uncategorized" },
    { name: "delta", title: "Delta", description: "four", category: "uncategorized" },
    { name: "echo", title: "Echo", description: "five", category: "uncategorized", enabled: true },
  ];
  await act(async () =>
    root.render(
      <MuseAgentSkillsSection
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
      />,
    ),
  );
  expect(container.textContent).toContain("Other");
  expect(container.textContent).not.toContain("Uncategorized");
  expect(container.textContent).toContain("Alpha");
  expect(container.textContent).toContain("Echo");
  expect(container.textContent).not.toContain("Gamma");
  expect(container.textContent).not.toContain("Status unknown");
  await click("View all");
  expect(container.textContent).toContain("Gamma");
  expect(container.textContent).toContain("Available");
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "echo");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("Echo");
  expect(container.textContent).not.toContain("Alpha");
});

it("keeps search and refresh when Muse reports no skills", async () => {
  mocks.skills = [];
  await act(async () =>
    root.render(
      <MuseAgentSkillsSection
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
      />,
    ),
  );
  expect(container.textContent).toContain("Muse reports no skills.");
  expect(container.querySelector('input[aria-label="Search skills"]')).not.toBeNull();
  await click("Refresh");
  expect(mocks.refresh).toHaveBeenCalled();
});

it("keeps All selected after a dropped category returns", async () => {
  mocks.skills = [
    { name: "a", title: "Alpha tool", description: "one", category: "Alpha" },
    { name: "z", title: "Zed tool", description: "two", category: "Zed" },
    { name: "b", title: "Beta tool", description: "three", category: "Beta" },
  ];
  const renderSkills = async () =>
    act(async () =>
      root.render(
        <MuseAgentSkillsSection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
        />,
      ),
    );
  await renderSkills();
  await click("Alpha");
  expect(container.textContent).toContain("Alpha tool");
  expect(container.textContent).not.toContain("Zed tool");
  mocks.skills = [
    { name: "z", title: "Zed tool", description: "two", category: "Zed" },
    { name: "b", title: "Beta tool", description: "three", category: "Beta" },
  ];
  await renderSkills();
  expect(container.textContent).toContain("Zed tool");
  expect(container.textContent).toContain("Beta tool");
  expect(container.textContent).not.toContain("Nothing matches.");
  expect(button("All").getAttribute("aria-pressed")).toBe("true");
  mocks.skills = [
    { name: "a", title: "Alpha tool", description: "one", category: "Alpha" },
    { name: "z", title: "Zed tool", description: "two", category: "Zed" },
    { name: "b", title: "Beta tool", description: "three", category: "Beta" },
  ];
  await renderSkills();
  expect(button("All").getAttribute("aria-pressed")).toBe("true");
  expect(button("Alpha").getAttribute("aria-pressed")).toBe("false");
  expect(container.textContent).toContain("Alpha tool");
  expect(container.textContent).toContain("Zed tool");
  expect(container.textContent).toContain("Beta tool");
});

it("does not label a skill Turned off from enabled false alone", async () => {
  mocks.skills = [
    { name: "keep", title: "Keep", description: "native keep", category: "Other", enabled: false },
    { name: "off", title: "Off", description: "explicit", category: "Other", disabled: true },
    {
      name: "user",
      title: "User off",
      description: "user",
      category: "Other",
      userDisabled: true,
    },
    { name: "nope", title: "Nope", description: "ineligible", category: "Other", eligible: false },
  ];
  await act(async () =>
    root.render(
      <MuseAgentSkillsSection
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
      />,
    ),
  );
  const keep = [...container.querySelectorAll("li")].find((row) =>
    row.textContent?.includes("Keep"),
  );
  const off = [...container.querySelectorAll("li")].find((row) => row.textContent?.includes("Off"));
  const userOff = [...container.querySelectorAll("li")].find((row) =>
    row.textContent?.includes("User off"),
  );
  const nope = [...container.querySelectorAll("li")].find((row) =>
    row.textContent?.includes("Nope"),
  );
  expect(keep?.textContent).not.toContain("Turned off");
  expect(off?.textContent).toContain("Turned off");
  expect(userOff?.textContent).toContain("Turned off");
  expect(nope?.textContent).toContain("Not eligible");
});

it("lists native Muse routines from the tasks read and keeps T3 scheduled tasks separate", async () => {
  const threadId = `muse-agent:${"a".repeat(64)}`;
  mocks.threads = [{ id: threadId, providerInstanceId: "muse-current" }];
  mocks.tasks = [{ id: "r1", title: "Morning digest", scheduleKey: "daily 09:00" }];
  await act(async () =>
    root.render(
      <MuseAgentSectionPage
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        section="routines"
      />,
    ),
  );
  expect(container.textContent).toContain("Morning digest");
  expect(container.textContent).toContain("Routines Muse runs itself");
  expect(container.textContent).toContain(`T3 scheduled tasks for ${threadId}`);
});

it("shows an honest empty state when Muse has no routines", async () => {
  await act(async () =>
    root.render(
      <MuseAgentSectionPage
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        section="routines"
      />,
    ),
  );
  expect(container.textContent).toContain("Ask Muse in chat to create a routine");
  expect(container.textContent).not.toContain("T3 scheduled tasks for");
});

it("shows T3 child tasks and an honest native subagent gap", async () => {
  const threadId = `muse-agent:${"b".repeat(64)}`;
  mocks.threads = [{ id: threadId, providerInstanceId: "muse-current" }];
  mocks.sessions = [
    {
      sessionId: "main",
      status: "idle",
      isPrimary: true,
      isThread: true,
      title: "Main conversation",
    },
    {
      sessionId: "side",
      status: "idle",
      isPrimary: false,
      isThread: true,
      title: "Research bot",
      snippet: "Looking up",
    },
  ];
  await act(async () =>
    root.render(
      <MuseAgentSectionPage
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        section="subagents"
      />,
    ),
  );
  expect(container.textContent).toContain("Muse's own subagent roster is not available in T3 yet");
  expect(container.textContent).toContain(`T3 child tasks for ${threadId}`);
  expect(container.textContent).not.toContain("Research bot");
  expect(container.textContent).not.toContain("Main conversation");
});

it("does not list native side chats as subagents when no Muse chat is open", async () => {
  mocks.sessions = [
    {
      sessionId: "side",
      status: "idle",
      isPrimary: false,
      isThread: true,
      title: "Research bot",
    },
  ];
  await act(async () =>
    root.render(
      <MuseAgentSectionPage
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        section="subagents"
      />,
    ),
  );
  expect(container.textContent).toContain("Open Muse chat to see T3 child tasks");
  expect(container.textContent).not.toContain("Research bot");
});

it("claims Connected only after the Muse profile loads", async () => {
  const renderPanel = async () =>
    act(async () =>
      root.render(
        <MuseAgentFeaturesPanel
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId="current-thread"
          onClose={vi.fn()}
        />,
      ),
    );
  await renderPanel();
  expect(container.textContent).toContain("Connected");
  mocks.profile = { data: null, error: "timeout", isPending: false };
  await renderPanel();
  expect(container.textContent).toContain("Couldn't load this Muse account.");
  expect(container.textContent).not.toContain("Connected");
  mocks.profile = { data: null, error: null, isPending: true };
  await renderPanel();
  expect(container.textContent).toContain("Loading Muse…");
  expect(container.textContent).not.toContain("Connected");
  mocks.profile = { data: null, error: null, isPending: false };
  await renderPanel();
  expect(container.textContent).not.toContain("Connected");
  expect(container.textContent).not.toContain("Couldn't load this Muse account.");
});

it("opens Muse from the chat entry and replace-navigates to the thread", async () => {
  const threadId = `muse-agent:${"a".repeat(64)}`;
  mocks.update.mockResolvedValue({ _tag: "Success", value: { threadId } });
  await act(async () =>
    root.render(
      <MuseAgentChatEntry environmentId={environmentId} providerInstanceId={providerInstanceId} />,
    ),
  );
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId,
    input: { providerInstanceId },
  });
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
    replace: true,
  });
});

it("still replace-navigates once when thread shells update while Muse is opening", async () => {
  const threadId = `muse-agent:${"b".repeat(64)}`;
  const pending: Array<(value: unknown) => void> = [];
  mocks.update.mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  await act(async () =>
    root.render(
      <MuseAgentChatEntry environmentId={environmentId} providerInstanceId={providerInstanceId} />,
    ),
  );
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Opening this conversation. Nothing is sent to Muse.");
  mocks.threads = [{ id: threadId, providerInstanceId }];
  await act(async () =>
    root.render(
      <MuseAgentChatEntry environmentId={environmentId} providerInstanceId={providerInstanceId} />,
    ),
  );
  expect(mocks.update).toHaveBeenCalledTimes(1);
  const resolveOpen = pending[0];
  if (resolveOpen === undefined) throw new Error("Muse open did not start");
  await act(async () => {
    resolveOpen({ _tag: "Success", value: { threadId } });
  });
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
    replace: true,
  });
  expect(mocks.update).toHaveBeenCalledTimes(1);
});

it("refuses to open a queued intent for a different Muse account", async () => {
  queueMuseChatOpen({
    kind: "main",
    environmentId: EnvironmentId.make("other-env"),
    providerInstanceId: ProviderInstanceId.make("other-muse"),
  });
  await act(async () =>
    root.render(
      <MuseAgentChatEntry environmentId={environmentId} providerInstanceId={providerInstanceId} />,
    ),
  );
  expect(mocks.update).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "different Muse account",
  );
});
