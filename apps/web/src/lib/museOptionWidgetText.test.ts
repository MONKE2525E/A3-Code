import { describe, expect, it } from "@effect/vitest";
import { museOptionWidgetText } from "./museOptionWidgetText";

const id = "widget-337c44f0-e5c2-4f59-b902-1b79b863dcda";
describe("Muse option presentation tokens", () => {
  it("extracts native UUID widgets while keeping the surrounding reply", () => {
    expect(museOptionWidgetText(`Choose a next step.\n[[hatch_widget:${id}]]`)).toEqual({
      widgetIds: [id],
      text: "Choose a next step.",
    });
  });
  it("preserves inline examples and malformed widget IDs", () => {
    for (const text of [
      `Example [[hatch_widget:${id}]] here`,
      "[[hatch_widget:widget-example]]",
      "[[hatch_widget:widget-337c44f0-e5c2-4f59-b902]]",
    ])
      expect(museOptionWidgetText(text)).toEqual({ widgetIds: [], text });
  });
});
