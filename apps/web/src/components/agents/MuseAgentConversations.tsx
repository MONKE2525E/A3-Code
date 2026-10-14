import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MuseAgentFeatureSession,
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { useSidebar } from "~/components/ui/sidebar";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useThreadActions } from "~/hooks/useThreadActions";
import { useEnvironmentQuery } from "~/state/query";
import {
  museAgentFeatureReadQuery,
  museAgentFeatureUpdate,
  museAgentOpenThread,
} from "~/state/museAgent";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import { cn } from "~/lib/utils";

import { AgentRosterNotice } from "./AgentRoster";
import {
  isMuseSessionThread,
  museAvatarStateForStatus,
  resolveMuseAgentStatusDot,
} from "./aiAgents";

/**
 * Muse's side chats as a quiet indented list under its sidebar row. Main chat is the row itself, so
 * an empty or still-loading list renders nothing. Each chat opens as its own thread, and archiving
 * one removes it from Muse and from the sidebar.
 */
export function MuseAgentConversations({
  environmentId,
  providerInstanceId,
  threads,
  routeThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** The open thread id, or null when the route is not a thread in this environment. */
  readonly routeThreadId: string | null;
}) {
  // Mounted only while the row is expanded, so a collapsed Muse costs no list read.
  const read = useEnvironmentQuery(
    museAgentFeatureReadQuery({
      environmentId,
      input: { operation: "sessions", providerInstanceId, view: "active" },
    }),
  );
  const sessions = read.data?.operation === "sessions" ? read.data.data : null;
  const conversations = useMemo(
    () => (sessions ?? []).filter((session) => session.isThread && !session.isPrimary),
    [sessions],
  );
  if (read.error !== null && sessions === null) {
    return (
      <AgentRosterNotice message={read.error} actionLabel="Retry" onAction={() => read.refresh()} />
    );
  }
  if (conversations.length === 0) return null;
  return (
    <ul className="flex flex-col gap-px pt-px pl-(--sidebar-row-content-inset)">
      {conversations.map((session) => (
        <li key={session.sessionId}>
          <MuseConversationRow
            environmentId={environmentId}
            providerInstanceId={providerInstanceId}
            session={session}
            threads={threads}
            selected={
              routeThreadId !== null && isMuseSessionThread(routeThreadId, session.sessionId)
            }
          />
        </li>
      ))}
    </ul>
  );
}

function MuseConversationRow({
  environmentId,
  providerInstanceId,
  session,
  threads,
  selected,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly session: MuseAgentFeatureSession;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly selected: boolean;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const { archiveThread } = useThreadActions();
  const canWrite = useAtomValue(museAgentFeatureUpdate.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const label = session.title?.trim() || "Untitled conversation";

  const open = async () => {
    if (busy) return;
    if (isMobile) setOpenMobile(false);
    const cached = threads.find(
      (entry) =>
        entry.providerInstanceId === providerInstanceId &&
        entry.archivedAt === null &&
        isMuseSessionThread(entry.id, session.sessionId),
    );
    const request = {
      environmentId,
      input: {
        providerInstanceId,
        sessionId: session.sessionId,
      },
    };
    if (cached) {
      // Open the cached conversation now. The guarded open still runs and reports a failure here.
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, cached.id)),
      });
      const validated = await openThread(request);
      if (validated._tag !== "Success" && !isAtomCommandInterrupted(validated)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open conversation",
            description: String(squashAtomCommandFailure(validated)),
          }),
        );
      }
      return;
    }
    setBusy(true);
    const result = await openThread(request);
    setBusy(false);
    if (result._tag !== "Success") return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
    });
  };

  const archive = async () => {
    if (busy) return;
    setBusy(true);
    const result = await update({
      environmentId,
      input: {
        operation: "session_archive",
        providerInstanceId,
        sessionId: session.sessionId,
        archived: true,
      },
    });
    if (result._tag === "Success") {
      // Muse archived it, so its T3 thread goes too; the next open restores both.
      const thread = threads.find(
        (entry) =>
          entry.providerInstanceId === providerInstanceId &&
          entry.archivedAt === null &&
          isMuseSessionThread(entry.id, session.sessionId),
      );
      if (thread) await archiveThread(scopeThreadRef(environmentId, thread.id));
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not archive conversation",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
    setBusy(false);
  };

  const cachedThread = threads.find(
    (entry) =>
      entry.providerInstanceId === providerInstanceId &&
      entry.archivedAt === null &&
      isMuseSessionThread(entry.id, session.sessionId),
  );
  const localVisitedAt = useUiStateStore((state) =>
    cachedThread
      ? state.threadLastVisitedAtById[
          scopedThreadKey(scopeThreadRef(environmentId, cachedThread.id))
        ]
      : undefined,
  );
  const statusDot = resolveMuseAgentStatusDot({
    active: museAvatarStateForStatus(cachedThread?.status) !== "idle",
    thread: cachedThread ?? null,
    localVisitedAt,
  });

  return (
    <div
      className={cn(
        "group/conversation flex h-7 w-full items-center rounded-md text-sidebar-foreground",
        selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        disabled={busy}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
        onClick={() => void open()}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {statusDot ? (
          <>
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                statusDot === "active" ? "bg-success" : "bg-info",
              )}
            />
            <span className="sr-only">{statusDot === "active" ? "Working" : "New activity"}</span>
          </>
        ) : null}
      </button>
      {canWrite ? (
        <span className="mr-1 shrink-0 opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100">
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={`Archive ${label}`}
            disabled={busy}
            onClick={() => void archive()}
          >
            <ArchiveIcon />
          </Button>
        </span>
      ) : null}
    </div>
  );
}
