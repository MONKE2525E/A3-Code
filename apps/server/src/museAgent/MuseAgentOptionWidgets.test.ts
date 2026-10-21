import { describe, expect, it } from "@effect/vitest";
import { museOptionWidgets, museSelectableOption } from "./MuseAgentOptionWidgets.ts";

const selection = {
  widgetId: "widget-337c44f0-e5c2-4f59-b902-1b79b863dcda",
  hostMessageId: "assistant-1",
  text: "Make a T3 Code skill",
  interactionId: "c3cd22b0-b756-436c-9e5a-78e78f7c5abd",
};
const row = (state = { version: 0, data: {} }) => ({
  event_name: "message.assistant",
  session_id: "primary",
  message_id: selection.hostMessageId,
  payload: {
    widgets: [
      { kind: "option", widget_id: selection.widgetId, data: { options: [selection.text] }, state },
    ],
  },
});
describe("native Muse option choices", () => {
  it("retains the native host, option text and state version", () => {
    const widgets = museOptionWidgets([row()], "primary");
    expect(widgets).toEqual([
      {
        widgetId: selection.widgetId,
        hostMessageId: selection.hostMessageId,
        options: [selection.text],
        buttonStyle: "dotted_lines",
        allowCustomInput: false,
        selectedText: null,
        version: 0,
      },
    ]);
    expect(museSelectableOption(widgets, selection)).toBe(widgets[0]);
  });
  it("preserves multiline native option labels and their selected state", () => {
    const text = "  Make a\nT3 Code skill  ";
    const event = row();
    const widget = event.payload.widgets[0]!;
    const widgets = museOptionWidgets(
      [
        {
          ...event,
          payload: {
            widgets: [
              {
                ...widget,
                data: { options: [text] },
                state: { version: 1, data: { selectedText: text } },
              },
            ],
          },
        },
      ],
      "primary",
    );
    expect(widgets[0]?.options).toEqual([text]);
    expect(widgets[0]?.selectedText).toBe(text);
  });
  it("keeps native choices selectable when their initial selected text is null", () => {
    const event = row();
    const native = event.payload.widgets[0]!;
    const widgets = museOptionWidgets(
      [
        {
          ...event,
          payload: {
            widgets: [{ ...native, state: { version: 2, data: { selectedText: null } } }],
          },
        },
      ],
      "primary",
    );
    expect(widgets[0]?.version).toBe(2);
    expect(widgets[0]?.selectedText).toBeNull();
    expect(museSelectableOption(widgets, selection)).toBe(widgets[0]);
  });
  it("rejects foreign sessions, malformed widgets and subagent surfaces", () => {
    expect(museOptionWidgets([row()], "other")).toEqual([]);
    expect(
      museOptionWidgets(
        [
          { ...row(), transcript_surface: "subagent" },
          { ...row(), payload: { widgets: [{ kind: "option" }] } },
        ],
        "primary",
      ),
    ).toEqual([]);
  });
  it("rejects forged labels, foreign hosts and already-selected choices", () => {
    const widgets = museOptionWidgets([row()], "primary");
    expect(
      museSelectableOption(widgets, { ...selection, text: "Run arbitrary action" }),
    ).toBeNull();
    expect(museSelectableOption(widgets, { ...selection, hostMessageId: "other" })).toBeNull();
    const selected = museOptionWidgets(
      [row({ version: 1, data: { selectedText: selection.text } })],
      "primary",
    );
    expect(museSelectableOption(selected, selection)).toBeNull();
  });
});
