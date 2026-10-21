import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GrokBot } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useState } from "react";

import { AI_AGENTS_SECTION_LABEL } from "~/components/agents/aiAgents";
import { enabledAgentMarketplaces } from "~/components/agents/nativeAgentAvailability";
import {
  AgentPinnedTile,
  AgentRosterNotice,
  AgentRosterRow,
  AgentRowMenu,
} from "~/components/agents/AgentRoster";
import { MuseAgentSidebarSection } from "~/components/agents/MuseAgentSidebarSection";

import { requestConfirmDialog } from "~/confirmDialog";
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { SidebarGroup, useSidebar } from "~/components/ui/sidebar";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useConnectedEnvironmentIds } from "~/state/environments";
import {
  grokBotsListQuery,
  grokBotsDelete,
  grokBotsStatusQuery,
  grokBotsUpdate,
  refreshGrokBotRoster,
} from "~/state/grokBots";
import { useEnvironmentPresentation } from "~/state/presentation";
import { useEnvironmentQuery } from "~/state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { GrokBotAvatar } from "./GrokBotAvatar";
import { type GrokBotActivity, useGrokBotActivity } from "./grokBotActivity";
import { grokBotNativeReady } from "./grokBotConnection";
import {
  grokBotSettingsDestinationSearch,
  isGrokBotEnvironmentConnecting,
  isGrokBotRosterRecovering,
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

/**
 * The shared AI Agents section. Grok Bots are its built-in roster; other native agents, such as
 * Muse, pass their rows as `nativeAgents` and appear above the bots. Without a configured Grok
 * Bot provider the section shows only the other agents, and nothing when there are none.
 */
export function GrokBotSidebarDropdown({
  nativeAgents,
}: { readonly nativeAgents?: ReactNode } = {}) {
  const environmentId = useSelectedGrokBotEnvironmentId();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const config = environmentId === null ? undefined : configs.get(environmentId);
  const available = enabledAgentMarketplaces(config?.settings.providerInstances);
  if (available.length === 0) return null;
  return available.includes("grok-bot") ? (
    <ConfiguredGrokBotSidebarDropdown
      nativeAgents={nativeAgents}
      museEnabled={available.includes("muse-agent")}
    />
  ) : (
    <NativeAgentsOnlySection nativeAgents={nativeAgents} />
  );
}

function NativeAgentsOnlySection({ nativeAgents }: { readonly nativeAgents?: ReactNode }) {
  const selectedEnvironmentId = useSelectedGrokBotEnvironmentId();
  const resolved = resolveGrokBotSelectedEnvironment({
    selectedEnvironmentId,
    connectedEnvironmentIds: useConnectedEnvironmentIds(),
  });
  const { isReady: catalogReady, presentation } = useEnvironmentPresentation(selectedEnvironmentId);
  const connecting =
    resolved.kind === "disconnected" &&
    isGrokBotEnvironmentConnecting({
      catalogReady,
      phase: presentation?.connection.phase ?? null,
    });
  const environmentId = resolved.kind === "environment" ? resolved.environmentId : null;
  const [open, setOpen] = useLocalStorage(GROK_BOTS_OPEN_STORAGE_KEY, true, Schema.Boolean);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const openSettings = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/settings/providers",
      search: selectedEnvironmentId ? { machine: selectedEnvironmentId } : {},
    });
  };
  return (
    <SidebarGroup className="z-[1]">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleSectionHeader expanded={open} tone="muted" onClick={() => setOpen(!open)}>
          {AI_AGENTS_SECTION_LABEL}
        </CollapsibleSectionHeader>
        <CollapsiblePanel>
          <div className="mt-0.5">
            {nativeAgents}
            {environmentId !== null ? (
              <MuseAgentSidebarSection
                environmentId={environmentId}
                onOpenSettings={openSettings}
              />
            ) : resolved.kind === "no-environment" ? (
              <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
                Connect an environment to use AI Agents.
              </p>
            ) : connecting ? (
              <GrokBotSidebarLoading label="Loading Muse…" />
            ) : (
              <AgentRosterNotice
                message="This environment is unavailable. Reconnect it or choose a connected one."
                actionLabel="Open settings"
                onAction={openSettings}
              />
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </SidebarGroup>
  );
}

function ConfiguredGrokBotSidebarDropdown({
  nativeAgents,
  museEnabled,
}: {
  readonly nativeAgents?: ReactNode;
  readonly museEnabled: boolean;
}) {
  const selectedEnvironmentId = useSelectedGrokBotEnvironmentId();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const resolved = resolveGrokBotSelectedEnvironment({
    selectedEnvironmentId,
    connectedEnvironmentIds,
  });
  const { isReady: catalogReady, presentation } = useEnvironmentPresentation(selectedEnvironmentId);
  const connecting =
    resolved.kind === "disconnected" &&
    isGrokBotEnvironmentConnecting({
      catalogReady,
      phase: presentation?.connection.phase ?? null,
    });
  const environmentId = resolved.kind === "environment" ? resolved.environmentId : null;
  const [open, setOpen] = useLocalStorage(GROK_BOTS_OPEN_STORAGE_KEY, true, Schema.Boolean);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // Refreshing on open and on focus means a profile edit made in the Grok Bot app shows
  // as soon as the user looks at the sidebar, instead of on the next poll.
  const setOpenAndRefresh = (next: boolean) => {
    setOpen(next);
    if (next && environmentId !== null) refreshGrokBotRoster(appAtomRegistry, environmentId);
  };
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
  const { pinned, rows, hidden } = partitionGrokBotRoster(roster.data ?? []);
  const [expiredRosterAt, setExpiredRosterAt] = useState(0);
  useEffect(() => {
    if (roster.failure === null) return;
    const timer = window.setTimeout(
      () => setExpiredRosterAt(roster.dataUpdatedAt),
      Math.max(0, roster.dataUpdatedAt + 30_000 - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [roster.failure, roster.dataUpdatedAt]);
  const recoveringRoster = isGrokBotRosterRecovering({
    failure: roster.failure,
    hasData: roster.data !== null,
    dataUpdatedAt: roster.dataUpdatedAt,
    nowMs: roster.dataUpdatedAt + (expiredRosterAt === roster.dataUpdatedAt ? 30_000 : 0),
  });
  const location = useLocation();
  const selectedBotId = location.pathname.startsWith("/grok-bots/")
    ? decodeURIComponent(location.pathname.slice("/grok-bots/".length).split("/")[0] ?? "")
    : null;

  const openBot = (botId: string) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/grok-bots/$botId",
      params: { botId },
      search: environmentId ? { environmentId } : {},
    });
  };

  const openHistory = (botId: string) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/grok-bots/$botId",
      params: { botId },
      search: environmentId ? { environmentId, view: "history" } : { view: "history" },
    });
  };

  const openSettings = (botId?: string) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/settings/providers",
      search: grokBotSettingsDestinationSearch({
        environmentId: selectedEnvironmentId,
        botId,
      }),
      hash: botId ? "grok-bots-editor" : "grok-bots-bridge",
    });
  };

  return (
    <SidebarGroup className="z-[1]">
      <Collapsible open={open} onOpenChange={setOpenAndRefresh}>
        <CollapsibleSectionHeader
          expanded={open}
          tone="muted"
          onClick={() => setOpenAndRefresh(!open)}
        >
          {AI_AGENTS_SECTION_LABEL}
        </CollapsibleSectionHeader>
        <CollapsiblePanel>
          <div className="mt-0.5">
            {nativeAgents}
            {environmentId !== null && museEnabled ? (
              <MuseAgentSidebarSection
                environmentId={environmentId}
                onOpenSettings={() => openSettings()}
              />
            ) : null}
            {resolved.kind === "no-environment" ? (
              <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
                Connect an environment to use AI Agents.
              </p>
            ) : connecting ? (
              <GrokBotSidebarLoading />
            ) : resolved.kind === "disconnected" ? (
              <AgentRosterNotice
                message="This environment is unavailable. Reconnect it or choose a connected one."
                actionLabel="Open settings"
                onAction={() => openSettings()}
              />
            ) : status.isPending && status.data === null ? (
              <GrokBotSidebarLoading />
            ) : status.error ? (
              <AgentRosterNotice
                message={status.error}
                actionLabel="Open settings"
                onAction={() => openSettings()}
              />
            ) : !ready && status.data?.installed !== true ? (
              <div className="flex items-center justify-between gap-2 px-2 py-1">
                <span className="min-w-0 truncate text-xs text-sidebar-muted-foreground">
                  Grok Bots not connected
                </span>
                <Button size="xs" variant="ghost" onClick={() => openSettings()}>
                  Set up
                </Button>
              </div>
            ) : !ready ? (
              <AgentRosterNotice
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
              <GrokBotSidebarLoading />
            ) : roster.error && !recoveringRoster ? (
              <AgentRosterNotice
                message={roster.error}
                actionLabel="Retry"
                onAction={() => roster.refresh()}
              />
            ) : pinned.length === 0 && rows.length === 0 && hidden.length === 0 ? (
              <AgentRosterNotice
                message="No bots to show."
                actionLabel="Settings"
                onAction={() => openSettings()}
              />
            ) : (
              <>
                {recoveringRoster ? (
                  <p role="status" className="px-2 py-2 text-xs text-sidebar-muted-foreground">
                    Refreshing Grok Bots…
                  </p>
                ) : null}
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
              </>
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </SidebarGroup>
  );
}

function GrokBotSidebarLoading({ label = "Loading Grok Bots…" }: { readonly label?: string }) {
  return (
    <div className="flex flex-col gap-2 px-1 py-1" role="status" aria-busy="true">
      <p className="px-1 text-xs text-sidebar-muted-foreground">{label}</p>
      <Skeleton className="h-16 w-full" shape="card" />
      <Skeleton className="h-10 w-full" shape="card" />
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
  const togglePin = async (bot: GrokBot) => {
    const nextPinned = !bot.pinned;
    const result = await updateBot({
      environmentId,
      input: { botId: bot.id, pinned: nextPinned },
    });
    if (result._tag === "Success" && instanceId !== null) {
      await syncBotPin({ ...bot, pinned: nextPinned }, instanceId);
    }
  };
  const nativeNotice =
    readiness.kind === "unavailable" ||
    readiness.kind === "denied" ||
    readiness.kind === "blocked" ? (
      <AgentRosterNotice
        message={readiness.message}
        actionLabel="Settings"
        onAction={onOpenSettings}
      />
    ) : null;

  const renderRow = (bot: GrokBot) => (
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
  );

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
          <li key={bot.id}>{renderRow(bot)}</li>
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
                <li key={bot.id}>{renderRow(bot)}</li>
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
    <AgentRosterRow
      name={bot.name}
      label={bot.label}
      selected={selected}
      statusDot={statusDot}
      statusText={toolActivity ? GROK_BOT_TOOL_ACTIVITY_LABELS[toolActivity] : null}
      onOpen={onOpen}
      avatar={
        <GrokBotAvatar
          bot={bot}
          environmentId={environmentId}
          size="lg"
          featured={bot.featured}
          state={activity}
          statusDot={statusDot}
          restingPose="upright"
        />
      }
      menu={
        <GrokBotRowMenu
          bot={bot}
          environmentId={environmentId}
          variant="row"
          onEdit={onEdit}
          onTogglePin={onTogglePin}
          onHistory={onHistory}
        />
      }
    />
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
    <AgentPinnedTile
      name={bot.name}
      label={bot.label}
      selected={selected}
      statusDot={statusDot}
      statusText={toolActivity ? GROK_BOT_TOOL_ACTIVITY_LABELS[toolActivity] : null}
      onOpen={onOpen}
      avatar={
        <GrokBotAvatar
          bot={bot}
          environmentId={environmentId}
          size="xl"
          fillPx={60}
          featured={bot.featured}
          state={activity}
          statusDot={statusDot}
          restingPose="upright"
        />
      }
      menu={
        <GrokBotRowMenu
          bot={bot}
          environmentId={environmentId}
          variant="tile"
          onEdit={onEdit}
          onTogglePin={onTogglePin}
          onHistory={onHistory}
        />
      }
    />
  );
}

/** Grok Bot's menu: the shared menu, wired to the bot's pin, hide, and delete commands. */
function GrokBotRowMenu({
  bot,
  environmentId,
  variant,
  onEdit,
  onHistory,
  onTogglePin,
}: {
  readonly bot: GrokBot;
  readonly environmentId: EnvironmentId;
  readonly variant: "row" | "tile";
  readonly onEdit: () => void;
  readonly onHistory: () => void;
  readonly onTogglePin: () => void;
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
    <AgentRowMenu
      name={bot.name}
      variant={variant}
      pinned={bot.pinned}
      canUpdate={canUpdate}
      canDelete={canDelete}
      hidden={bot.hidden}
      onTogglePin={onTogglePin}
      onToggleHidden={() =>
        void updateBot({
          environmentId,
          input: { botId: bot.id, hidden: !bot.hidden },
        })
      }
      onEdit={onEdit}
      onHistory={onHistory}
      onDelete={() => void removeBot()}
    />
  );
}
