import type { MuseAgentOptionSelection, MuseAgentOptionWidget } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192));
const State = Schema.Struct({
  version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  data: Schema.Struct({ selectedText: Schema.optionalKey(Schema.NullOr(Text)) }),
});
const Widget = Schema.Struct({
  kind: Schema.Literal("option"),
  widget_id: Id,
  data: Schema.Struct({
    options: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
    button_style: Schema.optionalKey(Schema.Literals(["dotted_lines", "center_aligned_filled"])),
    custom_input: Schema.optionalKey(Schema.Struct({ placeholder: Schema.optionalKey(Text) })),
  }),
  state: Schema.optionalKey(State),
});
const Row = Schema.Struct({
  event_name: Schema.String,
  message_id: Schema.optionalKey(Schema.NullOr(Id)),
  session_id: Schema.optionalKey(Id),
  transcript_surface: Schema.optionalKey(Schema.String),
  payload: Schema.Struct({
    message_id: Schema.optionalKey(Id),
    session_id: Schema.optionalKey(Id),
    transcript_surface: Schema.optionalKey(Schema.String),
    stream_lane: Schema.optionalKey(Schema.String),
    widgets: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
});
const decodeRow = Schema.decodeUnknownOption(Row);
const decodeWidget = Schema.decodeUnknownOption(Widget);

/** Native history owns widget definitions and their versioned one-shot selection state. */
export function museOptionWidgets(
  events: readonly unknown[],
  sessionId: string,
): MuseAgentOptionWidget[] {
  const result = new Map<string, MuseAgentOptionWidget>();
  for (const raw of events) {
    const decoded = decodeRow(raw);
    if (Option.isNone(decoded)) continue;
    const row = decoded.value;
    const payload = row.payload;
    if (
      row.event_name !== "message.assistant" ||
      (row.session_id ?? payload.session_id) !== sessionId ||
      (row.transcript_surface ?? payload.transcript_surface ?? "main_chat") !== "main_chat" ||
      (payload.stream_lane && payload.stream_lane !== "main")
    )
      continue;
    const hostMessageId = row.message_id ?? payload.message_id;
    if (!hostMessageId) continue;
    for (const rawWidget of payload.widgets ?? []) {
      const widget = decodeWidget(rawWidget);
      if (Option.isNone(widget)) continue;
      const native = widget.value;
      const options = native.data.options;
      const normalized = options.map((text) => text.trim().split(/\s+/).join(" "));
      if (normalized.some((text) => !text) || new Set(normalized).size !== normalized.length)
        continue;
      const selectedText = native.state?.data.selectedText ?? null;
      if (selectedText !== null && !options.includes(selectedText) && !native.data.custom_input)
        continue;
      result.set(`${hostMessageId}:${native.widget_id}`, {
        widgetId: native.widget_id,
        hostMessageId,
        options,
        buttonStyle: native.data.button_style ?? "dotted_lines",
        allowCustomInput: native.data.custom_input !== undefined,
        selectedText,
        version: native.state?.version ?? 0,
      });
    }
  }
  return [...result.values()];
}

export function museSelectableOption(
  widgets: readonly MuseAgentOptionWidget[],
  selection: MuseAgentOptionSelection,
) {
  const widget = widgets.find(
    (item) =>
      item.widgetId === selection.widgetId && item.hostMessageId === selection.hostMessageId,
  );
  if (
    !widget ||
    widget.selectedText !== null ||
    (!widget.options.includes(selection.text) && !widget.allowCustomInput)
  )
    return null;
  return widget;
}
