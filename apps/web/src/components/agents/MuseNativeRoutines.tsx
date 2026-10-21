import { useNowMinute } from "../../hooks/useNowMinute";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import {
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  museAgentFeatureReadQuery,
  museAgentFeatureUpdate,
  museAgentStatusQuery,
} from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { formatMuseNextRun } from "./museAgentFeatures.logic";
import { groupMuseRoutines } from "./museAgentRoutines";

/** Settings anchor for Muse's routines, listed beside T3's scheduled tasks. */
const MUSE_ROUTINES_SETTINGS_HASH = "muse-routines";

/**
 * Routines Muse owns and runs itself. They appear beside T3's scheduled tasks as a read-through:
 * T3 never schedules or fires them, and deleting one asks Muse to remove it.
 */
export function MuseNativeRoutines({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const status = useEnvironmentQuery(museAgentStatusQuery({ environmentId, input: {} }));
  const providerInstanceId =
    status.data?.ready && status.data.provider ? status.data.provider.instanceId : null;
  const routines = useEnvironmentQuery(
    providerInstanceId === null
      ? null
      : museAgentFeatureReadQuery({
          environmentId,
          input: { operation: "tasks", providerInstanceId },
        }),
  );
  useRelativeTimeTick(60_000);
  if (providerInstanceId === null) return null;
  const tasks = routines.data?.operation === "tasks" ? routines.data.data : null;
  const groups = tasks ? groupMuseRoutines(tasks) : [];
  return (
    <SettingsSection id={MUSE_ROUTINES_SETTINGS_HASH} title="Muse routines">
      {routines.error ? (
        <SettingsRow
          title="Could not load Muse routines"
          description={routines.error}
          control={
            <Button size="sm" variant="outline" onClick={() => routines.refresh()}>
              Retry
            </Button>
          }
        />
      ) : !tasks ? (
        <SettingsRow title="Loading Muse routines…" role="status" />
      ) : groups.length === 0 ? (
        <SettingsRow
          title="No Muse routines"
          description="Ask Muse in chat to create one. Muse runs its own routines."
        />
      ) : (
        groups.flatMap((group) =>
          group.tasks.map((routine) => (
            <MuseRoutineRow
              key={routine.id}
              environmentId={environmentId}
              providerInstanceId={providerInstanceId}
              groupLabel={group.label}
              routine={routine}
            />
          )),
        )
      )}
    </SettingsSection>
  );
}

function MuseRoutineRow({
  environmentId,
  providerInstanceId,
  groupLabel,
  routine,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly groupLabel: string;
  readonly routine: {
    readonly id: string;
    readonly title?: string | undefined;
    readonly nextRunAtUtc?: number | undefined;
    readonly scheduleLabel: string;
  };
}) {
  const canDelete = useAtomValue(museAgentFeatureUpdate.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const update = useAtomCommand(museAgentFeatureUpdate, { label: "muse routine deleted" });
  const name = routine.title?.trim() || "Untitled routine";
  const nextRun = formatMuseNextRun(routine.nextRunAtUtc, Date.parse(useNowMinute()));
  const remove = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const confirmed = await requestConfirmDialog(
      `Delete "${name}"?\nMuse stops running this routine. This can't be undone.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await update({
      environmentId,
      input: { operation: "task_delete", providerInstanceId, jobId: routine.id },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not delete Muse routine",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <SettingsRow
      title={name}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{groupLabel}</Badge>
          <span>
            {routine.scheduleLabel}
            {nextRun ? ` · ${nextRun}` : ""}
          </span>
        </div>
      }
      control={
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label={`Delete ${name}`}
          disabled={busy || !canDelete}
          onClick={() => void remove()}
        >
          <Trash2Icon />
        </Button>
      }
    />
  );
}
