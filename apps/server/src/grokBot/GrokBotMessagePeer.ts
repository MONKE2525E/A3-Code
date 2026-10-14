import { TrimmedNonEmptyString, type OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodePeer = Schema.decodeUnknownOption(
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
    name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
    kind: Schema.optionalKey(Schema.String),
  }),
);

/** Native peer messages keep the sending or receiving bot's stable ID for navigation. */
export function grokBotMessagePeer(
  currentBotId: string,
  entry: { readonly fromAgent?: unknown; readonly toAgent?: unknown },
): OrchestrationV2ConversationMessage["grokBotPeer"] {
  for (const direction of ["from", "to"] as const) {
    const decoded = decodePeer(direction === "from" ? entry.fromAgent : entry.toAgent);
    if (Option.isNone(decoded) || decoded.value.id === currentBotId) continue;
    const kind = decoded.value.kind;
    return {
      botId: decoded.value.id,
      name: decoded.value.name || decoded.value.id,
      direction,
      ...(kind === "agent" || kind === "cloud-agent" ? { kind } : {}),
    };
  }
  return undefined;
}

/** Native group replies name the member independently of peer exchange routing. */
export function grokBotMessageAuthor(
  author: unknown,
): OrchestrationV2ConversationMessage["grokBotAuthor"] {
  const decoded = decodePeer(author);
  return Option.isNone(decoded)
    ? undefined
    : { botId: decoded.value.id, name: decoded.value.name || decoded.value.id };
}
