import {
  ChevronDownIcon,
  ChevronUpIcon,
  EllipsisIcon,
  EyeOffIcon,
  HistoryIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import type { AgentStatusDot } from "./agentStatusDot";

/**
 * One agent in the AI Agents roster. Grok Bots and native Muse both render through these
 * primitives, so a row, a pinned tile, its menu, and its status dot look and behave the same.
 * Each agent supplies its own avatar and actions.
 */
export function AgentRosterRow(props: {
  readonly name: string;
  readonly label?: string | null | undefined;
  readonly avatar: ReactNode;
  readonly selected: boolean;
  readonly statusDot: AgentStatusDot | null;
  /** Live tool or progress text for screen readers; the visible row stays quiet. */
  readonly statusText?: string | null | undefined;
  readonly menu?: ReactNode;
  /** A chevron that shows or hides the row's own children, such as a list of conversations. */
  readonly disclosure?: { readonly expanded: boolean; readonly onToggle: () => void } | undefined;
  readonly disabled?: boolean;
  /** Opening is in flight; the row stays disabled so repeat clicks cannot queue. */
  readonly pending?: boolean;
  readonly pendingLabel?: string;
  /** Extra content under the row, outside its highlight, such as an inline error with a retry. */
  readonly footer?: ReactNode;
  readonly onOpen: () => void;
}) {
  return (
    <div>
      <div
        className={cn(
          "group/sidebar-row group/agent relative w-full overflow-hidden rounded-md text-sidebar-foreground",
          props.selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <button
          type="button"
          aria-current={props.selected ? "page" : undefined}
          disabled={props.disabled || props.pending}
          aria-busy={props.pending || undefined}
          className={cn(
            "relative z-10 flex h-[3.375rem] w-full min-w-0 cursor-pointer items-center gap-2 pl-(--sidebar-row-content-inset) py-(--sidebar-content-inset) text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
            props.disclosure ? "pr-16" : "pr-8.5",
          )}
          onClick={props.onOpen}
        >
          {props.avatar}
          <span className="flex h-5 min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <span className="min-w-0 max-w-full shrink-0 truncate text-sm font-medium">
              {props.name}
            </span>
            {props.label ? (
              <span className="min-w-0 shrink truncate rounded-full bg-sidebar-control-surface px-2 py-0.5 text-xs leading-4 text-secondary-label">
                {props.label}
              </span>
            ) : null}
          </span>
          {props.pending ? (
            <span role="status" className="shrink-0 text-xs text-sidebar-muted-foreground">
              {props.pendingLabel ?? "Opening…"}
            </span>
          ) : null}
          <AgentStatusText statusDot={props.statusDot} />
        </button>
        {props.statusText ? (
          <span role="status" className="sr-only">
            {props.statusText}
          </span>
        ) : null}
        {props.disclosure ? (
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={props.disclosure.expanded ? "Hide conversations" : "Show conversations"}
            aria-expanded={props.disclosure.expanded}
            className="absolute top-1/2 right-8 z-20 -translate-y-1/2"
            onClick={props.disclosure.onToggle}
          >
            {props.disclosure.expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </Button>
        ) : null}
        {props.menu}
      </div>
      {props.footer}
    </div>
  );
}

/** A pinned agent: avatar and name stacked, in the grid above the rest of the roster. */
export function AgentPinnedTile(props: {
  readonly name: string;
  readonly label?: string | null | undefined;
  readonly avatar: ReactNode;
  readonly selected: boolean;
  readonly statusDot: AgentStatusDot | null;
  readonly statusText?: string | null | undefined;
  readonly menu?: ReactNode;
  readonly onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "group/sidebar-row group/agent relative rounded-md text-sidebar-foreground",
        props.selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        aria-current={props.selected ? "page" : undefined}
        className="flex w-full min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-md px-2 pt-1.5 pb-1 text-center outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={props.onOpen}
      >
        {props.avatar}
        <span className="w-full truncate text-sm font-medium">{props.name}</span>
        {props.label ? (
          <span className="max-w-full truncate rounded-full bg-sidebar-control-surface px-2 py-0.5 text-xs leading-4 text-secondary-label">
            {props.label}
          </span>
        ) : null}
        <AgentStatusText statusDot={props.statusDot} />
      </button>
      {props.statusText ? (
        <span role="status" className="sr-only">
          {props.statusText}
        </span>
      ) : null}
      {props.menu}
    </div>
  );
}

function AgentStatusText({ statusDot }: { readonly statusDot: AgentStatusDot | null }) {
  if (statusDot === "active") return <span className="sr-only">Working</span>;
  if (statusDot === "unread") return <span className="sr-only">New activity</span>;
  return null;
}

/**
 * The row's hover menu. It reveals on hover or focus; `variant` places it for a row or a tile.
 * Actions a given agent cannot perform are omitted, not disabled, so the menu only offers
 * what works.
 */
export function AgentRowMenu(props: {
  readonly name: string;
  readonly variant: "row" | "tile";
  readonly pinned: boolean;
  readonly canUpdate: boolean;
  readonly canDelete?: boolean;
  readonly hidden?: boolean;
  readonly onTogglePin?: () => void;
  readonly onToggleHidden?: () => void;
  readonly onEdit?: () => void;
  readonly onHistory?: () => void;
  readonly onDelete?: () => void;
}) {
  const placement =
    props.variant === "row"
      ? "absolute top-1/2 right-1.5 z-20 -translate-y-1/2"
      : "absolute top-1 right-1";
  return (
    <div
      className={cn(
        placement,
        "opacity-0 group-hover/agent:opacity-100 group-focus-within/agent:opacity-100 has-data-popup-open:opacity-100",
      )}
    >
      <Menu>
        <MenuTrigger
          render={<Button size="icon-micro" variant="ghost" aria-label={`Edit ${props.name}`} />}
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          {props.onTogglePin ? (
            <MenuItem disabled={!props.canUpdate} onClick={props.onTogglePin}>
              {props.pinned ? <PinOffIcon /> : <PinIcon />}
              {props.pinned ? "Unpin" : "Pin"}
            </MenuItem>
          ) : null}
          {props.onToggleHidden ? (
            <MenuItem disabled={!props.canUpdate} onClick={props.onToggleHidden}>
              <EyeOffIcon />
              {props.hidden ? "Show in list" : "Hide"}
            </MenuItem>
          ) : null}
          {props.onEdit ? (
            <MenuItem onClick={props.onEdit}>
              <SettingsIcon />
              Edit
            </MenuItem>
          ) : null}
          {props.onHistory ? (
            <MenuItem onClick={props.onHistory}>
              <HistoryIcon />
              View history
            </MenuItem>
          ) : null}
          {props.onDelete ? (
            <MenuItem variant="destructive" disabled={!props.canDelete} onClick={props.onDelete}>
              <Trash2Icon />
              Delete
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** A short message in the roster with one or two actions, for setup, connection, and errors. */
export function AgentRosterNotice({
  message,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  readonly message: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly secondaryLabel?: string;
  readonly onSecondary?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-2 py-2">
      <p className="text-xs leading-4.5 text-sidebar-muted-foreground">{message}</p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant="outline" onClick={onAction}>
          {actionLabel}
        </Button>
        {secondaryLabel && onSecondary ? (
          <Button size="xs" variant="ghost" onClick={onSecondary}>
            {secondaryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
