import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GrokBot } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  EllipsisIcon,
  EyeOffIcon,
  HistoryIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { SidebarGroup, useSidebar } from "~/components/ui/sidebar";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useConnectedEnvironmentIds } from "~/state/environments";
import {
  grokBotsListQuery,
  grokBotsDelete,
  grokBotsStatusQuery,
  grokBotsUpdate,
  refreshGrokBotRoster,
} from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { GrokBotAvatar } from "./GrokBotAvatar";
import { type GrokBotActivity, useGrokBotActivity } from "./grokBotActivity";
import { grokBotNativeReady } from "./grokBotConnection";
import {
  grokBotSettingsDestinationSearch,
  grokBotSurfaceKey,
  partitionGrokBotRoster,
  resolveGrokBotSelectedEnvironment,
} from "./grokBotPresentation";
import { GROK_BOT_TOOL_ACTIVITY_LABELS, type GrokBotThreadActivity } from "./grokBotThreadActivity";
import { type GrokBotStatusDot, resolveGrokBotStatusDot } from "./grokBotStatusDots";
import { useSelectedGrokBotEnvironmentId } from "./useGrokBotEnvironment";
import { cachedGrokBotNativeInstanceId } from "./grokBotCachedThread";
import {
  useGrokBotNativeActions,
  usePrefetchPinnedGrokBotThreads,
  useGrokBotNativeReadiness,
  useOpenGrokBotNativeBotId,
} from "./useGrokBotNative";
import { useGrokBotToolActivities, useGrokBotUnreadBotIds } from "./useGrokBotThreadActivity";

const GROK_BOTS_OPEN_STORAGE_KEY = "t3code:grok-bots-sidebar-open";

export function GrokBotSidebarDropdown() {
  const selectedEnvironmentId = useSelectedGrokBotEnvironmentId();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const resolved = resolveGrokBotSelectedEnvironment({
    selectedEnvironmentId,
    connectedEnvironmentIds,
  });
  const environmentId = resolved.kind === "environment" ? resolved.environmentId : null;
  const [open, setOpen] = useLocalStorage(GROK_BOTS_OPEN_STORAGE_KEY, true, Schema.Boolean);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // Refreshing on open and on focus means a profile edit made in the Grok Bot app shows
  // as soon as the user looks at the sidebar, instead of on the next poll.
  const setOpenAndRefresh = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next && environmentId !== null) refreshGrokBotRoster(appAtomRegistry, environmentId);
    },
    [environmentId, setOpen],
  );
  useEffect(() => {
    if (environmentId === null) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refreshGrokBotRoster(appAtomRegistry, environmentId);
      }
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [environmentId]);
  const status = useEnvironmentQuery(
    environmentId === null ? null : grokBotsStatusQuery({ environmentId, input: {} }),
  );
  const ready = grokBotNativeReady(status.data);
  const roster = useEnvironmentQuery(
    environmentId !== null && ready ? grokBotsListQuery({ environmentId, input: {} }) : null,
  );
  const { pinned, rows, hidden } = useMemo(
    () => partitionGrokBotRoster(roster.data ?? []),
    [roster.data],
  );
  const location = useLocation();
  const selectedBotId = location.pathname.startsWith("/grok-bots/")
    ? decodeURIComponent(location.pathname.slice("/grok-bots/".length).split("/")[0] ?? "")
    : null;

  const openBot = useCallback(
    (botId: string) => {
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/grok-bots/$botId",
        params: { botId },
        search: environmentId ? { environmentId } : {},
      });
    },
    [environmentId, isMobile, navigate, setOpenMobile],
  );

  const openHistory = useCallback(
    (botId: string) => {
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/grok-bots/$botId",
        params: { botId },
        search: environmentId ? { environmentId, view: "history" } : { view: "history" },
      });
    },
    [environmentId, isMobile, navigate, setOpenMobile],
  );

  const openSettings = useCallback(
    (botId?: string) => {
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/settings/providers",
        search: grokBotSettingsDestinationSearch({
          environmentId: selectedEnvironmentId,
          botId,
        }),
        hash: botId ? "grok-bots-editor" : "grok-bots-bridge",
      });
    },
    [isMobile, navigate, selectedEnvironmentId, setOpenMobile],
  );

  return (
    <SidebarGroup className="z-[1]">
      <Collapsible open={open} onOpenChange={setOpenAndRefresh}>
        <CollapsibleSectionHeader
          expanded={open}
          tone="muted"
          onClick={() => setOpenAndRefresh(!open)}
        >
          Grok Bots
        </CollapsibleSectionHeader>
        <CollapsiblePanel>
          <div className="mt-0.5">
            {resolved.kind === "no-environment" ? (
              <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
                Connect an environment to use Grok Bots.
              </p>
            ) : resolved.kind === "disconnected" ? (
              <GrokBotSidebarNotice
                message="This environment is unavailable. Reconnect it or choose a connected one."
                actionLabel="Open settings"
                onAction={() => openSettings()}
              />
            ) : status.isPending && status.data === null ? (
              <div className="flex flex-col gap-2 px-1 py-1">
                <Skeleton className="h-16 w-full" shape="card" />
                <Skeleton className="h-10 w-full" shape="card" />
              </div>
            ) : status.error ? (
              <GrokBotSidebarNotice
                message={status.error}
                actionLabel="Open settings"
                onAction={() => openSettings()}
              />
            ) : !ready && status.data?.installed !== true ? (
              <GrokBotSidebarNotice
                message="Set up the Grok Bot connection to chat with your bots here."
                actionLabel="Set up"
                onAction={() => openSettings()}
              />
            ) : !ready ? (
              <GrokBotSidebarNotice
                message="Open Grok Bot and sign in, then refresh the connection."
                actionLabel="Refresh"
                onAction={() => {
                  status.refresh();
                  roster.refresh();
                }}
                secondaryLabel="Settings"
                onSecondary={() => openSettings()}
              />
            ) : roster.isPending && roster.data === null ? (
              <div className="flex flex-col gap-2 px-1 py-1">
                <Skeleton className="h-16 w-full" shape="card" />
                <Skeleton className="h-10 w-full" shape="card" />
              </div>
            ) : roster.error ? (
              <GrokBotSidebarNotice
                message={roster.error}
                actionLabel="Retry"
                onAction={() => roster.refresh()}
              />
            ) : pinned.length === 0 && rows.length === 0 && hidden.length === 0 ? (
              <GrokBotSidebarNotice
                message="No bots to show."
                actionLabel="Settings"
                onAction={() => openSettings()}
              />
            ) : (
              <GrokBotRosterList
                environmentId={resolved.environmentId}
                pinned={pinned}
                rows={rows}
                hidden={hidden}
                selectedBotId={selectedBotId}
                onOpen={openBot}
                onEdit={(botId) => openSettings(botId)}
                onHistory={openHistory}
                onOpenSettings={() => openSettings()}
              />
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </SidebarGroup>
  );
}

function GrokBotSidebarNotice({
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

function GrokBotRosterList({
  environmentId,
  pinned,
  rows,
  hidden,
  selectedBotId,
  onOpen,
  onEdit,
  onHistory,
  onOpenSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly pinned: readonly GrokBot[];
  readonly rows: readonly GrokBot[];
  readonly hidden: readonly GrokBot[];
  readonly selectedBotId: string | null;
  readonly onOpen: (botId: string) => void;
  readonly onEdit: (botId: string) => void;
  readonly onHistory: (botId: string) => void;
  readonly onOpenSettings: () => void;
}) {
  const readiness = useGrokBotNativeReadiness(environmentId);
  const { syncBotPin } = useGrokBotNativeActions(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  // Fresh config bindings win over a retained readiness success, as in the native hook.
  const instanceId = cachedGrokBotNativeInstanceId(config, readiness);
  const openNativeBotId = useOpenGrokBotNativeBotId(environmentId, instanceId);
  // Warms pinned bots' threads so opening one shows cached messages at once.
  usePrefetchPinnedGrokBotThreads(environmentId, instanceId);
  const toolActivities = useGrokBotToolActivities(environmentId, instanceId);
  const unreadBotIds = useGrokBotUnreadBotIds(environmentId, instanceId);
  // Active comes from the server's run, never from the selected route: an open idle bot has no dot.
  const statusDotFor = (botId: string): GrokBotStatusDot | null =>
    resolveGrokBotStatusDot({
      active: toolActivities.has(botId),
      unread: unreadBotIds.has(botId),
    });
  const activeBotId = openNativeBotId ?? selectedBotId;
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const updateBot = useAtomCommand(grokBotsUpdate, { reportFailure: true });
  // The bot pin is the source of truth; its native thread follows it when one exists.
  const togglePin = useCallback(
    async (bot: GrokBot) => {
      const nextPinned = !bot.pinned;
      const result = await updateBot({
        environmentId,
        input: { botId: bot.id, pinned: nextPinned },
      });
      if (result._tag === "Success" && instanceId !== null) {
        await syncBotPin({ ...bot, pinned: nextPinned }, instanceId);
      }
    },
    [environmentId, instanceId, syncBotPin, updateBot],
  );
  const nativeNotice =
    readiness.kind === "unavailable" ||
    readiness.kind === "denied" ||
    readiness.kind === "blocked" ? (
      <GrokBotSidebarNotice
        message={readiness.message}
        actionLabel="Settings"
        onAction={onOpenSettings}
      />
    ) : null;

  return (
    <div className="flex flex-col gap-1">
      {nativeNotice}
      {pinned.length > 0 ? (
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(80px,1fr))] gap-x-1 gap-y-3 py-1.5">
          {pinned.map((bot) => (
            <li key={bot.id}>
              <GrokBotPinnedTile
                bot={bot}
                selected={bot.id === activeBotId}
                environmentId={environmentId}
                toolActivity={toolActivities.get(bot.id)}
                statusDot={statusDotFor(bot.id)}
                onOpen={() => onOpen(bot.id)}
                onEdit={() => onEdit(bot.id)}
                onHistory={() => onHistory(bot.id)}
                onTogglePin={() => togglePin(bot)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col gap-px">
        {rows.map((bot) => (
          <li key={bot.id}>
            <GrokBotRosterRow
              bot={bot}
              selected={bot.id === activeBotId}
              environmentId={environmentId}
              toolActivity={toolActivities.get(bot.id)}
              statusDot={statusDotFor(bot.id)}
              onOpen={() => onOpen(bot.id)}
              onEdit={() => onEdit(bot.id)}
              onHistory={() => onHistory(bot.id)}
              onTogglePin={() => togglePin(bot)}
            />
          </li>
        ))}
      </ul>
      {hidden.length > 0 ? (
        <Collapsible open={hiddenOpen} onOpenChange={setHiddenOpen}>
          <CollapsibleSectionHeader
            expanded={hiddenOpen}
            tone="muted"
            onClick={() => setHiddenOpen(!hiddenOpen)}
          >
            Hidden bots ({hidden.length})
          </CollapsibleSectionHeader>
          <CollapsiblePanel>
            <ul className="flex flex-col gap-px">
              {hidden.map((bot) => (
                <li key={bot.id}>
                  <GrokBotRosterRow
                    bot={bot}
                    selected={bot.id === activeBotId}
                    environmentId={environmentId}
                    toolActivity={toolActivities.get(bot.id)}
                    statusDot={statusDotFor(bot.id)}
                    onOpen={() => onOpen(bot.id)}
                    onEdit={() => onEdit(bot.id)}
                    onHistory={() => onHistory(bot.id)}
                    onTogglePin={() => togglePin(bot)}
                  />
                </li>
              ))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

function GrokBotRosterRow({
  bot,
  selected,
  environmentId,
  toolActivity,
  statusDot,
  onOpen,
  onEdit,
  onHistory,
  onTogglePin,
}: {
  readonly bot: GrokBot;
  readonly selected: boolean;
  readonly environmentId: EnvironmentId;
  readonly toolActivity: GrokBotThreadActivity | undefined;
  readonly statusDot: GrokBotStatusDot | null;
  readonly onOpen: () => void;
  readonly onEdit: () => void;
  readonly onHistory: () => void;
  readonly onTogglePin: () => void;
}) {
  const storedActivity = useGrokBotActivity(grokBotSurfaceKey(environmentId, bot.id));
  const activity: GrokBotActivity | undefined = toolActivity ?? storedActivity;
  return (
    <div
      className={cn(
        "group/sidebar-row group/bot relative w-full overflow-hidden rounded-md text-sidebar-foreground",
        selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        className="relative z-10 flex h-[3.375rem] w-full min-w-0 cursor-pointer items-center gap-2 pl-(--sidebar-row-content-inset) pr-8.5 py-(--sidebar-content-inset) text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onOpen}
      >
        <GrokBotAvatar
          bot={bot}
          size="lg"
          featured={bot.featured}
          state={activity}
          statusDot={statusDot}
          restingPose="upright"
        />
        <span className="flex h-5 min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span className="min-w-0 max-w-full shrink-0 truncate text-sm font-medium">
            {bot.name}
          </span>
          {bot.label.trim().length > 0 ? (
            <span className="min-w-0 shrink truncate rounded-full bg-sidebar-control-surface px-2 py-0.5 text-xs leading-4 text-secondary-label">
              {bot.label}
            </span>
          ) : null}
        </span>
        {statusDot === "unread" ? <span className="sr-only">New activity</span> : null}
      </button>
      {toolActivity ? (
        <span role="status" className="sr-only">
          {GROK_BOT_TOOL_ACTIVITY_LABELS[toolActivity]}
        </span>
      ) : null}
      <GrokBotRowMenu
        bot={bot}
        environmentId={environmentId}
        onEdit={onEdit}
        onTogglePin={onTogglePin}
        className="absolute top-1/2 right-1.5 z-20 -translate-y-1/2 opacity-0 group-hover/bot:opacity-100 group-focus-within/bot:opacity-100 has-data-popup-open:opacity-100"
        onHistory={onHistory}
      />
    </div>
  );
}

function GrokBotPinnedTile({
  bot,
  selected,
  environmentId,
  toolActivity,
  statusDot,
  onOpen,
  onEdit,
  onHistory,
  onTogglePin,
}: {
  readonly bot: GrokBot;
  readonly selected: boolean;
  readonly environmentId: EnvironmentId;
  readonly toolActivity: GrokBotThreadActivity | undefined;
  readonly statusDot: GrokBotStatusDot | null;
  readonly onOpen: () => void;
  readonly onEdit: () => void;
  readonly onHistory: () => void;
  readonly onTogglePin: () => void;
}) {
  const storedActivity = useGrokBotActivity(grokBotSurfaceKey(environmentId, bot.id));
  const activity: GrokBotActivity | undefined = toolActivity ?? storedActivity;
  return (
    <div
      className={cn(
        "group/sidebar-row group/bot relative rounded-md text-sidebar-foreground",
        selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        className="flex w-full min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-md px-2 pt-1.5 pb-1 text-center outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onOpen}
      >
        <GrokBotAvatar
          bot={bot}
          size="xl"
          fillPx={60}
          featured={bot.featured}
          state={activity}
          statusDot={statusDot}
          restingPose="upright"
        />
        <span className="w-full truncate text-sm font-medium">{bot.name}</span>
        {bot.label.trim().length > 0 ? (
          <span className="max-w-full truncate rounded-full bg-sidebar-control-surface px-2 py-0.5 text-xs leading-4 text-secondary-label">
            {bot.label}
          </span>
        ) : null}
        {statusDot === "unread" ? <span className="sr-only">New activity</span> : null}
      </button>
      {toolActivity ? (
        <span role="status" className="sr-only">
          {GROK_BOT_TOOL_ACTIVITY_LABELS[toolActivity]}
        </span>
      ) : null}
      <GrokBotRowMenu
        bot={bot}
        environmentId={environmentId}
        onEdit={onEdit}
        onTogglePin={onTogglePin}
        className="absolute top-1 right-1 opacity-0 group-hover/bot:opacity-100 group-focus-within/bot:opacity-100 has-data-popup-open:opacity-100"
        onHistory={onHistory}
      />
    </div>
  );
}

function GrokBotRowMenu({
  bot,
  environmentId,
  onEdit,
  onHistory,
  onTogglePin,
  className,
}: {
  readonly bot: GrokBot;
  readonly environmentId: EnvironmentId;
  readonly onEdit: () => void;
  readonly onHistory: () => void;
  readonly onTogglePin: () => void;
  readonly className?: string;
}) {
  const canUpdate = useAtomValue(grokBotsUpdate.permissionAtom(environmentId));
  const updateBot = useAtomCommand(grokBotsUpdate, { reportFailure: true });
  const canDelete = useAtomValue(grokBotsDelete.permissionAtom(environmentId));
  const deleteBot = useAtomCommand(grokBotsDelete, { reportFailure: true });
  const navigate = useNavigate();
  const location = useLocation();

  // A running bot is refused by the server, which reports why; the menu stays enabled so the reason shows.
  const removeBot = async () => {
    const confirmed = await requestConfirmDialog(
      `Delete "${bot.name}"?\nThis permanently deletes the Bot and its history. This can't be undone.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const result = await deleteBot({ environmentId, input: { botId: bot.id } });
    if (result._tag === "Success" && location.pathname.split("/")[2] === encodeURIComponent(bot.id))
      void navigate({ to: "/" });
  };

  return (
    <div className={className}>
      <Menu>
        <MenuTrigger
          render={<Button size="icon-micro" variant="ghost" aria-label={`Edit ${bot.name}`} />}
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          <MenuItem disabled={!canUpdate} onClick={onTogglePin}>
            {bot.pinned ? <PinOffIcon /> : <PinIcon />}
            {bot.pinned ? "Unpin" : "Pin"}
          </MenuItem>
          <MenuItem
            disabled={!canUpdate}
            onClick={() =>
              void updateBot({
                environmentId,
                input: { botId: bot.id, hidden: !bot.hidden },
              })
            }
          >
            <EyeOffIcon />
            {bot.hidden ? "Show in list" : "Hide"}
          </MenuItem>
          <MenuItem onClick={onEdit}>
            <SettingsIcon />
            Edit
          </MenuItem>
          <MenuItem onClick={onHistory}>
            <HistoryIcon />
            View history
          </MenuItem>
          <MenuItem variant="destructive" disabled={!canDelete} onClick={() => void removeBot()}>
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
