import { EnvironmentId, GrokBotSecretError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, render, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { GrokBotSecureInputPanel } from "./GrokBotSecureInputPanel";
import {
  useHiddenGrokBotSecretRequests,
  type GrokBotSecretRequestItem,
} from "./grokBotSecretRequest";

const { submitSecret, dismissSecret, commands, permissions } = vi.hoisted(() => ({
  permissions: { dismiss: true },
  submitSecret: vi.fn(),
  dismissSecret: vi.fn(),
  commands: {
    submit: { permissionAtom: () => ({}) },
    dismiss: { permissionAtom: () => "dismiss" },
  },
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => (atom === "dismiss" ? permissions.dismiss : true),
}));
vi.mock("/src/state/grokBots.ts", () => ({
  grokBotsSecretSubmit: commands.submit,
  grokBotsSecretDismiss: commands.dismiss,
}));
vi.mock("/src/state/use-atom-command.ts", () => ({
  useAtomCommand: (command: unknown) =>
    command === commands.dismiss ? dismissSecret : submitSecret,
}));

const environmentId = EnvironmentId.make("env-1");
function setup(screen: Screen) {
  permissions.dismiss = true;
  submitSecret.mockReset();
  dismissSecret.mockReset();
  useHiddenGrokBotSecretRequests.setState({ keys: [] });
  const pendingRequest: GrokBotSecretRequestItem = {
    entryId: expect.getState().currentTestName ?? "secure-input",
    sessionId: "",
    title: "GitHub token",
    description: "Needed for the release check",
    state: "pending",
  };
  const { container } = screen;
  const panel = (
    requests: ReadonlyArray<GrokBotSecretRequestItem> = [pendingRequest],
    target = { environmentId, botId: "bot-1" },
  ) => <GrokBotSecureInputPanel {...target} requests={requests} />;
  const renderPanel = (
    requests?: ReadonlyArray<GrokBotSecretRequestItem>,
    target?: { environmentId: EnvironmentId; botId: string },
  ) => screen.rerender(panel(requests, target));
  const field = () => {
    const input = container.querySelector("input");
    if (!input) throw new Error("Secure input is not visible");
    return input;
  };
  const saveButton = () => {
    const button = container.querySelector<HTMLButtonElement>("button[type=submit]");
    if (!button) throw new Error("Save button is not visible");
    return button;
  };
  const dismissButton = () => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Dismiss",
    );
    if (!button) throw new Error("Dismiss button is not visible");
    return button;
  };
  const typeSecret = (value: string) => screen.getByLabelText("GitHub token").fill(value);
  const submitForm = () =>
    screen.getByRole("button", { name: "Save securely", exact: true }).click();
  const clickDismiss = () => screen.getByRole("button", { name: "Dismiss", exact: true }).click();
  const hideButtonOrNull = () =>
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Hide on this device",
    ) ?? null;
  return {
    pendingRequest,
    panel,
    renderPanel,
    field,
    saveButton,
    dismissButton,
    typeSecret,
    submitForm,
    clickDismiss,
    hideButtonOrNull,
  };
}

const accepted = { _tag: "Success", value: { accepted: true } };
const failed = (error: unknown) => ({ _tag: "Failure", cause: Cause.fail(error) });

describe("GrokBotSecureInputPanel", () => {
  it("sends the trimmed value for the pending request and closes the card once native accepts", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { pendingRequest, renderPanel, saveButton, typeSecret, submitForm } = setup(screen);
    submitSecret.mockResolvedValue(accepted);
    await renderPanel();
    expect(saveButton().disabled).toBe(true);

    await typeSecret("  s3cret  ");
    expect(saveButton().disabled).toBe(false);
    await submitForm();

    expect(submitSecret).toHaveBeenCalledWith({
      environmentId,
      input: { botId: "bot-1", sessionId: "", entryId: pendingRequest.entryId, value: "s3cret" },
    });
    expect(container.querySelector("input")).toBeNull();
  });

  it("keeps a saved request closed when a stale snapshot still lists it as pending", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { pendingRequest, renderPanel, typeSecret, submitForm } = setup(screen);
    submitSecret.mockResolvedValue(accepted);
    await renderPanel();
    await typeSecret("s3cret");
    await submitForm();

    await renderPanel([{ ...pendingRequest }]);

    expect(container.querySelector("input")).toBeNull();
  });

  it("closes the card without an error when native says the request is already answered", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { renderPanel, typeSecret, submitForm } = setup(screen);
    submitSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "already_answered" })));
    await renderPanel();

    await typeSecret("hunter2");
    await submitForm();

    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("could not be delivered");
    expect(container.textContent).not.toContain("hunter2");
  });

  it("keeps the card and shows the server copy for a refused save so the user can retry", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { renderPanel, field, saveButton, typeSecret, submitForm } = setup(screen);
    const refused = new GrokBotSecretError({ reason: "refused" });
    submitSecret.mockResolvedValue(failed(refused));
    await renderPanel();

    await typeSecret("hunter2");
    await submitForm();

    expect(field().value).toBe("");
    expect(container.textContent).toContain(refused.message);
    expect(container.textContent).not.toContain("hunter2");
    expect(saveButton().disabled).toBe(true);
  });

  it("uses generic copy for an unknown failure so a transport error cannot surface the value", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { renderPanel, field, typeSecret, submitForm } = setup(screen);
    submitSecret.mockResolvedValue(failed(new Error("socket closed while sending hunter2")));
    await renderPanel();

    await typeSecret("hunter2");
    await submitForm();

    expect(field().value).toBe("");
    expect(container.textContent).toContain("Could not send the secure input. Try again.");
    expect(container.textContent).not.toContain("hunter2");
  });

  it("clears the field and shows generic copy when the submit rejects instead of settling", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { renderPanel, field, saveButton, typeSecret, submitForm } = setup(screen);
    submitSecret.mockRejectedValue(new Error("pipe broke with hunter2 inside"));
    await renderPanel();

    await typeSecret("hunter2");
    await submitForm();

    expect(field().value).toBe("");
    expect(saveButton().disabled).toBe(true);
    expect(container.textContent).toContain("Could not send the secure input. Try again.");
    expect(container.textContent).not.toContain("hunter2");
  });

  it("dismisses through native and closes the card once native accepts the dismissal", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { pendingRequest, renderPanel, clickDismiss } = setup(screen);
    dismissSecret.mockResolvedValue(accepted);
    await renderPanel();

    await clickDismiss();

    expect(dismissSecret).toHaveBeenCalledWith({
      environmentId,
      input: { botId: "bot-1", sessionId: "", entryId: pendingRequest.entryId },
    });
    expect(submitSecret).not.toHaveBeenCalled();
    expect(container.querySelector("input")).toBeNull();
  });

  it.each(["refused", "unavailable", "unsupported"] as const)(
    "leaves no card or notice when native returns %s for dismissal",
    async (reason) => {
      await using screen = await render(<></>);
      const { container } = screen;
      const { pendingRequest, renderPanel, field, typeSecret, clickDismiss } = setup(screen);
      dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason })));
      await renderPanel();
      await typeSecret("hunter2");
      const input = field();

      await clickDismiss();
      await renderPanel([{ ...pendingRequest }]);

      expect(container.innerHTML).toBe("");
      expect(input.value).toBe("");
      expect(submitSecret).not.toHaveBeenCalled();
      expect(dismissSecret).toHaveBeenCalledTimes(1);
    },
  );

  it("hides immediately before native acknowledgment and stays hidden after rejection", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { pendingRequest, renderPanel, field, typeSecret, clickDismiss } = setup(screen);
    let rejectDismiss!: (error: Error) => void;
    dismissSecret.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectDismiss = reject;
        }),
    );
    await renderPanel();
    await typeSecret("hunter2");
    const input = field();

    await clickDismiss();

    expect(container.innerHTML).toBe("");
    expect(input.value).toBe("");
    expect(localStorage.getItem("t3code:grok-bot-hidden-secret-requests:v1")).not.toContain(
      "hunter2",
    );
    await act(async () => rejectDismiss(new Error("socket closed")));
    await renderPanel([{ ...pendingRequest }]);
    expect(container.innerHTML).toBe("");
  });

  it("dismisses with touch activation and ignores a duplicate activation before rerender", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { renderPanel, field, dismissButton, typeSecret } = setup(screen);
    dismissSecret.mockResolvedValue(accepted);
    await renderPanel();
    await typeSecret("hunter2");
    const input = field();
    const button = dismissButton();

    await act(async () => {
      button.dispatchEvent(new Event("touchstart", { bubbles: true }));
      button.dispatchEvent(new Event("touchend", { bubbles: true }));
      button.click();
      button.click();
    });

    expect(container.innerHTML).toBe("");
    expect(input.value).toBe("");
    expect(dismissSecret).toHaveBeenCalledTimes(1);
    expect(submitSecret).not.toHaveBeenCalled();
  });

  it("clears an existing save error when dismissed even if native refuses", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { renderPanel, typeSecret, submitForm, clickDismiss } = setup(screen);
    submitSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    await renderPanel();
    await typeSecret("hunter2");
    await submitForm();
    expect(container.textContent).toContain("Grok Bot declined the secure input.");

    await clickDismiss();

    expect(container.innerHTML).toBe("");
  });

  it("does not offer a fallback hide after a save error", async () => {
    await using screen = await render(<></>);
    const { renderPanel, typeSecret, submitForm, hideButtonOrNull } = setup(screen);
    submitSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    await renderPanel();
    await typeSecret("hunter2");
    await submitForm();

    expect(hideButtonOrNull()).toBeNull();
  });

  it("allows local dismissal without native permission", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { renderPanel, dismissButton, clickDismiss } = setup(screen);
    permissions.dismiss = false;
    await renderPanel();
    expect(dismissButton().disabled).toBe(false);

    await clickDismiss();

    expect(container.innerHTML).toBe("");
    expect(dismissSecret).not.toHaveBeenCalled();
  });

  it("lists a request repeated within one snapshot only once", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { pendingRequest, renderPanel } = setup(screen);
    await renderPanel([pendingRequest, { ...pendingRequest }]);

    expect(container.querySelectorAll("input")).toHaveLength(1);
  });

  it("masks the value as a password field, since CSS text-security does not hide it in Firefox", async () => {
    await using screen = await render(<></>);
    const { renderPanel, field } = setup(screen);
    await renderPanel();

    expect(field().type).toBe("password");
  });

  it("clears the field when the form unmounts before any answer", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { renderPanel, field, typeSecret } = setup(screen);
    await renderPanel();
    await typeSecret("abc123");
    const input = field();

    await renderPanel([]);

    expect(container.querySelector("input")).toBeNull();
    expect(input.value).toBe("");
  });

  it("does not offer a request the native side has already responded to", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { pendingRequest, renderPanel } = setup(screen);
    await renderPanel([{ ...pendingRequest, state: "responded" }]);

    expect(container.querySelector("input")).toBeNull();
  });

  it("persists dismissal across storage rehydration and remount without any hidden row", async () => {
    await using screen = await render(<></>);
    const { pendingRequest, panel, renderPanel, clickDismiss } = setup(screen);
    dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "unsupported" })));
    await renderPanel();
    await clickDismiss();
    const persisted = localStorage.getItem("t3code:grok-bot-hidden-secret-requests:v1");
    expect(persisted).toContain(pendingRequest.entryId);

    await screen.unmount();
    // Rehydrate from the saved browser storage, as a page reload would.
    useHiddenGrokBotSecretRequests.setState({ keys: [] });
    localStorage.setItem("t3code:grok-bot-hidden-secret-requests:v1", persisted!);
    await useHiddenGrokBotSecretRequests.persist.rehydrate();
    await using rehydratedScreen = await render(panel());
    expect(rehydratedScreen.container.innerHTML).toBe("");
  });

  it("isolates dismissal by bot, environment, and session while leaving new requests visible", async () => {
    await using screen = await render(<></>);
    const { container } = screen;
    const { pendingRequest, renderPanel, field, clickDismiss } = setup(screen);
    dismissSecret.mockResolvedValue(accepted);
    await renderPanel();
    await clickDismiss();
    expect(container.innerHTML).toBe("");

    await renderPanel([pendingRequest], { environmentId, botId: "other-bot" });
    expect(field()).not.toBeNull();
    await renderPanel([pendingRequest], {
      environmentId: EnvironmentId.make("other-account"),
      botId: "bot-1",
    });
    expect(field()).not.toBeNull();
    await renderPanel([{ ...pendingRequest, sessionId: "other-session" }]);
    expect(field()).not.toBeNull();
    await renderPanel([pendingRequest, { ...pendingRequest, entryId: "new-request" }]);
    expect(container.querySelectorAll("input")).toHaveLength(1);
    await renderPanel([pendingRequest]);
    expect(container.innerHTML).toBe("");
  });
});
