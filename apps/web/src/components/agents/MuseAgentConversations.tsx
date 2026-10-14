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
import { MenuItem, MenuSeparator } from "~/components/ui/menu";
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

import {
  isMuseSessionThread,
  museAvatarStateForStatus,
  resolveMuseAgentStatusDot,
} from "./aiAgents";

/**
 * Muse's side chats, listed in the row's menu below its pin and edit actions. Main chat is the row
 * itself, so an empty or still-loading list adds nothing. Each chat opens as its own thread.
 */
export function MuseAgentConversations({
  environmentId,
  providerInstanceId,
  threads,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}) {
  // Mounted only while the menu is open, so a closed menu costs no list read.
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
      <>
        <MenuSeparator />
        <MenuItem onClick={() => read.refresh()}>Couldn't load conversations. Retry</MenuItem>
      </>
    );
  }
  if (conversations.length === 0) return null;
  return (
    <>
      <MenuSeparator />
      {conversations.map((session) => (
        <MuseConversationItem
          key={session.sessionId}
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          session={session}
          threads={threads}
        />
      ))}
    </>
  );
}

function MuseConversationItem({
  environmentId,
  providerInstanceId,
  session,
  threads,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly session: MuseAgentFeatureSession;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const { archiveThread } = useThreadActions();
  const canWrite = useAtomValue(museAgentFeatureUpdate.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const label = session.title?.trim() || "Untitled conversation";

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

  const open = async () => {
    if (busy) return;
    if (isMobile) setOpenMobile(false);
    const request = {
      environmentId,
      input: {
        providerInstanceId,
        sessionId: session.sessionId,
      },
    };
    if (cachedThread) {
      // Open the cached conversation now. The guarded open still runs and reports a failure here.
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, cachedThread.id)),
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
      if (cachedThread) await archiveThread(scopeThreadRef(environmentId, cachedThread.id));
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
    <MenuItem disabled={busy} onClick={() => void open()}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {statusDot ? (
        <>
          <span
            aria-hidden
            className={
              statusDot === "active"
                ? "size-2 shrink-0 rounded-full bg-success"
                : "size-2 shrink-0 rounded-full bg-info"
            }
          />
          <span className="sr-only">{statusDot === "active" ? "Working" : "New activity"}</span>
        </>
      ) : null}
      {canWrite ? (
        // Archive shows only while its row is highlighted, so the list stays quiet at rest.
        <span className="shrink-0 opacity-0 in-data-highlighted:opacity-100">
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={`Archive ${label}`}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void archive();
            }}
          >
            <ArchiveIcon />
          </Button>
        </span>
      ) : null}
    </MenuItem>
  );
}
