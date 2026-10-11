// @vitest-environment jsdom

import { EnvironmentId, GrokBotSecretError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GrokBotSecureInputPanel } from "./GrokBotSecureInputPanel";
import type { GrokBotSecretRequestItem } from "./grokBotSecretRequest";

const { submitSecret, dismissSecret, commands } = vi.hoisted(() => ({
  submitSecret: vi.fn(),
  dismissSecret: vi.fn(),
  commands: {
    submit: { permissionAtom: () => ({}) },
    dismiss: { permissionAtom: () => ({}) },
  },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
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

function renderPanel(requests: ReadonlyArray<GrokBotSecretRequestItem> = [pendingRequest]) {
  act(() => {
    root.render(
      createElement(GrokBotSecureInputPanel, { environmentId, botId: "bot-1", requests }),
    );
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
const hideButton = () => hideButtonOrNull() as HTMLButtonElement;

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

  it("keeps a dismissal that native refused visible with dismissal copy, so it can be retried", async () => {
    dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    renderPanel();

    await clickDismiss();

    expect(container.querySelector("input")).not.toBeNull();
    expect(container.textContent).toContain("Grok Bot did not confirm the dismissal.");
    expect(container.textContent).not.toContain("could not be delivered");
    expect(dismissButton().disabled).toBe(false);
  });

  it("hides a request on this device after native refuses the dismissal, without calling native again", async () => {
    dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "unavailable" })));
    renderPanel();
    await clickDismiss();

    await act(async () => {
      hideButton().click();
    });

    expect(container.querySelector("input")).toBeNull();
    expect(dismissSecret).toHaveBeenCalledTimes(1);
    expect(submitSecret).not.toHaveBeenCalled();
  });

  it("keeps a locally hidden request hidden when a later snapshot still lists it as pending", async () => {
    dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    renderPanel();
    await clickDismiss();
    await act(async () => {
      hideButton().click();
    });

    renderPanel([{ ...pendingRequest }]);

    expect(container.querySelector("input")).toBeNull();
  });

  it("shows the save error under the save action and clears it once a dismissal fails", async () => {
    submitSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    dismissSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    renderPanel();
    typeSecret("hunter2");
    await submitForm();
    expect(container.textContent).toContain("Grok Bot declined the secure input.");

    await clickDismiss();

    expect(container.textContent).not.toContain("Grok Bot declined the secure input.");
    expect(container.textContent).toContain("Grok Bot did not confirm the dismissal.");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("offers the local hide only after a dismissal fails, not after a save error", async () => {
    submitSecret.mockResolvedValue(failed(new GrokBotSecretError({ reason: "refused" })));
    renderPanel();
    typeSecret("hunter2");
    await submitForm();

    expect(hideButtonOrNull()).toBeNull();
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

  describe("unsupported dismissal", () => {
    const unsupported = () => failed(new GrokBotSecretError({ reason: "unsupported" }));
    const buttonByText = (text: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === text,
      ) as HTMLButtonElement | undefined;
    const hiddenRow = () => container.querySelector("[role=status]");

    it("hides the card locally in one click, clearing the typed value, with no delivery or dismissal copy", async () => {
      dismissSecret.mockResolvedValue(unsupported());
      renderPanel();
      typeSecret("hunter2");
      const input = field();

      await clickDismiss();

      expect(dismissSecret).toHaveBeenCalledTimes(1);
      expect(submitSecret).not.toHaveBeenCalled();
      expect(container.querySelector("input")).toBeNull();
      expect(input.value).toBe("");
      expect(hiddenRow()?.textContent).toContain(
        "Hidden on this device. The bot may still be waiting.",
      );
      expect(container.textContent).not.toContain("dismissed");
      expect(container.textContent).not.toContain("hunter2");
    });

    it("moves focus to Undo after the hide so keyboard focus does not fall to the page body", async () => {
      dismissSecret.mockResolvedValue(unsupported());
      renderPanel();

      await clickDismiss();

      expect(document.activeElement).toBe(buttonByText("Undo"));
    });

    it("restores the card on Undo and focuses its field", async () => {
      dismissSecret.mockResolvedValue(unsupported());
      renderPanel();
      await clickDismiss();

      await act(async () => {
        buttonByText("Undo")?.click();
      });

      expect(field()).not.toBeNull();
      expect(document.activeElement).toBe(field());
      expect(hiddenRow()).toBeNull();
    });

    it("keeps a hidden request out of the panel after a remount, and shows it again on Show requests", async () => {
      dismissSecret.mockResolvedValue(unsupported());
      renderPanel();
      await clickDismiss();

      // A reload remounts the panel with the same native snapshot; only the count is shown.
      act(() => root.unmount());
      root = createRoot(container);
      renderPanel();

      expect(field()).toBeNull();
      expect(hiddenRow()?.textContent).toContain("1 secure input hidden on this device.");
      expect(buttonByText("Undo")).toBeUndefined();

      await act(async () => {
        buttonByText("Show requests")?.click();
      });

      expect(field()).not.toBeNull();
      expect(hiddenRow()).toBeNull();
    });

    it("counts only hidden requests native still lists as pending", async () => {
      dismissSecret.mockResolvedValue(unsupported());
      renderPanel();
      await clickDismiss();

      renderPanel([{ ...pendingRequest, state: "responded" }]);

      expect(hiddenRow()).toBeNull();
    });
  });
});
