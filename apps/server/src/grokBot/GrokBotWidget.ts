/**
 * Widget question cards in the Grok Bot transcript (`kind: "send-message"`,
 * `message.type: "widget"`). Only the latest widget with options can be waiting for the user;
 * an older one that was never answered is superseded by the bot moving on.
 */

export interface GrokBotWidgetOption {
  readonly label: string;
  readonly description: string | undefined;
  readonly value: string | undefined;
}

export interface GrokBotWidget {
  readonly entryId: string;
  readonly prompt: string;
  readonly options: readonly GrokBotWidgetOption[];
  readonly multiSelect: boolean;
  readonly allowCustom: boolean;
  /** `waiting` is the only state the user can still answer. */
  readonly state: "waiting" | "responded" | "dismissed";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 4096) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : undefined;

function decodeOption(value: unknown): GrokBotWidgetOption | undefined {
  if (!isRecord(value)) return undefined;
  const label = text(value.label, 1024);
  if (label === undefined) return undefined;
  return {
    label,
    description: text(value.description, 4096),
    // Native uses value ?? label; an empty value must not become the label.
    value: typeof value.value === "string" && value.value.length <= 4096 ? value.value : undefined,
  };
}

export function decodeGrokBotWidget(value: unknown): GrokBotWidget | undefined {
  if (!isRecord(value) || value.kind !== "send-message") return undefined;
  if (!isRecord(value.message) || value.message.type !== "widget") return undefined;
  const widget = value.message.widget;
  if (!isRecord(widget)) return undefined;
  const entryId = text(value.id, 1024);
  const prompt = text(widget.prompt);
  if (entryId === undefined || prompt === undefined || !Array.isArray(widget.options)) {
    return undefined;
  }
  const options = widget.options.flatMap((option) => {
    const decoded = decodeOption(option);
    return decoded === undefined ? [] : [decoded];
  });
  if (options.length === 0) return undefined;
  // Native stores the answer and dismissal on the transcript entry, alongside `message`.
  const state =
    value.respondedValue !== undefined && value.respondedValue !== null
      ? "responded"
      : value.widgetDismissed === true || value.widgetSkipped === true
        ? "dismissed"
        : "waiting";
  return {
    entryId,
    prompt,
    options,
    multiSelect: widget.multiSelect === true,
    allowCustom: widget.allowCustom === true,
    state,
  };
}

/** The widget the transcript is currently asking, or undefined when no widget is waiting. */
export function waitingWidget(entries: readonly unknown[]): GrokBotWidget | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const widget = decodeGrokBotWidget(entries[index]);
    if (widget !== undefined) return widget.state === "waiting" ? widget : undefined;
  }
  return undefined;
}
