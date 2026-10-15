import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";

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
import { toastManager } from "~/components/ui/toast";
import { museAgentFeatureReadQuery, museAgentFeatureUpdate } from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

type BlockedReason = "legacy_context" | "run_active" | "context_changed";

const BLOCKED_COPY: Record<BlockedReason, string> = {
  legacy_context: "This older delivery can't be released from T3. Check Muse directly.",
  run_active: "Muse is still running. Wait for it to finish, then refresh.",
  context_changed: "The conversation changed. Check Muse directly before sending again.",
};

/**
 * Native Muse deliveries T3 is still tracking after an interrupted send. Renders nothing unless
 * the server reports pending rows. Releasing only drops T3's tracking: it never cancels Muse or
 * resends, and the server decides whether each row is releasable.
 */
export function MuseAgentDeliveryRecovery({
  environmentId,
  providerInstanceId,
  sessionId,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId?: string | undefined;
  readonly canWrite: boolean;
}) {
  const read = useEnvironmentQuery(
    museAgentFeatureReadQuery({
      environmentId,
      input: {
        operation: "pending_deliveries",
        providerInstanceId,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    }),
  );
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const pending = read.data?.operation === "pending_deliveries" ? read.data.data : null;
  const [releasing, setReleasing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pending === null || pending.deliveries.length === 0) return null;

  const release = async () => {
    if (releasing === null) return;
    setBusy(true);
    setError(null);
    const result = await update({
      environmentId,
      input: {
        operation: "delivery_release",
        providerInstanceId,
        sessionId: pending.sessionId,
        deliveryKey: releasing,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not release tracking. Refresh and try again.",
      );
      return;
    }
    // The row clears only once the server no longer reports it.
    read.refresh();
    toastManager.add({ type: "success", title: "Local tracking released" });
    setReleasing(null);
  };

  return (
    <section aria-label="Pending deliveries" className="grid gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">Pending deliveries</h4>
        <Button size="xs" variant="ghost-muted" onClick={read.refresh}>
          <RefreshIcon /> Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        T3 is still tracking a message sent to Muse. Releasing it does not stop Muse or resend.
      </p>
      {read.error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          Could not refresh deliveries; showing the last result.
        </p>
      ) : null}
      <ul className="grid gap-2">
        {pending.deliveries.map((delivery, index) => (
          <li
            key={delivery.deliveryKey}
            className="flex min-w-0 flex-wrap items-center justify-between gap-2"
          >
            <div className="grid min-w-0 gap-0.5">
              <span className="flex items-center gap-2 text-sm text-foreground">
                Delivery {index + 1}
                <Badge variant="outline">
                  {delivery.status === "accepted" ? "Accepted" : "Sending"}
                </Badge>
              </span>
              {!delivery.releasable && delivery.blockedReason !== null ? (
                <span className="text-xs text-muted-foreground">
                  {BLOCKED_COPY[delivery.blockedReason]}
                </span>
              ) : null}
            </div>
            {delivery.releasable ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite || busy}
                onClick={() => {
                  setError(null);
                  setReleasing(delivery.deliveryKey);
                }}
              >
                Release local tracking
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <AlertDialog
        open={releasing !== null}
        onOpenChange={(open) => (open || busy ? null : setReleasing(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Release local tracking?</AlertDialogTitle>
            <AlertDialogDescription>
              Muse may still be running. This releases T3’s tracking so a new message can be sent.
              It does not stop Muse or resend the previous message.
            </AlertDialogDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={busy}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void release()}>
              {busy ? "Releasing…" : "Release tracking"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
