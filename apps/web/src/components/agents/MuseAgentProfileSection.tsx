import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  museAgentFeatureReadQuery,
  museAgentFeatureUpdate,
  refreshMuseAgent,
} from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

type DocumentKind = "identity" | "soul" | "memory";

const DOCUMENTS: ReadonlyArray<{ readonly id: DocumentKind; readonly label: string }> = [
  { id: "identity", label: "Identity" },
  { id: "soul", label: "Personality" },
  { id: "memory", label: "Memory" },
];

type Target = {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
};

type Access = {
  /** Inventory operations for the profile feature; `null` until the inventory has loaded. */
  readonly operations: ReadonlyArray<string> | null;
  readonly canWrite: boolean;
};

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

function Notice({ title, error, onRetry }: { title: string; error: string; onRetry: () => void }) {
  return (
    <div role="alert" className="grid gap-2 py-6 text-sm">
      <p className="text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{error}</p>
      <Button size="sm" variant="outline" className="w-fit" onClick={onRetry}>
        <RefreshIcon /> Try again
      </Button>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Spinner className="size-4" /> Loading {label}…
    </div>
  );
}

/**
 * One document's editor. Keyed by document so each selection starts clean. The baseline is the
 * last revision the user has seen: polling or refetching never replaces text being edited, and
 * only an explicit reload discards a draft.
 */
function ProfileDocumentEditor({
  environmentId,
  providerInstanceId,
  document,
  label,
  canEdit,
  onDirtyChange,
}: Target & {
  readonly document: DocumentKind;
  readonly label: string;
  readonly canEdit: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const view = useEnvironmentQuery(
    museAgentFeatureReadQuery({
      environmentId,
      input: { operation: "profile_document", providerInstanceId, document },
    }),
  );
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const latest = view.data?.operation === "profile_document" ? view.data.data : null;
  const [baseline, setBaseline] = useState<{ content: string; revision: string } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // After a save, the old revision is stale until the refreshed document arrives.
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt a newer revision only when that cannot lose typing: no draft, or a draft that already
  // equals the incoming text (the result of our own save).
  if (
    latest &&
    (baseline === null ||
      (latest.revision !== baseline.revision && (draft === null || draft === latest.content)))
  ) {
    setBaseline({ content: latest.content, revision: latest.revision });
    if (draft === latest.content) setDraft(null);
    if (awaitingRefresh) setAwaitingRefresh(false);
  }

  const text = draft ?? baseline?.content ?? "";
  const dirty = baseline !== null && draft !== null && draft !== baseline.content;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const reload = () => {
    setDraft(null);
    setError(null);
    setAwaitingRefresh(false);
    view.refresh();
  };

  const save = async () => {
    if (!baseline || draft === null || !dirty || saving) return;
    setSaving(true);
    setError(null);
    const result = await update({
      environmentId,
      input: {
        operation: "profile_save",
        providerInstanceId,
        document,
        content: draft,
        expectedRevision: baseline.revision,
      },
    });
    setSaving(false);
    if (result._tag !== "Success") {
      // Keep the draft. A conflict or an unknown outcome is resolved by the user, never retried.
      if (!isAtomCommandInterrupted(result)) {
        setError(failureMessage(result, `${label} could not be saved.`));
      }
      return;
    }
    setAwaitingRefresh(true);
    toastManager.add({ type: "success", title: `${label} saved` });
    appAtomRegistry.refresh(
      museAgentFeatureReadQuery({
        environmentId,
        input: { operation: "profile_document", providerInstanceId, document },
      }),
    );
    refreshMuseAgent(appAtomRegistry, environmentId);
  };

  if (baseline === null) {
    return view.error === null ? (
      <Loading label={label.toLowerCase()} />
    ) : (
      <Notice title={`${label} could not be loaded.`} error={view.error} onRetry={view.refresh} />
    );
  }

  return (
    <div className="grid gap-2">
      {view.error !== null ? (
        <p role="alert" className="flex items-center gap-2 text-xs text-destructive">
          Could not refresh {label.toLowerCase()}; your text is unchanged.
          <Button size="xs" variant="ghost" onClick={view.refresh}>
            Retry
          </Button>
        </p>
      ) : null}
      <Textarea
        aria-label={`Muse ${label}`}
        value={text}
        readOnly={!canEdit}
        disabled={saving}
        maxLength={1_048_576}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {canEdit
            ? "Edits are saved only when you press Save."
            : "You can read this file but not change it here."}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={saving} onClick={reload}>
            <RefreshIcon /> {error || dirty ? "Discard and reload" : "Reload"}
          </Button>
          <Button
            size="sm"
            disabled={!canEdit || !dirty || saving || awaitingRefresh}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProfileDocuments({
  environmentId,
  providerInstanceId,
  access,
  onDirtyChange,
}: Target & { readonly access: Access; readonly onDirtyChange: (dirty: boolean) => void }) {
  const [document, setDocument] = useState<DocumentKind>("identity");
  const [pending, setPending] = useState<DocumentKind | null>(null);
  const [dirty, setDirty] = useState(false);
  const handleDirty = (value: boolean) => {
    setDirty(value);
    onDirtyChange(value);
  };
  const canRead = access.operations === null || access.operations.includes("read_document");
  const canEdit =
    access.canWrite && access.operations !== null && access.operations.includes("save_document");
  const selected = DOCUMENTS.find((item) => item.id === document) ?? DOCUMENTS[0]!;

  if (!canRead) {
    return <p className="py-4 text-sm text-muted-foreground">Muse files are not available here.</p>;
  }
  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-medium text-foreground">Files</h3>
      <div role="group" aria-label="Muse file" className="flex gap-1">
        {DOCUMENTS.map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant={document === item.id ? "secondary" : "ghost-muted"}
            aria-pressed={document === item.id}
            onClick={() => {
              if (item.id === document) return;
              if (dirty) setPending(item.id);
              else setDocument(item.id);
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <ProfileDocumentEditor
        key={document}
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        document={document}
        label={selected.label}
        canEdit={canEdit}
        onDirtyChange={handleDirty}
      />
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => (open ? null : setPending(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits to {selected.label} have not been saved. Switching files discards them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep editing</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (pending) setDocument(pending);
                setPending(null);
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

/** Muse's plain-text identity, personality and memory files. Native writes only. */
export function MuseAgentProfileSection({
  environmentId,
  providerInstanceId,
  operations,
  canWrite,
  onDirtyChange,
}: Target & {
  readonly operations: ReadonlyArray<string> | null;
  readonly canWrite: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const access = { operations, canWrite };
  return (
    <div className="grid gap-6">
      <ProfileDocuments
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        access={access}
        onDirtyChange={onDirtyChange}
      />
    </div>
  );
}
