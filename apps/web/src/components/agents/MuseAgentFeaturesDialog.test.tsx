// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ connected: "muse-current", read: vi.fn(), update: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/museAgent", () => ({
  museAgentFeatureReadQuery: (query: unknown) => {
    mocks.read(query);
    return query;
  },
  museAgentStatusQuery: () => "status",
  museAgentProfileQuery: () => "profile",
  museAgentFeatureUpdate: { permissionAtom: () => true },
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
  }: {
    onActiveChange: (active: boolean) => void;
  }) => <button onClick={() => onActiveChange(true)}>Start recording</button>,
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
