import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type MuseAgentFeatureSession,
  type NativeAgentFeatureReadInput,
  ProviderInstanceId as ProviderInstanceIdSchema,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import {
  museAgentFeatureReadQuery,
  museAgentFeatureUpdate,
  museAgentOpenThread,
  museAgentStatusQuery,
} from "~/state/museAgent";
import { useComposerDraftStore } from "~/composerDraftStore";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "~/components/ChatMarkdown";

import { MuseAgentDeliveryRecovery } from "./MuseAgentDeliveryRecovery";
import { MuseAgentComputerSection } from "./MuseAgentComputerSection";
import { MuseAgentConnectionsSection } from "./MuseAgentConnectionsSection";
import { MuseAgentDictationSection } from "./MuseAgentDictationSection";
import { MuseAgentProfileSection } from "./MuseAgentProfileSection";
import {
  MUSE_FEATURE_TABS,
  MUSE_ROUTINE_CREATE_PROMPT,
  museRoutineEditPrompt,
  describeMuseSkill,
  formatMuseNextRun,
  formatMuseSchedule,
  groupMuseSkills,
  museMemoryPreview,
  museSessionTitle,
  resolveMuseSessionActions,
  resolveMuseTabSupport,
  type MuseFeatureTabId,
} from "./museAgentFeatures.logic";

type ReadInput = typeof NativeAgentFeatureReadInput.Type;
type Target = {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
};

/** One native read. `null` skips the request, e.g. before a search is submitted. */
function useFeatureRead(environmentId: EnvironmentId, input: ReadInput | null) {
  return useEnvironmentQuery(
    input === null ? null : museAgentFeatureReadQuery({ environmentId, input }),
  );
}

/** Loading, error with retry, and empty states shared by every section. */
function FeatureState<T>({
  view,
  label,
  isEmpty,
  emptyText,
  children,
}: {
  readonly view: {
    readonly data: T | null;
    readonly error: string | null;
    readonly isPending: boolean;
    readonly refresh: () => void;
  };
  readonly label: string;
  readonly isEmpty: (data: T) => boolean;
  readonly emptyText: string;
  readonly children: (data: T) => ReactNode;
}) {
  if (view.data === null) {
    if (view.error === null) {
      return (
        <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading {label}…
        </div>
      );
    }
    return (
      <div role="alert" className="grid gap-2 py-6 text-sm">
        <p className="text-foreground">Muse {label} could not be loaded.</p>
        <p className="text-xs text-muted-foreground">{view.error}</p>
        <Button size="sm" variant="outline" className="w-fit" onClick={view.refresh}>
          <RefreshIcon /> Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      {view.error !== null ? (
        <p role="alert" className="flex items-center gap-2 text-xs text-destructive">
          Could not refresh {label}; showing the last result.
          <Button size="xs" variant="ghost" onClick={view.refresh}>
            Retry
          </Button>
        </p>
      ) : null}
      {isEmpty(view.data) ? (
        <p className="py-6 text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        children(view.data)
      )}
    </div>
  );
}

function Row({ children }: { readonly children: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2.5">
      {children}
    </li>
  );
}

function toneVariant(tone: "success" | "muted" | "warning") {
  return tone === "success" ? "success" : tone === "warning" ? "warning" : "outline";
}

function MemorySection({ environmentId, providerInstanceId }: Target) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [openUri, setOpenUri] = useState<string | null>(null);
  const search = useFeatureRead(
    environmentId,
    query === null ? null : { operation: "memory_search", providerInstanceId, query },
  );
  const detail = useFeatureRead(
    environmentId,
    openUri === null ? null : { operation: "memory_read", providerInstanceId, uri: openUri },
  );
  const results = search.data?.operation === "memory_search" ? search.data.data : null;
  const memory = detail.data?.operation === "memory_read" ? detail.data.data : null;
  return (
    <div className="grid gap-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <Input
          aria-label="Search Muse memory"
          placeholder="Search what Muse remembers"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={draft.trim().length === 0}>
          Search
        </Button>
      </form>
      {query === null ? (
        <p className="py-4 text-sm text-muted-foreground">
          Search to browse Muse's memories. They are read-only here.
        </p>
      ) : (
        <FeatureState
          view={{ ...search, data: results }}
          label="memories"
          isEmpty={(items) => items.length === 0}
          emptyText={`No memories match “${query}”.`}
        >
          {(items) => (
            <ul className="grid gap-2">
              {items.map((item) => (
                <Row key={item.uri}>
                  <button
                    type="button"
                    className="grid min-w-0 flex-1 gap-0.5 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => setOpenUri(item.uri)}
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {item.title || "Untitled memory"}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {museMemoryPreview(item.summary ?? item.contentMarkdown) ?? "No preview"}
                    </span>
                  </button>
                </Row>
              ))}
            </ul>
          )}
        </FeatureState>
      )}
      <Dialog open={openUri !== null} onOpenChange={(open) => (open ? null : setOpenUri(null))}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{memory?.title || "Memory"}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <FeatureState
              view={{ ...detail, data: memory }}
              label="memory"
              isEmpty={() => false}
              emptyText=""
            >
              {(item) => (
                <ChatMarkdown
                  text={item.contentMarkdown ?? item.summary ?? "This memory has no text."}
                  cwd={undefined}
                  environmentId={environmentId}
                  className="select-text"
                />
              )}
            </FeatureState>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function RoutineRuns({ environmentId, providerInstanceId, jobId }: Target & { jobId: string }) {
  const view = useFeatureRead(environmentId, { operation: "task_runs", providerInstanceId, jobId });
  const runs = view.data?.operation === "task_runs" ? view.data.data : null;
  return (
    <FeatureState
      view={{ ...view, data: runs }}
      label="runs"
      isEmpty={(items) => items.length === 0}
      emptyText="This routine has not run yet."
    >
      {(items) => (
        <ul className="grid gap-1 text-xs text-muted-foreground">
          {items.map((run) => (
            <li key={run.runId} className="flex justify-between gap-2">
              <span className="truncate">Run {run.runId}</span>
              <span>{run.status ?? "Status unavailable"}</span>
            </li>
          ))}
        </ul>
      )}
    </FeatureState>
  );
}

/**
 * Routines are created and edited by Muse itself, so these controls close the panel, open the
 * canonical Muse chat and seed the composer. Nothing is sent for the user.
 */
function useOpenMuseChatWithDraft(
  { environmentId, providerInstanceId }: Target,
  onClose: () => void,
) {
  const navigate = useNavigate();
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(
    async (prompt: string) => {
      if (opening) return;
      setError(null);
      // Always go through the guarded open: the server validates the account, unarchives and
      // reattaches history. It is idempotent, so a repeat returns the same canonical thread.
      setOpening(true);
      const result = await openThread({
        environmentId,
        input: { providerInstanceId: ProviderInstanceIdSchema.make(providerInstanceId) },
      });
      setOpening(false);
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Could not open Muse.");
        }
        return;
      }
      const ref = scopeThreadRef(environmentId, result.value.threadId);
      // Keep whatever the user already typed; the seed goes below it. Never auto-sent.
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(ref)?.prompt ?? "";
      store.setPrompt(ref, existing.trim().length > 0 ? `${existing}\n\n${prompt}` : prompt);
      onClose();
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    },
    [environmentId, navigate, onClose, opening, openThread, providerInstanceId],
  );
  return { start, canOpen: canOpen && !opening, error };
}

function RoutinesSection({
  onClose,
  environmentId,
  providerInstanceId,
  canWrite,
}: Target & { canWrite: boolean; onClose: () => void }) {
  const chat = useOpenMuseChatWithDraft({ environmentId, providerInstanceId }, onClose);
  const view = useFeatureRead(environmentId, { operation: "tasks", providerInstanceId });
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const tasks = view.data?.operation === "tasks" ? view.data.data : null;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (!deleting) return;
    setPending(true);
    setError(null);
    const result = await update({
      environmentId,
      input: { operation: "task_delete", providerInstanceId, jobId: deleting.id },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The routine could not be deleted.");
      return;
    }
    toastManager.add({ type: "success", title: `Deleted “${deleting.title}”` });
    setDeleting(null);
  };

  return (
    <>
      <div className="mb-2 flex items-center justify-end gap-2">
        {chat.error ? (
          <p role="alert" className="text-xs text-destructive">
            {chat.error}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!chat.canOpen}
          onClick={() => void chat.start(MUSE_ROUTINE_CREATE_PROMPT)}
        >
          Create routine
        </Button>
      </div>
      <FeatureState
        view={{ ...view, data: tasks }}
        label="routines"
        isEmpty={(items) => items.length === 0}
        emptyText="Muse has no routines. Ask Muse in chat to schedule one."
      >
        {(items) => (
          <ul className="grid gap-2">
            {items.map((task) => {
              const title = task.title?.trim() || "Untitled routine";
              const next = formatMuseNextRun(task.nextRunAtUtc, Date.now());
              return (
                <Row key={task.id}>
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{title}</span>
                      {task.isHeartbeat ? <Badge variant="outline">Heartbeat</Badge> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatMuseSchedule(task.scheduleKey, task.timezone)}
                      {next ? ` · ${next}` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost-muted"
                      aria-expanded={expanded === task.id}
                      onClick={() => setExpanded(expanded === task.id ? null : task.id)}
                    >
                      Runs
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost-muted"
                      disabled={!chat.canOpen}
                      aria-label={`Edit routine ${title}`}
                      onClick={() => void chat.start(museRoutineEditPrompt(title))}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      disabled={!canWrite}
                      aria-label={`Delete routine ${title}`}
                      onClick={() => {
                        setError(null);
                        setDeleting({ id: task.id, title });
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                  {expanded === task.id ? (
                    <div className="w-full border-t pt-2">
                      <RoutineRuns
                        environmentId={environmentId}
                        providerInstanceId={providerInstanceId}
                        jobId={task.id}
                      />
                    </div>
                  ) : null}
                </Row>
              );
            })}
          </ul>
        )}
      </FeatureState>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? null : setDeleting(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this routine?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.title}” will be permanently removed from Muse and will stop running. This
              cannot be undone.
            </AlertDialogDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={pending}>
              Keep routine
            </AlertDialogClose>
            <Button variant="destructive" disabled={pending} onClick={() => void confirmDelete()}>
              {pending ? "Deleting…" : "Delete routine"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function SkillsSection({ environmentId, providerInstanceId }: Target) {
  const view = useFeatureRead(environmentId, { operation: "skills", providerInstanceId });
  const skills = view.data?.operation === "skills" ? view.data.data : null;
  const groups = useMemo(() => (skills ? groupMuseSkills(skills) : []), [skills]);
  return (
    <FeatureState
      view={{ ...view, data: skills }}
      label="skills"
      isEmpty={(items) => items.length === 0}
      emptyText="Muse reports no skills."
    >
      {() => (
        <>
          <p className="text-xs text-muted-foreground">
            Skills are managed in the Muse app. Availability is what Muse reports.
          </p>
          {groups.map((group) => (
            <section key={group.category} className="grid gap-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase">
                {group.category}
              </h4>
              <ul className="grid gap-2">
                {group.skills.map((skill) => {
                  const state = describeMuseSkill(skill);
                  return (
                    <Row key={skill.name}>
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {skill.title ?? skill.name}
                        </span>
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {skill.description}
                        </span>
                        {state.detail ? (
                          <span className="text-xs text-muted-foreground">{state.detail}</span>
                        ) : null}
                      </div>
                      <Badge variant={toneVariant(state.tone)}>{state.label}</Badge>
                    </Row>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </FeatureState>
  );
}

function ConversationRow({
  session,
  canWrite,
  onRename,
  onArchive,
  busy,
}: {
  readonly session: MuseAgentFeatureSession;
  readonly canWrite: boolean;
  readonly onRename: () => void;
  readonly onArchive: () => void;
  readonly busy: boolean;
}) {
  const actions = resolveMuseSessionActions(session);
  const title = museSessionTitle(session);
  return (
    <Row>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {actions.stateLabel ? <Badge variant="outline">{actions.stateLabel}</Badge> : null}
        </span>
        {session.snippet && session.title ? (
          <span className="line-clamp-1 text-xs text-muted-foreground">{session.snippet}</span>
        ) : null}
        {session.canSendMessages === false ? (
          <span className="text-xs text-muted-foreground">
            Read-only{session.readOnlyReason ? `: ${session.readOnlyReason}` : ""}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1">
        {actions.canRename ? (
          <Button size="sm" variant="ghost-muted" disabled={!canWrite || busy} onClick={onRename}>
            Rename
          </Button>
        ) : null}
        {actions.canArchive ? (
          <Button size="sm" variant="ghost-muted" disabled={!canWrite || busy} onClick={onArchive}>
            {actions.archiveAction === "archive" ? "Archive" : "Restore"}
          </Button>
        ) : null}
      </div>
    </Row>
  );
}

function ConversationsSection({
  environmentId,
  providerInstanceId,
  canWrite,
}: Target & { canWrite: boolean }) {
  const [view, setView] = useState<"active" | "archived">("active");
  const read = useFeatureRead(environmentId, { operation: "sessions", providerInstanceId, view });
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const sessions = read.data?.operation === "sessions" ? read.data.data : null;
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (
    sessionId: string,
    input:
      | { operation: "session_rename"; title: string }
      | { operation: "session_archive"; archived: boolean },
    success: string,
  ) => {
    setBusyId(sessionId);
    setError(null);
    const result = await update({
      environmentId,
      input: { ...input, providerInstanceId, sessionId },
    });
    setBusyId(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return false;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The conversation was not updated.");
      return false;
    }
    toastManager.add({ type: "success", title: success });
    return true;
  };

  return (
    <div className="grid gap-3">
      <MuseAgentDeliveryRecovery
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        canWrite={canWrite}
      />
      <div role="group" aria-label="Conversation list" className="flex gap-1">
        {(["active", "archived"] as const).map((option) => (
          <Button
            key={option}
            size="sm"
            variant={view === option ? "secondary" : "ghost-muted"}
            aria-pressed={view === option}
            onClick={() => setView(option)}
          >
            {option === "active" ? "Active" : "Archived"}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <FeatureState
        view={{ ...read, data: sessions }}
        label="conversations"
        isEmpty={(items) => items.length === 0}
        emptyText={
          view === "active" ? "Muse has no active conversations." : "No archived conversations."
        }
      >
        {(items) => (
          <ul className="grid gap-2">
            {items.map((session) => (
              <ConversationRow
                key={session.sessionId}
                session={session}
                canWrite={canWrite}
                busy={busyId === session.sessionId}
                onRename={() =>
                  setRenaming({ id: session.sessionId, title: museSessionTitle(session) })
                }
                onArchive={() => {
                  const archiving = resolveMuseSessionActions(session).archiveAction === "archive";
                  void run(
                    session.sessionId,
                    { operation: "session_archive", archived: archiving },
                    archiving ? "Conversation archived" : "Conversation restored",
                  );
                }}
              />
            ))}
          </ul>
        )}
      </FeatureState>
      <Dialog open={renaming !== null} onOpenChange={(open) => (open ? null : setRenaming(null))}>
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const title = renaming?.title.trim();
              if (!renaming || !title) return;
              void run(
                renaming.id,
                { operation: "session_rename", title },
                "Conversation renamed",
              ).then((ok) => {
                if (ok) setRenaming(null);
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
              <DialogDescription>This renames the conversation in Muse.</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <Input
                autoFocus
                aria-label="Conversation title"
                value={renaming?.title ?? ""}
                onChange={(event) =>
                  setRenaming((current) =>
                    current ? { ...current, title: event.target.value } : current,
                  )
                }
              />
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busyId !== null || (renaming?.title.trim().length ?? 0) === 0}
              >
                {busyId !== null ? "Renaming…" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

/**
 * Native Muse features for one connected provider instance. Opens from the Muse thread header and
 * from the selected Muse provider in Settings. Every section reads its own operation, so a tab only
 * claims availability once its query has succeeded.
 */
export function MuseAgentFeaturesDialog({
  environmentId,
  providerInstanceId,
  open,
  onOpenChange,
}: Target & { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<MuseFeatureTabId>("memory");
  const canWrite = useAtomValue(museAgentFeatureUpdate.permissionAtom(environmentId));
  const inventory = useFeatureRead(
    environmentId,
    open ? { operation: "inventory", providerInstanceId } : null,
  );
  const support = resolveMuseTabSupport(
    inventory.data?.operation === "inventory" ? inventory.data.data : null,
    tab,
  );
  const target = { environmentId, providerInstanceId };
  // A successful hand-off to chat already delivered the transcript, so it closes without the guard.
  const [dictationActive, setDictationActive] = useState(false);
  const dictationChat = useOpenMuseChatWithDraft(target, () => {
    setDictationActive(false);
    onOpenChange(false);
  });
  const profileOperations =
    inventory.data?.operation === "inventory"
      ? (inventory.data.data.features.find((feature) => feature.feature === "profile")
          ?.operations ?? [])
      : null;
  // Unsaved profile text survives only while its tab is open, so confirm before leaving it. The
  // requested change waits in `pendingLeave` while the profile stays mounted with its edits.
  const [profileDirty, setProfileDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<
    { readonly kind: "tab"; readonly tab: MuseFeatureTabId } | { readonly kind: "close" } | null
  >(null);
  const requestLeave = (leave: NonNullable<typeof pendingLeave>) => {
    if (profileDirty || dictationActive) {
      setPendingLeave(leave);
      return;
    }
    if (leave.kind === "tab") setTab(leave.tab);
    else onOpenChange(false);
  };
  const confirmLeave = () => {
    const leave = pendingLeave;
    setPendingLeave(null);
    if (!leave) return;
    setProfileDirty(false);
    setDictationActive(false);
    if (leave.kind === "tab") setTab(leave.tab);
    else onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestLeave({ kind: "close" });
        else onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Muse features</DialogTitle>
          <DialogDescription>
            What Muse remembers, runs, and can reach on your account.
          </DialogDescription>
          <div
            role="tablist"
            aria-label="Muse features"
            className="-mx-1 flex gap-1 overflow-x-auto px-1 pt-1"
          >
            {MUSE_FEATURE_TABS.map((item) => (
              <Button
                key={item.id}
                role="tab"
                size="sm"
                variant={tab === item.id ? "secondary" : "ghost-muted"}
                aria-selected={tab === item.id}
                onClick={() => {
                  if (item.id !== tab) requestLeave({ kind: "tab", tab: item.id });
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </DialogHeader>
        <DialogPanel>
          <div role="tabpanel" aria-label={tab} className="min-h-48">
            {support === "unavailable" ? (
              <p role="status" className="py-6 text-sm text-muted-foreground">
                This isn't available for Muse yet.
              </p>
            ) : tab === "memory" ? (
              <MemorySection {...target} />
            ) : tab === "routines" ? (
              <RoutinesSection
                {...target}
                canWrite={canWrite}
                onClose={() => onOpenChange(false)}
              />
            ) : tab === "connections" ? (
              <MuseAgentConnectionsSection {...target} canWrite={canWrite} />
            ) : tab === "skills" ? (
              <SkillsSection {...target} />
            ) : tab === "conversations" ? (
              <ConversationsSection {...target} canWrite={canWrite} />
            ) : tab === "dictation" ? (
              <MuseAgentDictationSection
                key={`${environmentId}:${providerInstanceId}`}
                {...target}
                chat={dictationChat}
                onActiveChange={setDictationActive}
              />
            ) : tab === "profile" ? (
              <MuseAgentProfileSection
                {...target}
                operations={profileOperations}
                canWrite={canWrite}
                onDirtyChange={setProfileDirty}
              />
            ) : (
              <MuseAgentComputerSection {...target} canWrite={canWrite} />
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
      <AlertDialog
        open={pendingLeave !== null}
        onOpenChange={(next) => (next ? null : setPendingLeave(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dictationActive ? "Discard dictation?" : "Discard unsaved changes?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dictationActive
                ? "Recording stops and any transcript you haven't added to chat is lost. Audio already sent for transcription is ignored."
                : "Your edits to Muse's profile have not been saved and will be lost."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep editing</AlertDialogClose>
            <Button variant="destructive" onClick={confirmLeave}>
              {dictationActive ? "Discard dictation" : "Discard changes"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Dialog>
  );
}

/** Header entry for the Muse thread: resolves the connected provider, and hides until it is ready. */
export function MuseAgentHeaderFeatures({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const status = useEnvironmentQuery(
    canRead ? museAgentStatusQuery({ environmentId, input: {} }) : null,
  ).data;
  if (!canRead || !status?.ready || !status.provider) return null;
  return (
    <MuseAgentFeaturesButton
      environmentId={environmentId}
      providerInstanceId={status.provider.instanceId}
      variant="ghost"
      size="touch-sm"
    />
  );
}

/** Opens the features panel. Shared by the thread header and the Settings provider card. */
export function MuseAgentFeaturesButton({
  environmentId,
  providerInstanceId,
  variant = "outline",
  size = "sm",
}: Target & {
  readonly variant?: "outline" | "ghost";
  readonly size?: "sm" | "touch-sm";
}) {
  const [open, setOpen] = useState(false);
  // Every feature read needs orchestration read access, so without it neither the button nor
  // its queries exist.
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  if (!canRead) return null;
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <SparklesIcon /> Muse features
      </Button>
      {open ? (
        <MuseAgentFeaturesDialog
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
