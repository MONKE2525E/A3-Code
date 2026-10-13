import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { Skeleton } from "~/components/ui/skeleton";
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
import { cn } from "~/lib/utils";

import { AgentRosterNotice } from "./AgentRoster";
import { isMuseSessionThread } from "./aiAgents";

/**
 * Muse's conversations under its sidebar row: Main chat first, then side chats. Each opens as its
 * own thread, and archiving one removes it from Muse and from the sidebar.
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
  const [open, setOpen] = useState(false);
  // Only read Muse's list while it is open, so a collapsed row costs nothing.
  const read = useEnvironmentQuery(
    open
      ? museAgentFeatureReadQuery({
          environmentId,
          input: { operation: "sessions", providerInstanceId, view: "active" },
        })
      : null,
  );
  const sessions = read.data?.operation === "sessions" ? read.data.data : null;
  const conversations = useMemo(
    () =>
      (sessions ?? [])
        .filter((session) => session.isThread)
        .toSorted((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
    [sessions],
  );
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleSectionHeader expanded={open} tone="muted" onClick={() => setOpen(!open)}>
        Conversations
      </CollapsibleSectionHeader>
      <CollapsiblePanel>
        {read.error ? (
          <AgentRosterNotice
            message={read.error}
            actionLabel="Retry"
            onAction={() => read.refresh()}
          />
        ) : sessions === null ? (
          <div className="flex flex-col gap-2 px-1 py-1">
            <Skeleton className="h-9 w-full" shape="card" />
            <Skeleton className="h-9 w-full" shape="card" />
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">No conversations yet.</p>
        ) : (
          <ul className="flex flex-col gap-px pb-1">
            {conversations.map((session) => (
              <li key={session.sessionId}>
                <MuseConversationRow
                  environmentId={environmentId}
                  providerInstanceId={providerInstanceId}
                  session={session}
                  threads={threads}
                  selected={
                    routeThreadId !== null &&
                    isMuseSessionThread(routeThreadId, session.isPrimary ? null : session.sessionId)
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </CollapsiblePanel>
    </Collapsible>
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
  const label = session.isPrimary ? "Main chat" : session.title?.trim() || "Untitled conversation";

  const open = async () => {
    if (busy) return;
    if (isMobile) setOpenMobile(false);
    setBusy(true);
    // Main chat opens without a session, so it keeps its canonical thread.
    const result = await openThread({
      environmentId,
      input: {
        providerInstanceId,
        ...(session.isPrimary ? {} : { sessionId: session.sessionId }),
      },
    });
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
          isMuseSessionThread(entry.id, session.isPrimary ? null : session.sessionId),
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

  return (
    <div
      className={cn(
        "group/conversation relative flex w-full items-center rounded-md text-sidebar-foreground",
        selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        disabled={busy}
        className="min-w-0 flex-1 cursor-pointer truncate px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
        onClick={() => void open()}
      >
        {label}
      </button>
      {canWrite && !session.isPrimary ? (
        <span className="mr-1 opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100">
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
