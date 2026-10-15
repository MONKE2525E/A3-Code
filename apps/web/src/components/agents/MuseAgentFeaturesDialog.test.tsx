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
  update: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (permission: unknown) =>
    permission === "settings" ? mocks.settings : mocks.operate,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
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
      input?.operation === "profile_save" ? "settings" : "operate",
  },
  museAgentOpenThread: { permissionAtom: () => true },
  refreshMuseAgent: vi.fn(),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    let data: unknown = null;
    if (query === "status") data = { ready: true, provider: { instanceId: mocks.connected } };
    else if (query === "profile") data = { name: "Muse" };
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
            : null;
    }
    return { data, error: null, isPending: false, refresh: vi.fn() };
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("./useMuseAgentAvatar", () => ({
  useMuseAgentAvatar: () => ({ imageUrl: null, videoUrl: null }),
}));
vi.mock("./MuseAgentComputerSection", () => ({ MuseAgentComputerSection: () => null }));
vi.mock("./MuseAgentConnectionsSection", () => ({ MuseAgentConnectionsSection: () => null }));
vi.mock("./MuseAgentDeliveryRecovery", () => ({ MuseAgentDeliveryRecovery: () => null }));
vi.mock("./MuseAgentDictationSection", () => ({
  MuseAgentDictationSection: ({
    onActiveChange,
    chat,
  }: {
    onActiveChange: (active: boolean) => void;
    chat: { start: (prompt: string) => Promise<void> };
  }) => (
    <>
      <button onClick={() => onActiveChange(true)}>Start recording</button>
      <button onClick={() => void chat.start("Transcript")}>Add transcript</button>
    </>
  ),
}));
vi.mock("~/components/ChatMarkdown", () => ({ default: () => null }));

import {
  MuseAgentFeaturesButton,
  MuseAgentFeaturesPanel,
  MuseAgentHeaderFeatures,
} from "./MuseAgentFeaturesDialog";
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

it("confirms sheet dismissal while dictation is active", async () => {
  await act(async () =>
    root.render(
      <MuseAgentFeaturesButton
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
      />,
    ),
  );
  await click(" Muse features");
  await click("DictationSpeak to Muse");
  await click("Start recording");
  await click("Close");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Discard dictation?",
  );
  await click("Keep editing");
  expect(button("Start recording").isConnected).toBe(true);
  await click("Close");
  await click("Discard dictation");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

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
it("guards right-panel dictation on tab switches", async () => {
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.getState().open(panelRef, "muse-features");
  await act(async () => root.render(<PanelHost />));
  await click("DictationSpeak to Muse");
  await click("Start recording");
  await act(async () => useRightPanelStore.getState().open(panelRef, "files"));
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Discard dictation?",
  );
  await click("Keep editing");
  expect(button("Start recording").isConnected).toBe(true);
  await act(async () => useRightPanelStore.getState().open(panelRef, "files"));
  await click("Discard dictation");
  expect(container.textContent).toBe("Other surface");
});

it("closes without a discard prompt after handing dictation to the chat draft", async () => {
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.getState().open(panelRef, "muse-features");
  mocks.update.mockResolvedValue({ _tag: "Success", value: { threadId: panelRef.threadId } });
  await act(async () => root.render(<PanelHost />));
  await click("DictationSpeak to Muse");
  await click("Start recording");
  await click("Add transcript");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(container.textContent).toBe("Other surface");
});
