import { GrokBotWorkflowReferences } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeReferences = Schema.decodeUnknownOption(GrokBotWorkflowReferences);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Keep native workflow chips, including Teach's exact scope, without interpreting their content. */
export function grokBotWorkflowReferences(richText: unknown): GrokBotWorkflowReferences {
  let value = richText;
  if (typeof value === "string") {
    if (value.length > 262144) return [];
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const document = record(value);
  if (document?.type !== "doc" || !Array.isArray(document.content)) return [];
  const references: GrokBotWorkflowReferences[number][] = [];
  const pending: unknown[] = document.content.slice(0, 4096);
  let visited = 0;
  while (pending.length > 0 && visited++ < 4096 && references.length < 64) {
    const node = record(pending.shift());
    if (node === undefined) continue;
    if (node.type === "workflowReference") {
      const attrs = record(node.attrs);
      const decoded = decodeReferences([
        {
          id: attrs?.id,
          label: attrs?.label,
          ...(attrs?.teachQueueScope === undefined
            ? {}
            : { teachQueueScope: attrs.teachQueueScope }),
        },
      ]);
      if (Option.isSome(decoded)) references.push(...decoded.value);
    }
    if (Array.isArray(node.content)) pending.push(...node.content.slice(0, 4096 - visited));
  }
  return references;
}
