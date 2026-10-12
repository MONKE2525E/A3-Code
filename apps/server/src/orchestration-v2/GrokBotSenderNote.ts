import { grokBotAgentStamp } from "@t3tools/contracts";

const MAX_TITLE_LENGTH = 160;

/**
 * Stamps a message a T3 agent sent to a Grok bot with the sending agent's name. The native send
 * carries only text, so this line is how the bot learns the sender, and the chat view labels it.
 */
export function grokBotSenderNote(title: string | undefined): string {
  const text = title?.replaceAll(/\s+/g, " ").trim() ?? "";
  const name =
    text.length === 0
      ? "another T3 agent"
      : text.length > MAX_TITLE_LENGTH
        ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…`
        : text;
  return grokBotAgentStamp(name);
}
