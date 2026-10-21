import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { act, render as renderScreen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({
  signIn: vi.fn(),
  close: vi.fn(),
  setup: vi.fn(),
  canSetup: true,
  canSignIn: true,
  status: {
    data: null as null | {
      installed: boolean;
      sessionPresent: boolean;
      provider?: { instanceId: string };
    },
    error: null as unknown,
    isPending: false,
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (permission: string) =>
    permission === "setup" ? commands.canSetup : commands.canSignIn,
}));
vi.mock("/src/state/museAgent.ts", () => ({
  museAgentSetup: { permissionAtom: () => "setup", kind: "setup" },
  museAgentSignIn: { permissionAtom: () => "signIn", kind: "signIn" },
  museAgentCloseSignIn: { kind: "close" },
  museAgentStatusQuery: () => null,
  refreshMuseAgent: vi.fn(),
}));
vi.mock("/src/state/query.ts", () => ({
  useEnvironmentQuery: () => commands.status,
}));
vi.mock("/src/state/use-atom-command.ts", () => ({
  useAtomCommand: (command: { kind: keyof typeof commands }) => commands[command.kind],
}));
vi.mock("/src/rpc/atomRegistry.ts", () => ({ appAtomRegistry: {} }));
// The settings row reads the full environment catalog; this test covers the step's own state.
vi.mock("/src/components/settings/settingsLayout.tsx", () => ({
  SettingsRow: ({
    title,
    description,
    control,
    children,
  }: {
    title: string;
    description: string;
    control: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      <div>{control}</div>
      {children}
    </div>
  ),
}));
vi.mock("/src/browser/ServerBrowserSurface.tsx", () => ({
  ServerBrowserSurface: () => <div>Private sign-in page</div>,
}));
import { AddMuseAgentProviderStep } from "./AddMuseAgentProviderStep";
it("retires the private sign-in page when its dialog closes", async () => {
  setup();

  commands.signIn.mockResolvedValue({
    _tag: "Success",
    value: { threadId: "private-owner", tabId: "tab" },
  });
  const container = document.createElement("div");
  document.body.append(container);
  await using root = await renderScreen(<></>, { container });
  const environmentId = EnvironmentId.make("test");
  try {
    await act(async () =>
      root.rerender(
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
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Private sign-in page"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("retires an opening page that completes after the provider dialog unmounts", async () => {
  setup();

  let finish: (value: unknown) => void = () => {
    throw new Error("Sign-in promise is not initialized");
  };
  const promise = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  commands.signIn.mockReturnValue(promise);
  const container = document.createElement("div");
  document.body.append(container);
  await using root = await renderScreen(<></>, { container });
  const environmentId = EnvironmentId.make("test");
  await act(async () =>
    root.rerender(
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
    setup();

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
    await using root = await renderScreen(<></>, { container });
    const render = () =>
      root.rerender(
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
          await vi.waitFor(() =>
            expect(document.body.textContent).not.toContain("Private sign-in page"),
          );
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

const savedSession = (instanceId: string) => ({
  data: { installed: true, sessionPresent: true, provider: { instanceId } },
  error: null,
  isPending: false,
});

it("reconnects the saved session without opening a sign-in browser", async () => {
  setup();

  const environmentId = EnvironmentId.make("remote");
  const instanceId = ProviderInstanceId.make("existing-muse");
  const onConnected = vi.fn();
  commands.status = savedSession(instanceId);
  commands.setup.mockResolvedValue({
    _tag: "Success",
    value: { ready: true, provider: { instanceId } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <AddMuseAgentProviderStep
          environmentId={environmentId}
          environmentLabel="remote"
          reconnecting
          onConnected={onConnected}
        />,
      ),
    );
    const reconnect = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Reconnect",
    )!;
    await act(async () => reconnect.click());
    expect(commands.setup).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(onConnected).toHaveBeenCalledWith(instanceId);
    expect(commands.signIn).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("blocks reconnect when setup permission is revoked", async () => {
  setup();

  const environmentId = EnvironmentId.make("remote");
  commands.status = savedSession("existing-muse");
  commands.canSetup = false;
  const container = document.createElement("div");
  document.body.append(container);
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <AddMuseAgentProviderStep
          environmentId={environmentId}
          environmentLabel="remote"
          reconnecting
          onConnected={vi.fn()}
        />,
      ),
    );
    const reconnect = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Reconnect",
    )!;
    expect(reconnect.disabled).toBe(true);
    await act(async () => reconnect.click());
    expect(commands.setup).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("labels only the reconnect action while it verifies", async () => {
  setup();

  const environmentId = EnvironmentId.make("remote");
  commands.status = savedSession("existing-muse");
  commands.setup.mockReturnValue(new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <AddMuseAgentProviderStep
          environmentId={environmentId}
          environmentLabel="remote"
          reconnecting
          onConnected={vi.fn()}
        />,
      ),
    );
    const reconnect = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Reconnect",
    )!;
    await act(async () => reconnect.click());
    expect(container.textContent).toContain("Reconnecting…");
    expect(container.textContent).not.toContain("Opening…");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each<[string, typeof commands.status, string]>([
  [
    "installed is false",
    { data: { installed: false, sessionPresent: false }, error: null, isPending: false },
    "Could not verify the Muse session.",
  ],
  [
    "the status is unknown",
    { data: null, error: null, isPending: false },
    "Could not verify the Muse session.",
  ],
  [
    "the status query fails",
    { data: null, error: "Environment unreachable", isPending: false },
    "Could not load Muse status.",
  ],
  [
    "the inspected install has no session",
    { data: { installed: true, sessionPresent: false }, error: null, isPending: false },
    "No saved Muse session on this environment.",
  ],
])("describes the Muse account state when %s", async (_, status, copy) => {
  setup();

  commands.status = status;
  const container = document.createElement("div");
  document.body.append(container);
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <AddMuseAgentProviderStep
          environmentId={EnvironmentId.make("remote")}
          environmentLabel="remote"
          reconnecting
          onConnected={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain(copy);
    expect(container.textContent).not.toMatch(/install|disconnect/i);
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Sign in again",
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("announces a failed connect once while the sign-in browser is open", async () => {
  setup();

  commands.signIn.mockResolvedValue({
    _tag: "Success",
    value: { threadId: "private-alert", tabId: "tab" },
  });
  commands.setup.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("The native account changed.")),
  });
  const container = document.createElement("div");
  document.body.append(container);
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <AddMuseAgentProviderStep
          environmentId={EnvironmentId.make("test")}
          environmentLabel="test"
          onConnected={vi.fn()}
        />,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const finish = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Finish sign-in",
    )!;
    await act(async () => finish.click());
    expect(
      [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
    ).toEqual(["The native account changed."]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

const alertTexts = () =>
  [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);
const findButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label,
  )!;
async function dismissSignInDialog(how: "Close" | "Escape" | "X" | "backdrop") {
  await act(async () => {
    if (how === "Close") findButton("Close").click();
    else if (how === "X")
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    else if (how === "Escape")
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]')!.click();
  });
}

it.each([
  { reconnecting: false, dismiss: "Close" },
  { reconnecting: false, dismiss: "Escape" },
  { reconnecting: false, dismiss: "X" },
  { reconnecting: false, dismiss: "backdrop" },
  { reconnecting: true, dismiss: "Close" },
  { reconnecting: true, dismiss: "Escape" },
  { reconnecting: true, dismiss: "X" },
  { reconnecting: true, dismiss: "backdrop" },
] as const)(
  "does not repeat a failed Finish sign-in alert when dismissed with $dismiss (reconnecting: $reconnecting)",
  async ({ reconnecting, dismiss }) => {
    setup();

    const environmentId = EnvironmentId.make("remote");
    const instanceId = ProviderInstanceId.make("existing-muse");
    const onConnected = vi.fn();
    const signInLabel = reconnecting ? "Sign in again" : "Sign in to Muse";
    // Once-queues would leak into later cases if an earlier case fails before consuming them.
    commands.signIn.mockReset();
    commands.setup.mockReset();
    commands.signIn
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { threadId: "private-failed", tabId: "tab" },
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { threadId: "private-retry", tabId: "tab" },
      });
    commands.setup
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("The native account changed.")),
      })
      .mockResolvedValueOnce({ _tag: "Success", value: { ready: true, provider: { instanceId } } });
    const container = document.createElement("div");
    document.body.append(container);
    await using root = await renderScreen(<></>, { container });
    try {
      await act(async () =>
        root.rerender(
          <AddMuseAgentProviderStep
            environmentId={environmentId}
            environmentLabel="remote"
            reconnecting={reconnecting}
            onConnected={onConnected}
          />,
        ),
      );
      await act(async () => findButton(signInLabel).click());
      await act(async () => findButton("Finish sign-in").click());
      expect(alertTexts()).toEqual(["The native account changed."]);

      await dismissSignInDialog(dismiss);
      expect(commands.close).toHaveBeenCalledWith({
        environmentId,
        input: { threadId: "private-failed" },
      });
      await vi.waitFor(() =>
        expect(document.body.textContent).not.toContain("Private sign-in page"),
      );
      // The failure was already announced inside the dialog; it must not remount outside it.
      expect(alertTexts()).toEqual([]);

      await act(async () => findButton(signInLabel).click());
      expect(commands.signIn).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("Private sign-in page");
      await act(async () => findButton("Finish sign-in").click());
      expect(commands.setup).toHaveBeenCalledTimes(2);
      expect(onConnected).toHaveBeenCalledWith(instanceId);
      expect(alertTexts()).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

function setup() {
  vi.clearAllMocks();
  commands.canSetup = true;
  commands.canSignIn = true;
  commands.status = { data: null, error: null, isPending: false };
}
