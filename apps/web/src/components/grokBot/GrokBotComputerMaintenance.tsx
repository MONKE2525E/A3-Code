import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, GrokBotComputerUpgradeScheduleResult } from "@t3tools/contracts";
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
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { grokBotComputerRecreate, grokBotComputerReset } from "~/state/grokBotComputer";
import { useAtomCommand } from "~/state/use-atom-command";

import { grokBotFailureMessage } from "./grokBotPresentation";

type ComputerAction = "update" | "reset";

type UpgradeSchedule = NonNullable<typeof GrokBotComputerUpgradeScheduleResult.Type.schedule>;

/** Both copies name the account scope, because the computer is shared by every bot on it. */
const ACTIONS: Record<
  ComputerAction,
  {
    readonly label: string;
    readonly title: string;
    readonly description: string;
  }
> = {
  update: {
    label: "Update computer",
    title: "Update the Grok Bot computer?",
    description:
      "This applies to your whole Grok Bot account, so every bot on it is affected. Files and sign-ins stay. Installed apps and packages are removed.",
  },
  reset: {
    label: "Reset computer",
    title: "Reset the Grok Bot computer?",
    description:
      "This restores the computer for your whole Grok Bot account from its last saved snapshot, so every bot on the account is affected. Changes made after that snapshot may be lost. This cannot be undone.",
  },
};

/** Update and reset for the account's computer. Both need a confirmation, and the server rechecks it. */
export function GrokBotComputerMaintenance({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const canManage = useAtomValue(grokBotComputerRecreate.permissionAtom(environmentId));
  const recreate = useAtomCommand(grokBotComputerRecreate, { reportFailure: false });
  const reset = useAtomCommand(grokBotComputerReset, { reportFailure: false });
  const [confirming, setConfirming] = useState<ComputerAction | null>(null);
  const [pending, setPending] = useState<ComputerAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: ComputerAction) => {
    setPending(action);
    setError(null);
    const result =
      action === "reset"
        ? await reset({ environmentId, input: { confirm: true } })
        : await recreate({
            environmentId,
            input: { preserveData: true, confirm: true },
          });
    setPending(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setError(grokBotFailureMessage(squashAtomCommandFailure(result)));
      return;
    }
    if (!result.value.started) {
      setError(
        result.value.reason
          ? `The computer did not start: ${result.value.reason}`
          : "The computer did not start.",
      );
      return;
    }
    toastManager.add({
      type: "success",
      title: action === "update" ? "Computer update started" : "Computer reset started",
    });
  };

  const confirmed = confirming === null ? null : ACTIONS[confirming];
  return (
    <div className="flex flex-col items-end gap-2">
      {canManage ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => setConfirming("update")}
          >
            {pending === "update" ? <Spinner size="xs" /> : null}
            Update computer
          </Button>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={pending !== null}
            onClick={() => setConfirming("reset")}
          >
            {pending === "reset" ? <Spinner size="xs" /> : null}
            Reset computer
          </Button>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">Needs settings write access</span>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmed?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmed?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant={confirming === "reset" ? "destructive" : "default"}
              onClick={() => {
                if (confirming === null) return;
                const action = confirming;
                setConfirming(null);
                void run(action);
              }}
            >
              {confirmed?.label}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** One line for the account's scheduled upgrade. Native status strings are shown as reported. */
export function describeComputerUpgradeSchedule(schedule: UpgradeSchedule | null): string {
  if (schedule === null) return "No upgrade is scheduled.";
  const parts: string[] = [];
  if (schedule.localTime) {
    parts.push(`Runs at ${schedule.localTime}${schedule.timezone ? ` ${schedule.timezone}` : ""}`);
  }
  if (schedule.nextFireAtMs !== undefined) {
    parts.push(`Next ${new Date(schedule.nextFireAtMs).toLocaleString()}`);
  }
  if (schedule.targetImageTag) parts.push(`Target image ${schedule.targetImageTag}`);
  if (schedule.state) parts.push(`State: ${schedule.state}`);
  if (schedule.failureReason) parts.push(`Last attempt failed: ${schedule.failureReason}`);
  return parts.length > 0 ? parts.join(" · ") : "An upgrade is scheduled.";
}
