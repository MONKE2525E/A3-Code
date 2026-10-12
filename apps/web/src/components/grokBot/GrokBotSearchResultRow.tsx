import { memo } from "react";

import { cn } from "~/lib/utils";

import type { GrokBotSearchHit } from "../CommandPalette.logic";
import { ThreadSearchMatchExcerpt } from "../ThreadSearchMatch";
import { GrokBotAvatar } from "./GrokBotAvatar";

/** A sidebar search row for a bot conversation, shaped like the thread rows it sits beside. */
export const GrokBotSearchResultRow = memo(function GrokBotSearchResultRow(props: {
  hit: GrokBotSearchHit;
  isHighlighted: boolean;
  resultId: string;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
}) {
  const { hit } = props;
  return (
    <li role="presentation" className="list-none">
      <button
        id={props.resultId}
        type="button"
        role="option"
        // Focus stays on the search input, which owns keyboard navigation for the listbox.
        tabIndex={-1}
        aria-selected={props.isHighlighted}
        aria-label={`Grok Bot conversation with ${hit.bot.name}`}
        onMouseMove={props.onHighlight}
        onClick={props.onSelect}
        className={cn(
          "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
          props.isHighlighted
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <GrokBotAvatar bot={hit.bot} size="xs" environmentId={hit.environmentId} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate">{hit.bot.name}</span>
          <ThreadSearchMatchExcerpt
            match={{ source: hit.source, snippet: hit.snippet, query: props.searchQuery }}
          />
        </span>
      </button>
    </li>
  );
});
