// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({
  signIn: vi.fn(),
  close: vi.fn(),
  setup: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("~/state/museAgent", () => ({
  museAgentSetup: { permissionAtom: () => null, kind: "setup" },
  museAgentSignIn: { permissionAtom: () => null, kind: "signIn" },
  museAgentCloseSignIn: { kind: "close" },
  museAgentStatusQuery: () => null,
  refreshMuseAgent: vi.fn(),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: false }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: keyof typeof commands }) => commands[command.kind],
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/browser/ServerBrowserSurface", () => ({
  ServerBrowserSurface: () => <div>Private sign-in page</div>,
}));
import { AddMuseAgentProviderStep } from "./AddMuseAgentProviderStep";
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("retires the private sign-in page when its dialog closes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.signIn.mockResolvedValue({
    _tag: "Success",
    value: { threadId: "private-owner", tabId: "tab" },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const environmentId = EnvironmentId.make("test");
  try {
    await act(async () =>
      root.render(
        <AddMuseAgentProviderStep
          environmentId={environmentId}
          environmentLabel="test"
          onConnected={vi.fn()}
        />,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.body.textContent).toContain("Private sign-in page");
    const close = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Close",
    )!;
    await act(async () => close.click());
    expect(commands.close).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: "private-owner" },
    });
    expect(document.body.textContent).not.toContain("Private sign-in page");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("retires an opening page that completes after the provider dialog unmounts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish: (value: unknown) => void = () => {
    throw new Error("Sign-in promise is not initialized");
  };
  const promise = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  commands.signIn.mockReturnValue(promise);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const environmentId = EnvironmentId.make("test");
  await act(async () =>
    root.render(
      <AddMuseAgentProviderStep
        environmentId={environmentId}
        environmentLabel="test"
        onConnected={vi.fn()}
      />,
    ),
  );
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => root.unmount());
  await act(async () =>
    finish({ _tag: "Success", value: { threadId: "late-private-owner", tabId: "tab" } }),
  );
  expect(commands.close).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: "late-private-owner" },
  });
  container.remove();
});
