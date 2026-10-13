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
import { useCallback, useEffect, useRef, useState } from "react";

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
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { museAgentComputerStreamCommand, museAgentFeatureUpdate } from "~/state/museAgent";
import { useAtomCommand } from "~/state/use-atom-command";

type Lease = NonNullable<MuseAgentComputerTaskDetail["state"]["lease"]>;

/** A lease this viewer took, with the exact target it was taken on so release never goes elsewhere. */
type HeldLease = {
  readonly takeoverId: string;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: string;
  readonly taskId: string;
};

const HEARTBEAT_MS = 10_000;
const CONFIRM_TIMEOUT_MS = 10_000;
// The backend bounds viewer size; ask for something that fits a settings panel comfortably.
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1200;

type Phase = "idle" | "connecting" | "live";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function viewerSize(element: HTMLElement | null) {
  return {
    width: clamp(Math.round(element?.clientWidth || 800), 320, MAX_WIDTH),
    height: clamp(Math.round(element?.clientHeight || 500), 240, MAX_HEIGHT),
    devicePixelRatio: clamp(window.devicePixelRatio || 1, 1, 2),
  };
}

function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/**
 * Interactive view of Muse's computer. It only exists while the user holds the native takeover
 * lease for this exact task: the stream handshake needs write access, so there is no view-only
 * connection. The socket URL carries a one-use ticket; it is never shown, logged, or stored.
 */
export function MuseAgentComputerViewer({
  environmentId,
  providerInstanceId,
  sessionId,
  task,
  lease,
  canWrite,
  onTakeover,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: string;
  readonly task: MuseAgentComputerTask;
  readonly lease: Lease | null;
  readonly canWrite: boolean;
  /** Called after a successful takeover so the task detail refreshes and reports the new lease. */
  readonly onTakeover: () => void;
}) {
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const prepareStream = useAtomCommand(museAgentComputerStreamCommand, { reportFailure: false });
  const taskId = task.taskId;
  const ownedTakeoverId =
    lease !== null && lease.controlOwner === "user" && lease.taskId === taskId
      ? lease.takeoverId
      : null;
  const leaseExpiresAtMs = ownedTakeoverId === null ? null : (lease?.controlExpiresAtMs ?? null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [wantsView, setWantsView] = useState(false);
  // The lease id the takeover receipt returned. A task refresh must show exactly this lease before
  // the view connects; no other lease is ever adopted by ID inference.
  const [receiptId, setReceiptId] = useState<string | null>(null);
  // The confirmed lease this viewer took; release is sent once, for exactly this lease and target.
  const [held, setHeld] = useState<string | null>(null);
  // Set from the receipt, before confirmation, so unmount or timeout releases exactly that lease.
  const heldRef = useRef<HeldLease | null>(null);
  const updateRef = useRef(update);
  const targetRef = useRef({ environmentId, providerInstanceId, sessionId, taskId });
  const mountedRef = useRef(true);
  useEffect(() => {
    updateRef.current = update;
  }, [update]);
  useEffect(() => {
    targetRef.current = { environmentId, providerInstanceId, sessionId, taskId };
  }, [environmentId, providerInstanceId, sessionId, taskId]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sendRelease = useCallback((lease: HeldLease) => {
    void updateRef.current({
      environmentId: lease.environmentId,
      input: {
        operation: "computer_action",
        providerInstanceId: lease.providerInstanceId,
        sessionId: lease.sessionId,
        taskId: lease.taskId,
        command: { action: "release", takeoverId: lease.takeoverId },
      },
    });
  }, []);

  /** Closes the view and, when `release` is set, gives back the lease we hold. */
  const endView = useCallback(
    (why: string | null, release = true) => {
      const lease = heldRef.current;
      heldRef.current = null;
      if (release && lease !== null) sendRelease(lease);
      setHeld(null);
      setReceiptId(null);
      setWantsView(false);
      setPhase("idle");
      setMessage(why);
    },
    [sendRelease],
  );

  // Best-effort release of our own lease when this task's viewer goes away.
  useEffect(
    () => () => {
      const lease = heldRef.current;
      heldRef.current = null;
      if (lease !== null) sendRelease(lease);
    },
    [sendRelease],
  );

  const takeControl = async () => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    // Captured before the await: the receipt belongs to this target and generation only.
    const target = { environmentId, providerInstanceId, sessionId, taskId };
    const priorTakeoverId = ownedTakeoverId;
    const result = await update({
      environmentId,
      input: {
        operation: "computer_action",
        providerInstanceId,
        sessionId,
        taskId,
        command: { action: "takeover", viewer: viewerSize(containerRef.current) },
      },
    });
    const receipt = result._tag === "Success" ? result.value.computerState?.lease : undefined;
    const receiptTakeoverId =
      receipt != null &&
      receipt.controlOwner === "user" &&
      receipt.taskId === target.taskId &&
      receipt.takeoverId !== null &&
      receipt.takeoverId !== priorTakeoverId &&
      (receipt.controlExpiresAtMs === null || receipt.controlExpiresAtMs > Date.now())
        ? receipt.takeoverId
        : null;
    const current = targetRef.current;
    const sameTarget =
      mountedRef.current &&
      current.environmentId === target.environmentId &&
      current.providerInstanceId === target.providerInstanceId &&
      current.sessionId === target.sessionId &&
      current.taskId === target.taskId;
    if (!sameTarget) {
      // The target moved on while taking over; give back exactly what was granted there.
      if (receiptTakeoverId !== null) sendRelease({ ...target, takeoverId: receiptTakeoverId });
      if (mountedRef.current) setPending(false);
      return;
    }
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setMessage(
        failureMessage(
          squashAtomCommandFailure(result),
          "Could not take control. Refresh to check the task.",
        ),
      );
      setConfirming(false);
      return;
    }
    setConfirming(false);
    if (receiptTakeoverId === null) {
      setMessage(
        "Could not confirm control of this task. Check the task state before trying again.",
      );
      onTakeover();
      return;
    }
    heldRef.current = { ...target, takeoverId: receiptTakeoverId };
    setReceiptId(receiptTakeoverId);
    setWantsView(true);
    onTakeover();
  };

  const releaseControl = () => endView("Control released.");

  // Connect only once a refresh shows exactly the receipt's lease. A different user lease means the
  // receipt was replaced: close and release only the lease we were granted. A target change or lost
  // lease drops the view the same way.
  useEffect(() => {
    const lease = heldRef.current;
    if (lease === null || receiptId === null) return;
    const sameTarget =
      lease.environmentId === environmentId &&
      lease.providerInstanceId === providerInstanceId &&
      lease.sessionId === sessionId &&
      lease.taskId === taskId;
    if (!sameTarget) {
      endView("Control ended. Take control again to reconnect.");
      return;
    }
    if (held !== null) {
      if (ownedTakeoverId !== held) endView("Control ended. Take control again to reconnect.");
      return;
    }
    if (ownedTakeoverId === receiptId) {
      if (leaseExpiresAtMs !== null && leaseExpiresAtMs <= Date.now()) return;
      setHeld(receiptId);
    } else if (ownedTakeoverId !== null) {
      // A user lease other than ours is visible; our receipt no longer matches the task.
      endView("Control of this task changed hands. Take control again to reconnect.");
    }
  }, [
    held,
    receiptId,
    ownedTakeoverId,
    leaseExpiresAtMs,
    environmentId,
    providerInstanceId,
    sessionId,
    taskId,
    endView,
  ]);

  // The task refresh must confirm the receipt promptly; never wait on it forever.
  useEffect(() => {
    if (receiptId === null || held !== null) return;
    const timer = window.setTimeout(
      () => endView("Could not confirm control of this task. Check the task state and try again."),
      CONFIRM_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [receiptId, held, endView]);

  useEffect(() => {
    if (leaseExpiresAtMs === null || held === null) return;
    const timer = window.setTimeout(
      () => endView("Control expired. Take control again to reconnect."),
      Math.max(0, leaseExpiresAtMs - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [leaseExpiresAtMs, held, endView]);

  // Heartbeat runs only while this viewer holds the lease it took and is connected.
  useEffect(() => {
    if (phase !== "live" || held === null) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      const result = await updateRef.current({
        environmentId,
        input: {
          operation: "computer_action",
          providerInstanceId,
          sessionId,
          taskId,
          command: { action: "heartbeat", takeoverId: held },
        },
      });
      if (stopped || result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      endView("Lost contact with Muse's computer. Take control again to reconnect.");
    }, HEARTBEAT_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [phase, held, environmentId, providerInstanceId, sessionId, taskId, endView]);

  // noVNC connection: fresh ticket each time it opens, torn down on hide, target change, or exit.
  // It never reconnects on its own; the user takes control again.
  useEffect(() => {
    const container = containerRef.current;
    if (!wantsView || held === null || container === null) return;
    let cancelled = false;
    let disconnect: (() => void) | null = null;
    // The receipt's lease, captured now: the backend rejects the stream if another lease replaced it.
    const heldLease = heldRef.current;
    if (heldLease === null) return;
    setPhase("connecting");
    void (async () => {
      const ticket = await prepareStream({
        environmentId,
        input: { providerInstanceId, sessionId, taskId, takeoverId: heldLease.takeoverId },
      });
      if (cancelled) return;
      if (ticket._tag === "Failure") {
        if (isAtomCommandInterrupted(ticket)) return;
        endView(
          failureMessage(squashAtomCommandFailure(ticket), "The live view could not be opened."),
        );
        return;
      }
      const socketUrl = ticket.value.socketUrl;
      const { default: RFB } = await import("@novnc/novnc");
      if (cancelled) return;
      const rfb = new RFB(container, socketUrl, { shared: true });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.viewOnly = false;
      disconnect = () => rfb.disconnect();
      rfb.addEventListener("connect", () => {
        if (!cancelled) setPhase("live");
      });
      rfb.addEventListener("credentialsrequired", () => {
        if (!cancelled) endView("The live view needs credentials this app cannot provide.");
      });
      rfb.addEventListener("securityfailure", () => {
        if (!cancelled) endView("The live view could not be secured.");
      });
      rfb.addEventListener("disconnect", (event) => {
        if (cancelled) return;
        const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean;
        endView(
          clean
            ? "The live view ended."
            : "The live view disconnected. Take control again to reconnect.",
        );
      });
    })();
    return () => {
      cancelled = true;
      disconnect?.();
      container.replaceChildren();
    };
  }, [
    wantsView,
    held,
    environmentId,
    providerInstanceId,
    sessionId,
    taskId,
    prepareStream,
    endView,
  ]);

  const active = wantsView && held !== null;
  const foreign = lease !== null && ownedTakeoverId === null && lease.controlOwner !== "user";

  return (
    <div className="grid gap-2">
      {active ? (
        <div className="grid gap-1">
          <div
            ref={containerRef}
            className="relative h-80 w-full overflow-hidden rounded-md border bg-black"
          >
            {phase !== "live" ? (
              <div
                role="status"
                className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-white/80"
              >
                <Spinner className="size-3.5" /> Connecting…
              </div>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Live view · you are controlling this task. Muse waits until you release control.
          </p>
        </div>
      ) : (
        <div ref={containerRef} className="hidden" />
      )}
      {wantsView && held === null ? (
        <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" /> Waiting for control to be confirmed…
        </div>
      ) : null}
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      {foreign ? (
        <p className="text-xs text-muted-foreground">
          Muse currently has control of this task. Taking control interrupts it.
        </p>
      ) : null}
      {!canWrite ? (
        <p className="text-xs text-muted-foreground">
          Live control needs permission to operate on this environment.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <Button size="sm" variant="outline" onClick={releaseControl}>
            Release control
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite || pending || wantsView}
            onClick={() => setConfirming(true)}
          >
            Take control
          </Button>
        )}
      </div>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => (open || pending ? null : setConfirming(false))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Take control of this task?</AlertDialogTitle>
            <AlertDialogDescription>
              You will control “{task.title}” on Muse's computer and Muse pauses until you release
              it. The live view is only available while you hold control, and it closes if control
              expires or the connection drops.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={pending}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={pending}
              onClick={() =>
                void takeControl().catch(() =>
                  toastManager.add({ type: "error", title: "Could not take control" }),
                )
              }
            >
              {pending ? "Taking control…" : "Take control"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
