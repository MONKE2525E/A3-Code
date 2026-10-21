const WIDGET_MARKER =
  /^[\t ]*\[\[hatch_widget:(widget-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]\][\t ]*\r?$/gim;

/** Standalone protocol tokens become native controls; inline examples remain readable prose. */
export function museOptionWidgetText(text: string) {
  const widgetIds: string[] = [];
  const visibleText = text.replace(WIDGET_MARKER, (_marker, widgetId: string) => {
    widgetIds.push(widgetId);
    return "";
  });
  return { widgetIds, text: widgetIds.length ? visibleText.trimEnd() : text };
}
