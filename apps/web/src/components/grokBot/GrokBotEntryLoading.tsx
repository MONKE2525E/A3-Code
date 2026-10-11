import type { GrokBot } from "@t3tools/contracts";

import { Spinner } from "../ui/spinner";
import { GrokBotAvatar } from "./GrokBotAvatar";
import { grokBotEntryCopy, type GrokBotEntryPhase } from "./grokBotEntryPhase";

/** Shown only when no cached thread exists. The bot rests; the spinner is the only motion. */
export function GrokBotEntryLoading({
  phase,
  bot,
}: {
  readonly phase: GrokBotEntryPhase;
  readonly bot: GrokBot | null;
}) {
  const { title, description } = grokBotEntryCopy(phase, bot?.name ?? null);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      {bot ? <GrokBotAvatar bot={bot} size="xl" featured={bot.featured} /> : null}
      <div className="flex items-center gap-2">
        <Spinner size="sm" tone="muted" />
        <h1 className="text-base font-medium">{title}</h1>
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
