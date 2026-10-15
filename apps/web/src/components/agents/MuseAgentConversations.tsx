import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MuseAgentFeatureSession,
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { useSidebar } from "~/components/ui/sidebar";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useThreadActions } from "~/hooks/useThreadActions";
import { readLocalApi } from "~/localApi";
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
 * itself. Archived chats remain reachable through the submenu. Each chat opens as its own thread.
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
      <MenuSub>
        <MenuSubTrigger>Archived conversations</MenuSubTrigger>
        <MenuSubPopup>
          <MuseArchivedConversations
            environmentId={environmentId}
            providerInstanceId={providerInstanceId}
            threads={threads}
          />
        </MenuSubPopup>
      </MenuSub>
    </>
  );
}

function MuseArchivedConversations(props: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}) {
  const read = useEnvironmentQuery(
    museAgentFeatureReadQuery({
      environmentId: props.environmentId,
      input: {
        operation: "sessions",
        providerInstanceId: props.providerInstanceId,
        view: "archived",
      },
    }),
  );
  const sessions =
    read.data?.operation === "sessions"
      ? read.data.data.filter((session) => session.isThread && !session.isPrimary)
      : [];
  if (read.error !== null)
    return (
      <MenuItem onClick={() => read.refresh()}>
        Couldn't load archived conversations. Retry
      </MenuItem>
    );
  if (sessions.length === 0)
    return (
      <MenuItem disabled>
        {read.isPending ? "Loading conversations…" : "No archived conversations"}
      </MenuItem>
    );
  return sessions.map((session) => (
    <MuseConversationItem key={session.sessionId} {...props} session={session} archived />
  ));
}

function MuseConversationItem({
  environmentId,
  providerInstanceId,
  session,
  threads,
  archived = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly archived?: boolean;
  readonly session: MuseAgentFeatureSession;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const { archiveThread, pinThread, unpinThread } = useThreadActions();
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));
  const canWrite = useAtomValue(museAgentFeatureUpdate.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const label = session.title?.trim() || "Untitled conversation";

  const cachedThread = threads.find(
    (entry) =>
      entry.providerInstanceId === providerInstanceId &&
      entry.archivedAt === null &&
      isMuseSessionThread(entry.id, session.sessionId),
  );
  const threadRef = cachedThread ? scopeThreadRef(environmentId, cachedThread.id) : null;
  const pinned = cachedThread?.pinnedAt != null;
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

  const setArchived = async () => {
    if (busy) return;
    setBusy(true);
    const result = await update({
      environmentId,
      input: {
        operation: "session_archive",
        providerInstanceId,
        sessionId: session.sessionId,
        archived: !archived,
      },
    });
    if (result._tag === "Success") {
      // Restored native conversations reappear in the active list; opening them restores the T3 thread.
      if (!archived && threadRef) await archiveThread(threadRef);
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: archived ? "Could not unarchive conversation" : "Could not archive conversation",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
    setBusy(false);
  };

  const rename = async () => {
    const title = draft.trim();
    setRenaming(false);
    if (title.length === 0 || title === label) return;
    const result = await update({
      environmentId,
      input: {
        operation: "session_rename",
        providerInstanceId,
        sessionId: session.sessionId,
        title,
      },
    });
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not rename conversation",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  const togglePin = async () => {
    if (!threadRef) return;
    const result = pinned ? await unpinThread(threadRef) : await pinThread(threadRef);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: pinned ? "Could not unpin conversation" : "Could not pin conversation",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  // Right-click uses the same native menu as T3's thread rows, so it looks and behaves the same.
  const showContextMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await settlePromise(() =>
      api.contextMenu.show(
        [
          {
            id: "pin",
            label: pinned ? "Unpin" : "Pin",
            disabled: archived || threadRef === null || !canWrite,
          },
          { id: "rename", label: "Rename", disabled: archived || !canWrite },
          {
            id: "archive",
            label: archived ? "Unarchive" : "Archive",
            disabled: !canWrite || busy,
            separatorBefore: true,
          },
        ],
        position,
      ),
    );
    if (clicked._tag === "Failure" || clicked.value === null) return;
    switch (clicked.value) {
      case "pin":
        void togglePin();
        return;
      case "rename":
        setDraft(label);
        setRenaming(true);
        return;
      case "archive":
        void setArchived();
        return;
    }
  };

  return (
    <>
      <MenuItem
        disabled={busy || (archived ? !canWrite : !canOpen)}
        onClick={() => void (archived ? setArchived() : open())}
        onContextMenu={(event) => {
          event.preventDefault();
          void showContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <span className="min-w-0 flex-1 truncate">{archived ? `Unarchive ${label}` : label}</span>
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
      </MenuItem>
      <Dialog open={renaming} onOpenChange={(open) => (open ? null : setRenaming(false))}>
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
            </DialogHeader>
            <div className="px-6 pb-4">
              <Input
                autoFocus
                aria-label="Conversation title"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={draft.trim().length === 0}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
