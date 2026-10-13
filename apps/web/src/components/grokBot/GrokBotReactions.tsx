import type { GrokBotMessage } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { grokBotReactionTitle, groupGrokBotReactions } from "./grokBotConversation";

export function GrokBotReactions({
  reactions,
  className,
}: {
  readonly reactions: (typeof GrokBotMessage.Type)["reactions"];
  readonly className?: string;
}) {
  const groups = groupGrokBotReactions(reactions);
  if (groups.length === 0) return null;
  return (
    <ul aria-label="Reactions" className={cn("flex flex-wrap gap-1", className)}>
      {groups.map((group) => {
        const title = grokBotReactionTitle(reactions, group.emoji);
        return (
          <li key={group.emoji}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="flex h-6 items-center gap-1 rounded-full border border-border bg-muted px-2 text-sm leading-5" />
                }
              >
                <span>{group.emoji}</span>
                {group.count > 1 ? (
                  <span className="text-xs text-muted-foreground tabular-nums">{group.count}</span>
                ) : null}
                <span className="sr-only">{title}</span>
              </TooltipTrigger>
              <TooltipPopup>{title}</TooltipPopup>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
