import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

import { MuseAgentAvatar } from "./MuseAgentAvatar";
import { type MuseAgentNotice } from "./aiAgents";

/** The native Muse personal agent as a roster row, shaped like a Grok Bot row. */
export function MuseAgentSidebarRow(props: {
  readonly name: string;
  readonly imageUrl?: string | null | undefined;
  readonly videoUrl?: string | null | undefined;
  readonly active: boolean;
  readonly selected: boolean;
  readonly disabled?: boolean;
  /** Opening is in flight; the row stays disabled so repeat clicks cannot queue. */
  readonly pending?: boolean;
  /** Short inline failure from the last open attempt, retried through `onOpen`. */
  readonly error?: string | null | undefined;
  readonly onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "group/sidebar-row relative w-full overflow-hidden rounded-md text-sidebar-foreground",
        props.selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        aria-current={props.selected ? "page" : undefined}
        disabled={props.disabled || props.pending}
        aria-busy={props.pending || undefined}
        className="relative z-10 flex h-[3.375rem] w-full min-w-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 items-center gap-2 pl-(--sidebar-row-content-inset) pr-2 py-(--sidebar-content-inset) text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={props.onOpen}
      >
        <MuseAgentAvatar
          name={props.name}
          imageUrl={props.imageUrl}
          videoUrl={props.videoUrl}
          active={props.active}
          size="lg"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.name}</span>
        <span className="shrink-0 rounded-full bg-sidebar-control-surface px-2 py-0.5 text-xs leading-4 text-secondary-label">
          Muse
        </span>
        {props.pending ? (
          <span role="status" className="shrink-0 text-xs text-sidebar-muted-foreground">
            Opening…
          </span>
        ) : null}
        {props.active ? (
          <span role="status" className="sr-only">
            Working
          </span>
        ) : null}
      </button>
      {props.error && !props.pending ? (
        <div className="relative z-10 flex items-center gap-2 pl-(--sidebar-row-content-inset) pr-2 pb-2">
          <p role="alert" className="min-w-0 flex-1 text-xs leading-4.5 text-destructive">
            {props.error}
          </p>
          <Button size="xs" variant="outline" onClick={props.onOpen}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Setup guidance for native Muse; shown only when detection says it is not ready. */
export function MuseAgentSetupNotice(props: {
  readonly notice: Exclude<MuseAgentNotice, { kind: "ready" }>;
  readonly onAction: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-2 py-2">
      <p className="text-xs leading-4.5 text-sidebar-muted-foreground">{props.notice.message}</p>
      {props.notice.actionLabel ? (
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={props.onAction}>
            {props.notice.actionLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
