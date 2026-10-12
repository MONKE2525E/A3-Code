import type { GrokBotMessage } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { groupGrokBotReactions } from "./grokBotConversation";

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
      {groups.map((group) => (
        <li
          key={group.emoji}
          className="flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-0.5 text-xs leading-4"
        >
          <span>{group.emoji}</span>
          {group.count > 1 ? (
            <span className="text-muted-foreground tabular-nums">{group.count}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
