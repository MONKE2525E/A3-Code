import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { museAgentFeatureUpdate, museAgentOptionWidgetsQuery } from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export function MuseAgentOptionWidgets({
  threadRef,
  messageId,
  isStreaming,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly messageId: string;
  readonly isStreaming: boolean;
}) {
  const shell = useThreadShell(threadRef);
  if (!shell) return null;
  return (
    <OptionWidgets
      key={messageId}
      threadRef={threadRef}
      messageId={messageId}
      isStreaming={isStreaming}
      providerInstanceId={shell.modelSelection.instanceId}
    />
  );
}

function OptionWidgets({
  threadRef,
  messageId,
  isStreaming,
  providerInstanceId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly messageId: string;
  readonly isStreaming: boolean;
  readonly providerInstanceId: NonNullable<
    ReturnType<typeof useThreadShell>
  >["modelSelection"]["instanceId"];
}) {
  const view = useEnvironmentQuery(
    museAgentOptionWidgetsQuery({
      environmentId: threadRef.environmentId,
      input: { operation: "option_widgets", providerInstanceId, threadId: threadRef.threadId },
    }),
  );
  const { refresh } = view;
  useEffect(() => {
    // Native history can acquire the widget after its marker starts streaming.
    if (!isStreaming) refresh();
  }, [isStreaming, refresh]);
  const canSelect = useAtomValue(
    museAgentFeatureUpdate.permissionAtom(threadRef.environmentId, { operation: "option_select" }),
  );
  const submit = useAtomCommand(museAgentFeatureUpdate);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const widgets =
    view.data?.operation === "option_widgets"
      ? view.data.data.filter((widget) => widget.messageId === messageId)
      : [];
  if (!widgets.length)
    return (
      <p
        role={view.isPending || isStreaming ? "status" : undefined}
        className="mt-2 text-sm text-muted-foreground"
      >
        {view.isPending || isStreaming
          ? "Loading Muse choices…"
          : view.error
            ? "Muse choices could not load. Reopen the conversation to try again."
            : "This Muse choice is no longer available."}
      </p>
    );
  return (
    <div className="mt-3 grid gap-2">
      {widgets.map((widget) => (
        <div key={widget.widgetId} className="grid gap-2">
          {widget.options.map((text) => (
            <button
              type="button"
              key={text}
              className={
                widget.buttonStyle === "dotted_lines"
                  ? "whitespace-pre-wrap rounded-lg border border-dashed px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-ring"
                  : "whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-center text-sm hover:bg-accent disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-ring"
              }
              disabled={
                !canSelect ||
                pending ||
                widget.selectedText !== null ||
                submitted[widget.widgetId] !== undefined
              }
              aria-pressed={widget.selectedText === text}
              onClick={async () => {
                if (
                  pending ||
                  !canSelect ||
                  widget.selectedText !== null ||
                  submitted[widget.widgetId] !== undefined
                )
                  return;
                setPending(true);
                setError(null);
                const result = await submit({
                  environmentId: threadRef.environmentId,
                  input: {
                    operation: "option_select",
                    providerInstanceId,
                    threadId: threadRef.threadId,
                    selection: {
                      widgetId: widget.widgetId,
                      hostMessageId: widget.hostMessageId,
                      text,
                      interactionId: randomUUID(),
                    },
                  },
                });
                setPending(false);
                view.refresh();
                if (result._tag === "Success")
                  setSubmitted((previous) => ({ ...previous, [widget.widgetId]: text }));
                else
                  setError(
                    "Muse could not accept this choice. Refresh the conversation before trying again.",
                  );
              }}
            >
              {text}
              {widget.selectedText === text ? " ✓" : ""}
            </button>
          ))}
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
