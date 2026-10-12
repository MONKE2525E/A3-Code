import { expect, it } from "@effect/vitest";
import { decodeGrokBotWidget, waitingWidget } from "./GrokBotWidget.ts";

// Shape verified against native transcript entries and the native question renderer.
const card = {
  kind: "send-message",
  id: "test-question",
  requestId: "native-request",
  message: {
    type: "widget",
    widget: {
      prompt: "What should I tackle next?",
      helpText: "UI test. Pick anything.",
      allowCustom: true,
      options: [
        {
          label: "T3 polish",
          value: "polish",
          description: "Approvals, diffs, wake hooks",
          style: "primary",
        },
        { label: "Dot setup", value: "setup" },
        { label: "Nothing, just testing", value: "nothing" },
      ],
    },
  },
};

it("recognizes the native question payload without requiring a T3 question tool", () => {
  const widget = decodeGrokBotWidget(card);
  expect(widget?.state).toBe("waiting");
  expect(widget?.options.map((option) => option.value)).toEqual(["polish", "setup", "nothing"]);
  expect(waitingWidget([card])?.entryId).toBe(card.id);
});

it.each([
  [{ respondedValue: "polish" }, "responded"],
  [{ respondedValue: "" }, "responded"],
  [{ widgetDismissed: true }, "dismissed"],
  [{ widgetSkipped: true }, "dismissed"],
] as const)("reads native entry-level settlement %j", (settlement, state) => {
  const entry = { ...card, ...settlement };
  expect(decodeGrokBotWidget(entry)?.state).toBe(state);
  expect(waitingWidget([card, entry])).toBeUndefined();
});
