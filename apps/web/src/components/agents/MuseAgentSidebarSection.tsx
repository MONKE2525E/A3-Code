import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useNavigate, useParams } from "@tanstack/react-router";
import { BotIcon, ChevronLeftIcon, ClockIcon, ListChecksIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";

import { MenuItem } from "~/components/ui/menu";
import { Button } from "~/components/ui/button";
import { useSidebar } from "~/components/ui/sidebar";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  museAgentOpenThread,
  museAgentProfileQuery,
  museAgentSetup,
  museAgentStatusQuery,
  refreshMuseAgent,
} from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { environmentThreadShells } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUiStateStore } from "~/uiStateStore";
import { buildThreadRouteParams } from "~/threadRoutes";

import { AgentPinnedTile, AgentRosterNotice, AgentRosterRow, AgentRowMenu } from "./AgentRoster";
import {
  findCachedMuseAgentThread,
  isMuseSessionThread,
  museAvatarStateForStatus,
  resolveMuseAgentSidebarState,
  resolveMuseAgentStatusDot,
} from "./aiAgents";
import { MuseAgentAvatar } from "./MuseAgentAvatar";
import { MuseAgentConversations } from "./MuseAgentConversations";
import { MuseSubChatConnector } from "./MuseSubChatConnector";
import { resolveMuseSubChatList, type MuseSubChatEntry } from "./museSubChatList";
import { useMuseAgentAvatar } from "./useMuseAgentAvatar";
import { openCachedMuseThread, queueMuseChatOpen } from "./openCachedMuseThread";

const MUSE_PINNED_STORAGE_KEY = "t3code:muse-agent-pinned";

/**
 * Native Muse inside the AI Agents section. Detection is automatic: nothing renders until Muse
 * is installed, then it guides sign-in or one-click enable, then shows the personal agent row.
 */
export function MuseAgentSidebarSection({
  environmentId,
  onOpenSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly onOpenSettings: () => void;
}) {
  const status = useEnvironmentQuery(museAgentStatusQuery({ environmentId, input: {} }));
  const state = resolveMuseAgentSidebarState({ status: status.data, error: status.error });
  // Failures render inline: a toast-only report is easy to miss and says nothing in the sidebar.
  const setup = useAtomCommand(museAgentSetup, { reportFailure: false });
  const canSetup = useAtomValue(museAgentSetup.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const runSetup = async () => {
    setPending(true);
    setSetupError(null);
    const result = await setup({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setSetupError(sanitizeSetupError(squashAtomCommandFailure(result)));
    }
  };

  if (state.kind === "hidden") return null;
  if (state.kind === "setup") {
    return state.notice.actionLabel ? (
      <AgentRosterNotice
        message={state.notice.message}
        actionLabel={state.notice.actionLabel}
        onAction={() => refreshMuseAgent(appAtomRegistry, environmentId)}
      />
    ) : (
      <p className="px-2 py-2 text-xs leading-4.5 text-sidebar-muted-foreground">
        {state.notice.message}
      </p>
    );
  }
  if (state.kind === "enable") {
    const reconnect = state.mode === "reconnect";
    const detail = enableStatusDetail(state.detail);
    return (
      <div className="flex flex-col gap-2 px-2 py-2">
        <p className="text-xs leading-4.5 text-sidebar-muted-foreground">
          {reconnect
            ? "Muse needs to reconnect before you can chat with it here."
            : "Muse is signed in on this machine. Connect it to verify the account and chat with it here."}
        </p>
        {detail ? (
          <p className="text-xs leading-4.5 text-sidebar-muted-foreground">{detail}</p>
        ) : null}
        {setupError ? (
          <p role="alert" className="text-xs leading-4.5 text-destructive">
            {setupError}
          </p>
        ) : null}
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={!canSetup || pending}
            onClick={() => void runSetup()}
          >
            {pending
              ? "Verifying account…"
              : setupError
                ? "Try again"
                : reconnect
                  ? "Reconnect Muse"
                  : "Add Muse"}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <MuseAgentRoster
      environmentId={environmentId}
      instanceId={state.instanceId}
      onOpenSettings={onOpenSettings}
    />
  );
}

function MuseAgentRoster({
  environmentId,
  instanceId,
  onOpenSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string;
  readonly onOpenSettings: () => void;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const profile = useEnvironmentQuery(museAgentProfileQuery({ environmentId, input: {} }));
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById);
  const routeThreadId = useParams({ strict: false, select: (params) => params.threadId ?? null });
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => params.environmentId ?? null,
  });
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));
  // Pinning is a browser-local layout choice; Muse has one personal agent per machine.
  const [pinned, setPinned] = useLocalStorage(MUSE_PINNED_STORAGE_KEY, false, Schema.Boolean);

  const thread = useMemo(
    () => findCachedMuseAgentThread(threads, instanceId),
    [instanceId, threads],
  );

  const selected = useMemo(() => {
    if (routeThreadId === null || routeEnvironmentId !== environmentId) return false;
    return thread !== null && thread.id === routeThreadId;
  }, [environmentId, routeEnvironmentId, routeThreadId, thread]);

  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [failedSubChat, setFailedSubChat] = useState<MuseSubChatEntry | null>(null);

  const open = useCallback(async () => {
    if (opening) return;
    if (isMobile) setOpenMobile(false);
    setOpenError(null);
    setFailedSubChat(null);
    const providerInstanceId = ProviderInstanceId.make(instanceId);
    const cached = threads.find(
      (entry) =>
        entry.providerInstanceId === instanceId &&
        entry.archivedAt === null &&
        isMuseSessionThread(entry.id, null),
    );
    if (cached) {
      // Show the cached chat at once. The guarded open still runs: it validates the account and
      // reattaches history, and a failure surfaces on this row.
      setOpening(true);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, cached.id)),
      });
      const validated = await openThread({
        environmentId,
        input: { providerInstanceId },
      });
      setOpening(false);
      if (validated._tag !== "Success" && !isAtomCommandInterrupted(validated)) {
        setOpenError(
          shortError(squashAtomCommandFailure(validated), "Could not open Muse. Try again."),
        );
      }
      return;
    }
    // Enter chat immediately. The /muse/chat surface runs the guarded open and never navigates
    // to another account's thread.
    queueMuseChatOpen({ kind: "main", environmentId, providerInstanceId });
    void navigate({
      to: "/muse/$section",
      params: { section: "chat" },
      search: { environmentId },
    });
  }, [environmentId, instanceId, isMobile, navigate, opening, openThread, setOpenMobile, threads]);

  // Working comes from the canonical thread's run, never from the selected route.
  const avatarState = museAvatarStateForStatus(thread?.status);
  const working = avatarState !== "idle";
  const statusDot = resolveMuseAgentStatusDot({
    active: working,
    thread,
    localVisitedAt:
      thread === null
        ? undefined
        : localLastVisitedAt[scopedThreadKey(scopeThreadRef(environmentId, thread.id))],
  });

  const data = profile.data;
  const name = data?.name?.trim() || "Muse";
  const avatar = useMuseAgentAvatar(environmentId, data, { state: avatarState });
  const errorFooter = openError ? (
    <div className="flex items-center gap-2 py-1 pr-2 pl-(--sidebar-row-content-inset)">
      <p role="alert" className="min-w-0 flex-1 text-xs leading-4.5 text-destructive">
        {openError}
      </p>
      <Button
        size="xs"
        variant="outline"
        disabled={!canOpen || opening}
        onClick={() => void (failedSubChat ? openSubChat(failedSubChat) : open())}
      >
        Retry
      </Button>
    </div>
  ) : null;
  // Side chats live in the menu, so the row stays one line and a pinned tile still lists them.
  const menu = (variant: "row" | "tile") => (
    <AgentRowMenu
      name={name}
      variant={variant}
      pinned={pinned}
      canUpdate
      onTogglePin={() => setPinned(!pinned)}
      onEdit={onOpenSettings}
      footer={
        <>
          <MenuItem onClick={() => openMuseSection("activity")}>
            <ListChecksIcon />
            Activity
          </MenuItem>
          <MenuItem onClick={() => openMuseSection("approvals")}>
            <ShieldCheckIcon />
            Approvals
          </MenuItem>
          <MenuItem onClick={() => openMuseSection("routines")}>
            <ClockIcon />
            Routines
          </MenuItem>
          <MenuItem onClick={() => openMuseSection("subagents")}>
            <BotIcon />
            Subagents
          </MenuItem>
          <MuseAgentConversations
            environmentId={environmentId}
            providerInstanceId={ProviderInstanceId.make(instanceId)}
            threads={threads}
          />
        </>
      }
    />
  );
  const subChats = useMemo(
    () => resolveMuseSubChatList({ threads, providerInstanceId: instanceId, routeThreadId }),
    [instanceId, routeThreadId, threads],
  );
  const rosterRef = useRef<HTMLDivElement | null>(null);
  const avatarRef = useRef<HTMLSpanElement | null>(null);
  const subChatLabelRef = useRef<HTMLSpanElement | null>(null);
  const openEntry = subChats.open;
  const inSideChat = routeEnvironmentId === environmentId && openEntry !== null;
  const openMuseSection = (section: "activity" | "approvals" | "routines" | "subagents") => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/muse/$section",
      params: { section },
      search: { environmentId },
    });
  };
  const openSubChat = async (entry: MuseSubChatEntry) => {
    if (!canOpen || opening) return;
    if (isMobile) setOpenMobile(false);
    setOpening(true);
    setOpenError(null);
    try {
      await openCachedMuseThread({
        hit: { environmentId, threadId: entry.id },
        shells: threads.map((thread) => ({ ...thread, environmentId })),
        openThread: async (target) => {
          const result = await openThread(target);
          if (result._tag === "Success") return result.value;
          if (isAtomCommandInterrupted(result)) return null;
          throw squashAtomCommandFailure(result);
        },
        navigate: async (target) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
          });
        },
      });
    } catch (error) {
      setFailedSubChat(entry);
      setOpenError(shortError(error, "Could not open Muse. Try again."));
    } finally {
      setOpening(false);
    }
  };
  const avatarNode = (size: "lg" | "tall" | "xl") => (
    <MuseAgentAvatar
      name={name}
      imageUrl={avatar.imageUrl}
      videoUrl={avatar.videoUrl}
      active={working}
      size={size}
    />
  );

  if (pinned) {
    return (
      <div className="flex flex-col gap-px">
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(80px,1fr))] gap-x-1 gap-y-3 py-1.5">
          <li>
            <AgentPinnedTile
              disabled={!canOpen}
              pending={opening}
              name={name}
              avatar={avatarNode("xl")}
              selected={selected}
              statusDot={statusDot}
              menu={menu("tile")}
              onOpen={() => void open()}
            />
          </li>
        </ul>
        {errorFooter}
      </div>
    );
  }
  return (
    <div ref={rosterRef} className="relative flex flex-col gap-px">
      <AgentRosterRow
        name={name}
        avatar={
          <span ref={avatarRef} className="inline-flex shrink-0">
            {avatarNode(inSideChat ? "tall" : "lg")}
          </span>
        }
        selected={selected}
        statusDot={statusDot}
        disabled={!canOpen}
        pending={opening}
        expanded={inSideChat}
        menu={
          inSideChat ? (
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label="Back to Main chat"
              className="absolute inset-y-0 right-1.5 z-20 my-auto"
              onClick={() => void open()}
            >
              <ChevronLeftIcon />
            </Button>
          ) : (
            <div className="absolute inset-y-0 right-1.5 z-20 flex items-center">
              <div className="[&>div]:static [&>div]:top-auto [&>div]:right-auto [&>div]:translate-y-0">
                {menu("row")}
              </div>
            </div>
          )
        }
        footer={errorFooter}
        onOpen={() => void open()}
      />
      {openEntry ? (
        <MuseSubChatRow
          entry={openEntry}
          labelRef={subChatLabelRef}
          disabled={!canOpen || opening}
          onOpen={() => void openSubChat(openEntry)}
        />
      ) : null}
      {subChats.pinned.length > 0 ? (
        <>
          <p className="pt-1 pl-10.5 text-2xs leading-4 text-sidebar-muted-foreground">Pinned</p>
          {subChats.pinned.map((entry) => (
            <MuseSubChatRow
              key={entry.id}
              entry={entry}
              disabled={!canOpen || opening}
              onOpen={() => void openSubChat(entry)}
            />
          ))}
        </>
      ) : null}
      {inSideChat ? (
        <MuseSubChatConnector
          containerRef={rosterRef}
          avatarRef={avatarRef}
          targetRef={subChatLabelRef}
        />
      ) : null}
    </div>
  );
}

function MuseSubChatRow({
  entry,
  disabled,
  labelRef,
  onOpen,
}: {
  readonly entry: MuseSubChatEntry;
  readonly disabled: boolean;
  readonly labelRef?: RefObject<HTMLSpanElement | null>;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-current={entry.active ? "page" : undefined}
      className={cn(
        "relative z-10 flex h-[1.875rem] w-full min-w-0 cursor-pointer items-center rounded-md pr-2 pl-10.5 text-left text-sm text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        entry.active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
      onClick={onOpen}
    >
      <span ref={labelRef} className="min-w-0 truncate">
        {entry.title}
      </span>
    </button>
  );
}

/** One short line for the sidebar: no stack, path, or token-looking text from the failure. */
function shortError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const line = error.message.split("\n")[0]?.trim() ?? "";
  if (line.length === 0 || line.length > 160 || /[/\\]|\b[\w-]{32,}\b/.test(line)) return fallback;
  return line;
}

function sanitizeSetupError(error: unknown): string {
  return shortError(
    error,
    "Muse could not be connected. Check that Muse is signed in, then try again.",
  );
}

/** `status.message` can still say connected while `ready` is false. Enable copy is the truth. */
function enableStatusDetail(detail: string | null): string | null {
  if (detail === null) return null;
  const text = detail.trim();
  if (/^muse is connected\.?$/i.test(text)) return null;
  return text;
}
