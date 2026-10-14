import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronLeftIcon, ListChecksIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

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
    return (
      <div className="flex flex-col gap-2 px-2 py-2">
        <p className="text-xs leading-4.5 text-sidebar-muted-foreground">
          {reconnect
            ? "Muse needs to reconnect before you can chat with it here."
            : "Muse is signed in on this machine. Connect it to verify the account and chat with it here."}
        </p>
        {state.detail ? (
          <p className="text-xs leading-4.5 text-sidebar-muted-foreground">{state.detail}</p>
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

  const open = useCallback(async () => {
    if (opening) return;
    if (isMobile) setOpenMobile(false);
    const cached = threads.find(
      (entry) =>
        entry.providerInstanceId === instanceId &&
        entry.archivedAt === null &&
        isMuseSessionThread(entry.id, null),
    );
    if (cached) {
      // Show the cached chat at once. The guarded open still runs: it validates the account and
      // reattaches history, and a failure surfaces on this row.
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, cached.id)),
      });
      const validated = await openThread({
        environmentId,
        input: { providerInstanceId: ProviderInstanceId.make(instanceId) },
      });
      if (validated._tag !== "Success" && !isAtomCommandInterrupted(validated)) {
        setOpenError(
          shortError(squashAtomCommandFailure(validated), "Could not open Muse. Try again."),
        );
      }
      return;
    }
    // Without a cached chat, the guarded open is the only way in: it creates the thread.
    setOpening(true);
    setOpenError(null);
    const result = await openThread({
      environmentId,
      input: { providerInstanceId: ProviderInstanceId.make(instanceId) },
    });
    setOpening(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        setOpenError(
          shortError(squashAtomCommandFailure(result), "Could not open Muse. Try again."),
        );
      }
      return;
    }
    const threadId = result.value.threadId;
    setOpenError(null);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
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
      <Button size="xs" variant="outline" onClick={() => void open()}>
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
        <MuseAgentConversations
          environmentId={environmentId}
          providerInstanceId={ProviderInstanceId.make(instanceId)}
          threads={threads}
        />
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
  const pathname = useLocation({ select: (location) => location.pathname });
  const openMuseSection = (section: "activity" | "approvals") => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/muse/$section",
      params: { section },
      search: { environmentId },
    });
  };
  const openSubChat = (entry: MuseSubChatEntry) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, entry.id as ThreadId)),
    });
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
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(80px,1fr))] gap-x-1 gap-y-3 py-1.5">
        <li>
          <AgentPinnedTile
            name={name}
            avatar={avatarNode("xl")}
            selected={selected}
            statusDot={statusDot}
            menu={menu("tile")}
            onOpen={() => void open()}
          />
        </li>
      </ul>
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
              className="absolute top-1/2 right-1.5 z-20 -translate-y-1/2"
              onClick={() => void open()}
            >
              <ChevronLeftIcon />
            </Button>
          ) : (
            menu("row")
          )
        }
        footer={errorFooter}
        onOpen={() => void open()}
      />
      {openEntry ? (
        <MuseSubChatRow
          entry={openEntry}
          labelRef={subChatLabelRef}
          onOpen={() => openSubChat(openEntry)}
        />
      ) : null}
      {subChats.pinned.length > 0 ? (
        <>
          <p className="pt-1 pl-10.5 text-2xs leading-4 text-sidebar-muted-foreground">Pinned</p>
          {subChats.pinned.map((entry) => (
            <MuseSubChatRow key={entry.id} entry={entry} onOpen={() => openSubChat(entry)} />
          ))}
        </>
      ) : null}
      <MuseSectionRow
        label="Activity"
        icon={<ListChecksIcon />}
        active={pathname === "/muse/activity"}
        onOpen={() => openMuseSection("activity")}
      />
      <MuseSectionRow
        label="Approvals"
        icon={<ShieldCheckIcon />}
        active={pathname === "/muse/approvals"}
        onOpen={() => openMuseSection("approvals")}
      />
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

/** A dedicated Muse page in the sidebar: each one opens its own route, not a tab in a shared panel. */
function MuseSectionRow({
  label,
  icon,
  active,
  onOpen,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly active: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative z-10 flex h-[1.875rem] w-full min-w-0 cursor-pointer items-center gap-2 rounded-md pr-2 pl-10.5 text-left text-sm text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
      onClick={onOpen}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-sidebar-muted-foreground [&>svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function MuseSubChatRow({
  entry,
  labelRef,
  onOpen,
}: {
  readonly entry: MuseSubChatEntry;
  readonly labelRef?: RefObject<HTMLSpanElement | null>;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
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
