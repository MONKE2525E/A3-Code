// @vitest-environment jsdom

import { EnvironmentId, GrokBotSecretError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "dismiss" ? permissions.dismiss : true),
}));
vi.mock("../../state/grokBots", () => ({
  grokBotsSecretSubmit: commands.submit,
  grokBotsSecretDismiss: commands.dismiss,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === commands.dismiss ? dismissSecret : submitSecret,
}));

const environmentId = EnvironmentId.make("env-1");
let entrySeq = 0;
// Settled keys live in a module store for the whole session, so each test gets its own entry.
let pendingRequest: GrokBotSecretRequestItem;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  permissions.dismiss = true;
  useHiddenGrokBotSecretRequests.setState({ keys: [] });
  entrySeq += 1;
  pendingRequest = {
    entryId: `entry-${entrySeq}`,
    sessionId: "",
    title: "GitHub token",
    description: "Needed for the release check",
    state: "pending",
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  submitSecret.mockReset();
  dismissSecret.mockReset();
});

function renderPanel(
  requests: ReadonlyArray<GrokBotSecretRequestItem> = [pendingRequest],
  target = { environmentId, botId: "bot-1" },
) {
  act(() => {
    root.render(createElement(GrokBotSecureInputPanel, { ...target, requests }));
  });
}

const field = () => container.querySelector("input") as HTMLInputElement;
const saveButton = () => container.querySelector("button[type=submit]") as HTMLButtonElement;
const dismissButton = () =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Dismiss",
  ) as HTMLButtonElement;

/** Writes through the native setter so React sees an input event, as a real keystroke would. */
function typeSecret(value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setValue?.call(field(), value);
  act(() => {
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitForm() {
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
}

async function clickDismiss() {
  await act(async () => {
    dismissButton().click();
  });
}

const hideButtonOrNull = () =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Hide on this device",
  ) ?? null;

const accepted = { _tag: "Success", value: { accepted: true } };
const failed = (error: unknown) => ({ _tag: "Failure", cause: Cause.fail(error) });

describe("GrokBotSecureInputPanel", () => {
  it("sends the trimmed value for the pending request and closes the card once native accepts", async () => {
    submitSecret.mockResolvedValue(accepted);
    renderPanel();
    expect(saveButton().disabled).toBe(true);

    typeSecret("  s3cret  ");
    expect(saveButton().disabled).toBe(false);
    await submitForm();

    expect(submitSecret).toHaveBeenCalledWith({
      environmentId,
      input: { botId: "bot-1", sessionId: "", entryId: pendingRequest.entryId, value: "s3cret" },
    });
    expect(container.querySelector("input")).toBeNull();
  });

  it("keeps a saved request closed when a stale snapshot still lists it as pending", async () => {
    submitSecret.mockResolvedValue(accepted);
    renderPanel();
    typeSecret("s3cret");
    await submitForm();

    renderPanel([{ ...pendingRequest }]);

    expect(container.querySelector("input")).toBeNull();
  });

  it("closes the card without an error when native says the request is already answered", async () => {
    submitSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "already_answered" })));
    renderPanel();

    typeSecret("hunter2");
    await submitForm();

    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("could not be delivered");
    expect(container.textContent).not.toContain("hunter2");
  });

  it("keeps the card and shows the server copy for a refused save so the user can retry", async () => {
    const refused = new GrokBotSecretError({ reason: "refused" });
    submitSecret.mockResolvedValue(failed(refused));
    renderPanel();

    typeSecret("hunter2");
    await submitForm();

    expect(field().value).toBe("");
    expect(container.textContent).toContain(refused.message);
    expect(container.textContent).not.toContain("hunter2");
    expect(saveButton().disabled).toBe(true);
  });

  it("uses generic copy for an unknown failure so a transport error cannot surface the value", async () => {
    submitSecret.mockResolvedValue(failed(new Error("socket closed while sending hunter2")));
    renderPanel();

    typeSecret("hunter2");
    await submitForm();

    expect(field().value).toBe("");
    expect(container.textContent).toContain("Could not send the secure input. Try again.");
    expect(container.textContent).not.toContain("hunter2");
  });

  it("clears the field and shows generic copy when the submit rejects instead of settling", async () => {
    submitSecret.mockRejectedValue(new Error("pipe broke with hunter2 inside"));
    renderPanel();

    typeSecret("hunter2");
    await submitForm();

    expect(field().value).toBe("");
    expect(saveButton().disabled).toBe(true);
    expect(container.textContent).toContain("Could not send the secure input. Try again.");
    expect(container.textContent).not.toContain("hunter2");
  });

  it("dismisses through native and closes the card once native accepts the dismissal", async () => {
    dismissSecret.mockResolvedValue(accepted);
    renderPanel();

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
      dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason })));
      renderPanel();
      typeSecret("hunter2");
      const input = field();

      await clickDismiss();
      renderPanel([{ ...pendingRequest }]);

      expect(container.innerHTML).toBe("");
      expect(input.value).toBe("");
      expect(submitSecret).not.toHaveBeenCalled();
      expect(dismissSecret).toHaveBeenCalledTimes(1);
    },
  );

  it("hides immediately before native acknowledgment and stays hidden after rejection", async () => {
    let rejectDismiss!: (error: Error) => void;
    dismissSecret.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectDismiss = reject;
        }),
    );
    renderPanel();
    typeSecret("hunter2");
    const input = field();

    await clickDismiss();

    expect(container.innerHTML).toBe("");
    expect(input.value).toBe("");
    expect(localStorage.getItem("t3code:grok-bot-hidden-secret-requests:v1")).not.toContain(
      "hunter2",
    );
    await act(async () => rejectDismiss(new Error("socket closed")));
    renderPanel([{ ...pendingRequest }]);
    expect(container.innerHTML).toBe("");
  });

  it("dismisses with touch activation and ignores a duplicate activation before rerender", async () => {
    dismissSecret.mockResolvedValue(accepted);
    renderPanel();
    typeSecret("hunter2");
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
    submitSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    renderPanel();
    typeSecret("hunter2");
    await submitForm();
    expect(container.textContent).toContain("Grok Bot declined the secure input.");

    await clickDismiss();

    expect(container.innerHTML).toBe("");
  });

  it("does not offer a fallback hide after a save error", async () => {
    submitSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    renderPanel();
    typeSecret("hunter2");
    await submitForm();

    expect(hideButtonOrNull()).toBeNull();
  });

  it("allows local dismissal without native permission", async () => {
    permissions.dismiss = false;
    renderPanel();
    expect(dismissButton().disabled).toBe(false);

    await clickDismiss();

    expect(container.innerHTML).toBe("");
    expect(dismissSecret).not.toHaveBeenCalled();
  });

  it("lists a request repeated within one snapshot only once", () => {
    renderPanel([pendingRequest, { ...pendingRequest }]);

    expect(container.querySelectorAll("input")).toHaveLength(1);
  });

  it("masks the value as a password field, since CSS text-security does not hide it in Firefox", () => {
    renderPanel();

    expect(field().type).toBe("password");
  });

  it("clears the field when the form unmounts before any answer", () => {
    renderPanel();
    typeSecret("abc123");
    const input = field();

    renderPanel([]);

    expect(container.querySelector("input")).toBeNull();
    expect(input.value).toBe("");
  });

  it("does not offer a request the native side has already responded to", () => {
    renderPanel([{ ...pendingRequest, state: "responded" }]);

    expect(container.querySelector("input")).toBeNull();
  });

  it("persists dismissal across storage rehydration and remount without any hidden row", async () => {
    dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "unsupported" })));
    renderPanel();
    await clickDismiss();
    const persisted = localStorage.getItem("t3code:grok-bot-hidden-secret-requests:v1");
    expect(persisted).toContain(pendingRequest.entryId);

    act(() => root.unmount());
    // Rehydrate from the saved browser storage, as a page reload would.
    useHiddenGrokBotSecretRequests.setState({ keys: [] });
    localStorage.setItem("t3code:grok-bot-hidden-secret-requests:v1", persisted!);
    await useHiddenGrokBotSecretRequests.persist.rehydrate();
    root = createRoot(container);
    renderPanel();

    expect(container.innerHTML).toBe("");
  });

  it("isolates dismissal by bot, environment, and session while leaving new requests visible", async () => {
    dismissSecret.mockResolvedValue(accepted);
    renderPanel();
    await clickDismiss();
    expect(container.innerHTML).toBe("");

    renderPanel([pendingRequest], { environmentId, botId: "other-bot" });
    expect(field()).not.toBeNull();
    renderPanel([pendingRequest], {
      environmentId: EnvironmentId.make("other-account"),
      botId: "bot-1",
    });
    expect(field()).not.toBeNull();
    renderPanel([{ ...pendingRequest, sessionId: "other-session" }]);
    expect(field()).not.toBeNull();
    renderPanel([pendingRequest, { ...pendingRequest, entryId: "new-request" }]);
    expect(container.querySelectorAll("input")).toHaveLength(1);
    renderPanel([pendingRequest]);
    expect(container.innerHTML).toBe("");
  });
});
