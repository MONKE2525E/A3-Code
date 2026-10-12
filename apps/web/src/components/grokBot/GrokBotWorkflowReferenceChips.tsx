import type { GrokBotWorkflowReferences } from "@t3tools/contracts";
import { GraduationCapIcon } from "lucide-react";

/**
 * Native workflow chips on a transcript message (e.g. "Learn from demonstration"). They are
 * display metadata only: the native app already acted on them, so T3 never re-sends them.
 */
export function GrokBotWorkflowReferenceChips({
  references,
}: {
  readonly references: GrokBotWorkflowReferences;
}) {
  if (references.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" data-grok-bot-workflow-references="true">
      {references.map((reference) => (
        <span
          key={reference.id}
          data-grok-bot-workflow-reference={reference.id}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/80 bg-background/70 px-2 py-0.5 text-xs text-muted-foreground"
        >
          <GraduationCapIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{reference.label}</span>
        </span>
      ))}
    </div>
  );
}
