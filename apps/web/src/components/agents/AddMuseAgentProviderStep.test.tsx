// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({
  signIn: vi.fn(),
  close: vi.fn(),
  setup: vi.fn(),
  canSetup: true,
  canSignIn: true,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (permission: string) =>
    permission === "setup" ? commands.canSetup : commands.canSignIn,
}));
vi.mock("~/state/museAgent", () => ({
  museAgentSetup: { permissionAtom: () => "setup", kind: "setup" },
  museAgentSignIn: { permissionAtom: () => "signIn", kind: "signIn" },
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
  commands.canSetup = true;
  commands.canSignIn = true;
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

it.each(["connected", "account mismatch", "permission revoked"])(
  "offers private reconnect without a cached session: %s",
  async (outcome) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("remote");
    const instanceId = ProviderInstanceId.make("existing-muse");
    const onConnected = vi.fn();
    commands.signIn.mockResolvedValue({
      _tag: "Success",
      value: { threadId: "private-reconnect", tabId: "tab" },
    });
    commands.setup.mockResolvedValue(
      outcome === "account mismatch"
        ? { _tag: "Failure", cause: Cause.fail(new Error("The native account changed.")) }
        : { _tag: "Success", value: { ready: true, provider: { instanceId } } },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = () =>
      root.render(
        <AddMuseAgentProviderStep
          environmentId={environmentId}
          environmentLabel="remote"
          reconnecting
          onConnected={onConnected}
        />,
      );
    try {
      await act(async () => render());
      const signIn = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Sign in again",
      )!;
      await act(async () => signIn.click());
      expect(commands.signIn).toHaveBeenCalledWith({ environmentId, input: {} });
      expect(document.body.textContent).toContain("Private sign-in page");
      if (outcome === "permission revoked") {
        commands.canSetup = false;
        await act(async () => render());
      }
      const finish = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Finish sign-in",
      )!;
      await act(async () => finish.click());
      if (outcome === "permission revoked") {
        expect(finish.disabled).toBe(true);
        expect(commands.setup).not.toHaveBeenCalled();
      } else {
        expect(commands.setup).toHaveBeenCalledWith({ environmentId, input: {} });
        if (outcome === "connected") {
          expect(onConnected).toHaveBeenCalledWith(instanceId);
          expect(document.body.textContent).not.toContain("Private sign-in page");
          expect(commands.close).toHaveBeenCalledWith({
            environmentId,
            input: { threadId: "private-reconnect" },
          });
        } else {
          expect(onConnected).not.toHaveBeenCalled();
          expect(document.body.textContent).toContain("The native account changed.");
          expect(document.body.textContent).toContain("Private sign-in page");
        }
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
