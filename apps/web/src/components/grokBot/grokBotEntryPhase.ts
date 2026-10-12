import type { GrokBot } from "@t3tools/contracts";

export type GrokBotEntryPhase = "connecting" | "finding" | "opening";

/** What an uncached bot entry is waiting on, so the loading screen names the real step. */
export function grokBotEntryPhase(input: {
  readonly readinessPending: boolean;
  readonly bot: GrokBot | null;
}): GrokBotEntryPhase {
  if (input.readinessPending) return "connecting";
  return input.bot === null ? "finding" : "opening";
}

export function grokBotEntryCopy(
  phase: GrokBotEntryPhase,
  botName: string | null,
): { readonly title: string; readonly description: string } {
  switch (phase) {
    case "connecting":
      return {
        title: "Connecting to Grok Bot",
        description: "Checking the bot provider on this environment.",
      };
    case "finding":
      return {
        title: "Finding your bot",
        description: "Loading the bot list from this environment.",
      };
    case "opening":
      return {
        title: botName ? `Opening ${botName}` : "Opening chat",
        description: "Finding this bot's chat on the server. Nothing is sent to the bot.",
      };
  }
}
