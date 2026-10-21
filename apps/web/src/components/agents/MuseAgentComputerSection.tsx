import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MuseAgentComputerTask,
  MuseAgentComputerTaskDetail,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";

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
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { museAgentFeatureReadQuery, museAgentFeatureUpdate } from "~/state/museAgent";
import { museAgentComputerPreviewQuery } from "~/state/museAgentComputerPreview";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { MuseAgentComputerViewer } from "./MuseAgentComputerViewer";
import { describeMuseComputerTask } from "./museAgentFeatures.logic";

type Target = {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
};
type TaskAction = "stop" | "close";

/** Page text is always shown as text; it becomes a link only for credential-free http(s) URLs. */
function safeHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

function Row({ children }: { readonly children: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2.5">
      {children}
    </li>
  );
}

/** Still image of the task's latest frame. The blob URL is revoked on change and unmount. */
function TaskPreview({
  environmentId,
  providerInstanceId,
  sessionId,
  detail,
}: Target & { readonly sessionId: string; readonly detail: MuseAgentComputerTaskDetail }) {
  const preview = detail.preview;
  const query = useEnvironmentQuery(
    preview === null
      ? null
      : museAgentComputerPreviewQuery({
          environmentId,
          input: {
            providerInstanceId,
            sessionId,
            taskId: detail.task.taskId,
            revision: `${preview.sha256}:${preview.updatedAtMs}`,
          },
        }),
  );
  const loaded = query.data;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (loaded?._tag !== "Available") {
      setUrl(null);
      return;
    }
    // Copy into an owned ArrayBuffer so the Blob never aliases a SharedArrayBuffer-backed view.
    const next = URL.createObjectURL(
      new Blob([new Uint8Array(loaded.bytes)], { type: loaded.contentType }),
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [loaded]);

  if (preview === null || loaded?._tag === "Missing") {
    return <p className="text-xs text-muted-foreground">No preview is available for this task.</p>;
  }
  if (loaded?._tag === "Unavailable" || (loaded === null && query.error !== null)) {
    return (
      <p role="alert" className="text-xs text-muted-foreground">
        The preview could not be loaded{query.error ? `: ${query.error}` : "."}
      </p>
    );
  }
  if (url === null) {
    return (
      <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" /> Loading preview…
      </div>
    );
  }
  return (
    <figure className="grid gap-1">
      <img
        src={url}
        alt={`Preview of ${detail.task.title}`}
        width={preview.width}
        height={preview.height}
        className="max-h-80 w-full rounded-md border bg-muted object-contain"
      />
      <figcaption className="text-xs text-muted-foreground">
        Preview · still image from {new Date(preview.updatedAtMs).toLocaleTimeString()}
      </figcaption>
    </figure>
  );
}

function TaskDetail({
  environmentId,
  providerInstanceId,
  task,
  canWrite,
  onActed,
}: Target & {
  readonly task: MuseAgentComputerTask;
  readonly canWrite: boolean;
  readonly onActed: () => void;
}) {
  const sessionId = task.sessionId ?? null;
  const read = useEnvironmentQuery(
    sessionId === null || task.readOnly
      ? null
      : museAgentFeatureReadQuery({
          environmentId,
          input: {
            operation: "computer_task",
            providerInstanceId,
            sessionId,
            taskId: task.taskId,
          },
        }),
  );
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const [confirming, setConfirming] = useState<TaskAction | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sessionId === null || task.readOnly) {
    return (
      <p className="text-xs text-muted-foreground">
        {task.readOnly
          ? "This task is read-only, so it has no preview or actions here."
          : "Muse did not report a session for this task, so it cannot be previewed here."}
      </p>
    );
  }

  const detail = read.data?.operation === "computer_task" ? read.data.data : null;
  const url = detail?.state.activeTab ? safeHttpUrl(detail.state.activeTab.url) : null;

  const confirm = async () => {
    if (confirming === null || pending) return;
    setPending(true);
    setError(null);
    const result = await update({
      environmentId,
      input: {
        operation: "computer_action",
        providerInstanceId,
        sessionId,
        taskId: task.taskId,
        command: { action: confirming },
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      // Never retried: the outcome is uncertain, so the user refreshes to see the real state.
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : "The action may not have completed. Refresh to check the task.",
      );
      return;
    }
    toastManager.add({
      type: "success",
      title: confirming === "stop" ? "Stop requested" : "Close requested",
    });
    setConfirming(null);
    onActed();
  };

  return (
    <div className="grid gap-3">
      {read.data === null ? (
        read.error === null ? (
          <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> Loading task…
          </div>
        ) : (
          <div role="alert" className="grid gap-2 text-xs">
            <p className="text-muted-foreground">Task details could not be loaded: {read.error}</p>
            <Button size="xs" variant="outline" className="w-fit" onClick={read.refresh}>
              <RefreshIcon /> Try again
            </Button>
          </div>
        )
      ) : null}
      {detail ? (
        <>
          {read.error !== null ? (
            <p role="alert" className="text-xs text-destructive">
              Could not refresh the task; showing the last result.
            </p>
          ) : null}
          <TaskPreview
            environmentId={environmentId}
            providerInstanceId={providerInstanceId}
            sessionId={sessionId}
            detail={detail}
          />
          {detail.state.activeTab ? (
            <p className="min-w-0 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {detail.state.activeTab.title || "Untitled tab"}
              </span>
              {" · "}
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all underline"
                >
                  {url}
                </a>
              ) : (
                <span className="break-all">{detail.state.activeTab.url}</span>
              )}
            </p>
          ) : null}
          <MuseAgentComputerViewer
            environmentId={environmentId}
            providerInstanceId={providerInstanceId}
            sessionId={sessionId}
            task={task}
            lease={detail.state.lease ?? null}
            canWrite={canWrite}
            onTakeover={read.refresh}
          />
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={read.isPending} onClick={read.refresh}>
          <RefreshIcon /> Refresh
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canWrite || pending}
          onClick={() => {
            setError(null);
            setConfirming("stop");
          }}
        >
          Stop task
        </Button>
        <Button
          size="sm"
          variant="ghost-destructive"
          disabled={!canWrite || pending}
          onClick={() => {
            setError(null);
            setConfirming("close");
          }}
        >
          Close task
        </Button>
      </div>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => (open || pending ? null : setConfirming(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "stop" ? "Stop this task?" : "Close this task?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "stop"
                ? `Muse will stop working on “${task.title}”.`
                : `Muse will close “${task.title}” and its session on its computer.`}{" "}
              This is sent to Muse once and is not retried automatically.
            </AlertDialogDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={pending}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
              {pending ? "Sending…" : confirming === "stop" ? "Stop task" : "Close task"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/**
 * Muse's native computer: the task list plus, for one explicitly selected task, its latest still
 * preview, Stop/Close actions, and an explicit Take control that opens the live viewer.
 */
export function MuseAgentComputerSection({
  environmentId,
  providerInstanceId,
  canWrite,
}: Target & { readonly canWrite: boolean }) {
  const view = useEnvironmentQuery(
    museAgentFeatureReadQuery({
      environmentId,
      input: { operation: "computer", providerInstanceId },
    }),
  );
  const status = view.data?.operation === "computer" ? view.data.data : null;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (status === null) {
    if (view.error === null) {
      return (
        <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading computer status…
        </div>
      );
    }
    return (
      <div role="alert" className="grid gap-2 py-6 text-sm">
        <p className="text-foreground">Muse computer status could not be loaded.</p>
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
          Could not refresh computer status; showing the last result.
          <Button size="xs" variant="ghost" onClick={view.refresh}>
            Retry
          </Button>
        </p>
      ) : null}
      <p className="text-sm text-foreground">
        {status.available
          ? "Muse's computer is available."
          : "Muse's computer is not available right now."}
      </p>
      <p className="text-xs text-muted-foreground">
        Select a task to see its latest preview. Choose Take control to drive it live; that pauses
        Muse on the task until the control lease expires. Closing the view does not end the lease.
      </p>
      {status.tasks.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No computer tasks.</p>
      ) : (
        <ul className="grid gap-2">
          {status.tasks.map((task) => {
            const selected = selectedId === task.taskId;
            return (
              <Row key={task.taskId}>
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">{task.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {describeMuseComputerTask(task)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {task.readOnly ? <Badge variant="outline">Read-only</Badge> : null}
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    aria-expanded={selected}
                    onClick={() => setSelectedId(selected ? null : task.taskId)}
                  >
                    {selected ? "Hide" : "Preview"}
                  </Button>
                </div>
                {selected ? (
                  <div className="w-full border-t pt-2">
                    <TaskDetail
                      environmentId={environmentId}
                      providerInstanceId={providerInstanceId}
                      task={task}
                      canWrite={canWrite}
                      onActed={() => setSelectedId(null)}
                    />
                  </div>
                ) : null}
              </Row>
            );
          })}
        </ul>
      )}
    </div>
  );
}
