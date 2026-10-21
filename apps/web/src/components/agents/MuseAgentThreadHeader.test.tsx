// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  connected: "muse-current",
  ready: true,
  profile: vi.fn(),
  feature: vi.fn(),
  load: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "threads" ? [] : true),
}));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { environmentThreadsAtom: () => "threads" },
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/museAgent", () => ({
  museAgentProfileQuery: (query: unknown) => {
    mocks.profile(query);
    return { kind: "profile", query };
  },
  museAgentStatusQuery: () => ({ kind: "status" }),
  museAgentFeatureReadQuery: (query: unknown) => {
    mocks.feature(query);
    return { kind: "feature" };
  },
  museAgentHistoryPageCommand: { permissionAtom: () => true },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (
    descriptor: { kind: string; query?: { input: { providerInstanceId: string } } } | null,
  ) => ({
    data:
      descriptor?.kind === "status"
        ? { ready: mocks.ready, provider: { instanceId: mocks.connected } }
        : descriptor?.kind === "profile" &&
            descriptor.query?.input.providerInstanceId === mocks.connected
          ? { name: "Current Muse", avatarImageUrl: "https://example.test/avatar.png" }
          : descriptor?.kind === "feature"
            ? { operation: "history_page", data: { hasMore: true, nextBeforeSeq: 7 } }
            : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.load }));
vi.mock("./useMuseAgentAvatar", () => ({
  useMuseAgentAvatar: (_env: unknown, profile: { avatarImageUrl?: string } | null) => ({
    imageUrl: profile?.avatarImageUrl ?? null,
    videoUrl: null,
  }),
}));
import { MuseAgentThreadHeading } from "./MuseAgentThreadHeading";
import { MuseAgentHistoryPagination } from "./MuseAgentHistoryPagination";
const environmentId = EnvironmentId.make("test-env");
const old = ProviderInstanceId.make("muse-old");
const threadId = ThreadId.make("historical-thread");
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mocks.connected = "muse-current";
  mocks.ready = true;
  mocks.profile.mockClear();
  mocks.feature.mockClear();
  mocks.load.mockReset();
  mocks.load.mockResolvedValue({ _tag: "Success", value: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("uses the historical provider for identity and falls back without the current account's avatar", async () => {
  await act(async () =>
    root.render(
      <MuseAgentThreadHeading
        environmentId={environmentId}
        providerInstanceId={old}
        threadId={threadId}
        fallbackTitle="Saved title"
      />,
    ),
  );
  expect(mocks.profile).toHaveBeenLastCalledWith({
    environmentId,
    input: { providerInstanceId: old },
  });
  expect(container.querySelector("span.truncate")?.textContent).toBe("Saved title");
  expect(container.querySelector("img,video")).toBeNull();
  mocks.connected = old;
  await act(async () =>
    root.render(
      <MuseAgentThreadHeading
        environmentId={environmentId}
        providerInstanceId={old}
        threadId={threadId}
        fallbackTitle="Saved title"
      />,
    ),
  );
  expect(container.textContent).toBe("Current Muse");
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "https://example.test/avatar.png",
  );
});
it("does not query another account when the thread has no provider identity", async () => {
  await act(async () =>
    root.render(
      <MuseAgentThreadHeading
        environmentId={environmentId}
        providerInstanceId={undefined}
        threadId={threadId}
        fallbackTitle="Saved title"
      />,
    ),
  );
  expect(mocks.profile).not.toHaveBeenCalled();
  expect(container.querySelector("span.truncate")?.textContent).toBe("Saved title");
});
it("hides history pagination for a mismatched account and imports through the thread's own provider", async () => {
  const render = () =>
    root.render(
      <MuseAgentHistoryPagination
        environmentId={environmentId}
        providerInstanceId={old}
        threadId={threadId}
      />,
    );
  await act(async () => render());
  expect(container.querySelector("button")).toBeNull();
  expect(mocks.feature).not.toHaveBeenCalled();
  mocks.connected = old;
  await act(async () => render());
  expect(mocks.feature).toHaveBeenLastCalledWith({
    environmentId,
    input: { operation: "history_page", providerInstanceId: old, threadId },
  });
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Load earlier Muse history"]',
  )!;
  expect(button).not.toBeNull();
  await act(async () => button.click());
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { operation: "history_page", providerInstanceId: old, threadId, beforeSeq: 7 },
  });
  mocks.ready = false;
  mocks.feature.mockClear();
  await act(async () => render());
  expect(container.querySelector("button")).toBeNull();
  expect(mocks.feature).not.toHaveBeenCalled();
});
