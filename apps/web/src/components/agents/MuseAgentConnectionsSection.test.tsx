// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId, type MuseAgentConnector } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  canWritePermission: true,
  connectors: [] as MuseAgentConnector[],
  connectorsError: null as string | null,
  isPending: false,
  refresh: vi.fn(),
  info: {
    type: "oauth",
    authorizationUrl: "https://authorize.example.test/flow",
  } as { type: string; authorizationUrl?: string },
  infoError: null as string | null,
  infoRefresh: vi.fn(),
  accounts: {
    supported: true,
    accounts: [{ accountId: "acct-1", displayName: "Work", isDefault: true }],
  } as {
    supported: boolean;
    accounts: Array<{ accountId: string; displayName?: string; isDefault?: boolean }>;
  } | null,
  accountsError: null as string | null,
  update: vi.fn(),
  loadIcon: vi.fn(async (_url: string) => null as Blob | null),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.canWritePermission,
}));
vi.mock("~/state/museAgent", () => ({
  museAgentFeatureReadQuery: (query: unknown) => query,
  museAgentFeatureUpdate: { permissionAtom: () => ({}) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: { input?: { operation: string } } | null) => {
    const operation = query?.input?.operation;
    if (operation === "connector_info") {
      return {
        data:
          mocks.infoError === null
            ? { operation: "connector_info", data: { connectorId: "asana", action: mocks.info } }
            : null,
        error: mocks.infoError,
        isPending: false,
        refresh: mocks.infoRefresh,
      };
    }
    if (operation === "connector_accounts") {
      return {
        data:
          mocks.accounts === null
            ? null
            : { operation: "connector_accounts", data: mocks.accounts },
        error: mocks.accountsError,
        isPending: false,
        refresh: mocks.refresh,
      };
    }
    return {
      data: { operation: "connectors", data: mocks.connectors },
      error: mocks.connectorsError,
      isPending: mocks.isPending,
      refresh: mocks.refresh,
    };
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../grokBot/marketplaceIconCache", () => ({
  loadMarketplaceIcon: (url: string) => mocks.loadIcon(url),
}));

import {
  MuseAgentConnectorAuthDialog,
  MuseAgentConnectionsSection,
} from "./MuseAgentConnectionsSection";

const environmentId = EnvironmentId.make("test-env");
const providerInstanceId = ProviderInstanceId.make("muse-test");

function connector(
  partial: Pick<MuseAgentConnector, "id" | "name" | "state"> & Partial<MuseAgentConnector>,
): MuseAgentConnector {
  return { description: "", ...partial };
}

function renderSection(canWrite = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

async function mount(canWrite = true) {
  const { container, root } = renderSection(canWrite);
  await act(async () =>
    root.render(
      <MuseAgentConnectionsSection
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        canWrite={canWrite}
      />,
    ),
  );
  return { container, root };
}

function setSearch(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search connections"]',
  )!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.canWritePermission = true;
  mocks.connectorsError = null;
  mocks.isPending = false;
  mocks.info = { type: "oauth", authorizationUrl: "https://authorize.example.test/flow" };
  mocks.infoError = null;
  mocks.accounts = {
    supported: true,
    accounts: [{ accountId: "acct-1", displayName: "Work", isDefault: true }],
  };
  mocks.accountsError = null;
  mocks.loadIcon.mockResolvedValue(null);
  mocks.connectors = [
    connector({
      id: "asana",
      name: "Asana",
      description: "Plan and track projects and tasks",
      state: "disconnected",
    }),
    connector({
      id: "browser",
      name: "Browser",
      description: "Search the web",
      state: "connected",
    }),
    connector({
      id: "future",
      name: "Future Mail",
      description: "Inbox for tomorrow",
      state: "coming_soon",
    }),
    connector({
      id: "wiki",
      name: "Wiki",
      description: "Notes",
      state: "unknown",
    }),
    connector({ id: "box", name: "Box", description: "Files", state: "disconnected" }),
    connector({ id: "canva", name: "Canva", description: "Design", state: "disconnected" }),
    connector({ id: "dropbox", name: "Dropbox", description: "Files", state: "disconnected" }),
    connector({ id: "figma", name: "Figma", description: "Design", state: "disconnected" }),
  ];
});

afterEach(async () => {
  await act(async () => {});
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("lists connected connections first and omits redundant not-connected labels", async () => {
  const { container, root } = await mount();
  try {
    const headings = [...container.querySelectorAll("section")].map((section) =>
      section.getAttribute("aria-label"),
    );
    expect(headings.slice(0, 3)).toEqual(["Connected", "Available", "Needs attention"]);
    const names = [...container.querySelectorAll("li")].map(
      (row) => row.querySelector(".font-medium")?.textContent,
    );
    expect(names[0]).toBe("Browser");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toMatch(/Not connected/);
    expect(container.textContent).toContain("Coming soon");
    expect(container.textContent).toContain("Status unavailable");
    const asana = [...container.querySelectorAll("li")].find((row) =>
      row.textContent?.includes("Asana"),
    );
    expect(asana?.textContent).not.toContain("Not connected");
    expect(asana?.querySelector("span[aria-hidden]")?.textContent).toBe("A");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("filters the catalog from search and category chips", async () => {
  const { container, root } = await mount();
  try {
    await act(async () => setSearch(container, "plan"));
    expect(container.textContent).toContain("Asana");
    expect(container.textContent).not.toContain("Browser");
    await act(async () => setSearch(container, "zzzz"));
    expect(container.textContent).toContain("Nothing matches.");
    await act(async () => setSearch(container, ""));
    const comingSoon = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Coming soon",
    )!;
    await act(async () => comingSoon.click());
    expect(container.textContent).toContain("Future Mail");
    expect(container.textContent).not.toContain("Asana");
    expect(container.textContent).not.toContain("Browser");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("shows remaining connections after the selected category disappears from a refreshed catalog", async () => {
  const { container, root } = await mount();
  try {
    const connected = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Connected",
    )!;
    await act(async () => connected.click());
    expect(container.textContent).toContain("Browser");
    expect(container.textContent).not.toContain("Asana");
    mocks.connectors = [
      connector({
        id: "asana",
        name: "Asana",
        description: "Plan and track projects and tasks",
        state: "disconnected",
      }),
      connector({ id: "box", name: "Box", description: "Files", state: "disconnected" }),
    ];
    await act(async () =>
      root.render(
        <MuseAgentConnectionsSection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          canWrite
        />,
      ),
    );
    expect(container.textContent).toContain("Asana");
    expect(container.textContent).toContain("Box");
    expect(container.textContent).not.toContain("Nothing matches.");
    expect(container.textContent).not.toContain("Browser");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("reveals the rest of a long available section from View all", async () => {
  const { container, root } = await mount();
  try {
    expect(container.textContent).toContain("Asana");
    expect(container.textContent).not.toContain("Figma");
    const viewAll = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "View all",
    )!;
    await act(async () => viewAll.click());
    expect(container.textContent).toContain("Figma");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("offers a user-clicked https OAuth continue link and a way to recheck without authorizing", async () => {
  const { container, root } = await mount();
  try {
    const connect = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Connect Asana"]',
    )!;
    await act(async () => connect.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Continue to sign in to Asana");
    const continueLink = dialog.querySelector<HTMLAnchorElement>("a[href]")!;
    expect(continueLink.getAttribute("href")).toBe("https://authorize.example.test/flow");
    expect(continueLink.getAttribute("target")).toBe("_blank");
    const check = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === "Check connection",
    )!;
    await act(async () => check.click());
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("exported auth dialog runs the checked OAuth flow without a catalog list or a write", async () => {
  const onClose = vi.fn();
  const onRecheck = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MuseAgentConnectorAuthDialog
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          connector={connector({
            id: "asana",
            name: "Asana",
            description: "Plan",
            state: "disconnected",
          })}
          onClose={onClose}
          onRecheck={onRecheck}
        />,
      ),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Connect Asana");
    expect(dialog.querySelector("a[href]")?.getAttribute("href")).toBe(
      "https://authorize.example.test/flow",
    );
    const check = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === "Check connection",
    )!;
    await act(async () => check.click());
    expect(onRecheck).toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <MuseAgentConnectorAuthDialog
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          connector={connector({
            id: "asana",
            name: "Asana",
            description: "Plan",
            state: "connected",
          })}
          onClose={onClose}
          onRecheck={onRecheck}
        />,
      ),
    );
    expect(onClose).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("refuses a non-https OAuth address and still offers a new sign-in link", async () => {
  mocks.info = { type: "oauth", authorizationUrl: "http://authorize.example.test/flow" };
  const { container, root } = await mount();
  try {
    const connect = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Connect Asana"]',
    )!;
    await act(async () => connect.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("not a secure https address");
    expect(dialog.querySelector("a[href]")).toBeNull();
    const retry = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("new sign-in link"),
    )!;
    await act(async () => retry.click());
    expect(mocks.infoRefresh).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("makes unsupported native sign-in actionable without dispatching a write", async () => {
  mocks.info = { type: "whatsapp" };
  const { container, root } = await mount();
  try {
    const connect = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Connect Asana"]',
    )!;
    await act(async () => connect.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("uses a Muse-only sign-in");
    expect(dialog.querySelector("a[href]")).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("keeps Connect available for unknown status and disabled without write permission", async () => {
  const { container, root } = await mount(false);
  try {
    const wiki = container.querySelector<HTMLButtonElement>('button[aria-label="Connect Wiki"]')!;
    expect(wiki.disabled).toBe(true);
    await act(async () => wiki.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const asana = container.querySelector<HTMLButtonElement>('button[aria-label="Connect Asana"]')!;
    expect(asana.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("opens account management for a connected connector without unlinking", async () => {
  const { container, root } = await mount();
  try {
    const accounts = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Accounts for Browser"]',
    )!;
    await act(async () => accounts.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Work");
    expect(dialog.textContent).toContain("Default");
    expect(mocks.update).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("shows the cached provider icon once bytes load and keeps the letter tile when they do not", async () => {
  const blob = new Blob(["synthetic-logo"], { type: "image/svg+xml" });
  mocks.loadIcon.mockImplementation(async (url: string) => (url.includes("asana") ? blob : null));
  const create = vi.fn(() => "blob:asana-icon");
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = create;
  const { container, root } = await mount();
  try {
    await act(async () => {
      await Promise.all(mocks.loadIcon.mock.results.map((result) => result.value));
    });
    const asana = [...container.querySelectorAll("li")].find((row) =>
      row.textContent?.includes("Asana"),
    )!;
    const img = asana.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("blob:asana-icon");
    await act(async () => img.dispatchEvent(new Event("load")));
    expect(asana.querySelector("span[aria-hidden]")).toBeNull();
    const wiki = [...container.querySelectorAll("li")].find((row) =>
      row.textContent?.includes("Wiki"),
    )!;
    expect(wiki.querySelector("span[aria-hidden]")?.textContent).toBe("W");
    const wikiImg = wiki.querySelector("img");
    if (wikiImg) {
      await act(async () => wikiImg.dispatchEvent(new Event("error")));
    }
    expect(wiki.querySelector("img")).toBeNull();
    expect(wiki.querySelector("span[aria-hidden]")?.textContent).toBe("W");
  } finally {
    URL.createObjectURL = originalCreate;
    await act(async () => root.unmount());
    container.remove();
  }
});
