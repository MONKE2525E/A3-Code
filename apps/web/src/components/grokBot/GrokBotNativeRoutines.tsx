import { useNowMinute } from "../../hooks/useNowMinute";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type GrokBotRoutine as GrokBotRoutineSchema,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { relativeLabel } from "../settings/ScheduledTasksSettings";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  grokBotsDeleteRoutine,
  grokBotsListQuery,
  grokBotsRoutinesQuery,
  grokBotsSetRoutineEnabled,
  grokBotsStatusQuery,
} from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  GROK_BOT_ROUTINES_SETTINGS_HASH,
  grokBotRoutineNextRunIso,
  grokBotRoutineSummary,
  groupGrokBotRoutines,
} from "./grokBotRoutines";
import { grokBotNativeReady } from "./grokBotConnection";

type GrokBotRoutine = typeof GrokBotRoutineSchema.Type;

/**
 * Routines the Grok Bot account owns and runs itself. They appear beside T3's scheduled tasks
 * but T3 never schedules or fires them: it only shows them and pauses or resumes one.
 * New routines are created by asking a bot in chat.
 */
export function GrokBotNativeRoutines({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const status = useEnvironmentQuery(grokBotsStatusQuery({ environmentId, input: {} }));
  const ready = grokBotNativeReady(status.data);
  const routines = useEnvironmentQuery(
    ready ? grokBotsRoutinesQuery({ environmentId, input: {} }) : null,
  );
  const roster = useEnvironmentQuery(
    ready ? grokBotsListQuery({ environmentId, input: {} }) : null,
  );
  useRelativeTimeTick(60_000);
  if (!ready) return null;
  const groups = routines.data
    ? groupGrokBotRoutines(routines.data.routines, roster.data ?? [])
    : [];
  const unavailable = routines.data?.unavailableBotIds.length ?? 0;
  return (
    <SettingsSection id={GROK_BOT_ROUTINES_SETTINGS_HASH} title="Grok Bot routines">
      {routines.error ? (
        <SettingsRow
          title="Could not load Grok Bot routines"
          description={routines.error}
          control={
            <Button size="sm" variant="outline" onClick={() => routines.refresh()}>
              Retry
            </Button>
          }
        />
      ) : !routines.data ? (
        <SettingsRow title="Loading Grok Bot routines…" role="status" />
      ) : (
        <>
          {groups.length === 0 && unavailable === 0 ? (
            <SettingsRow
              title="No Grok Bot routines"
              description="Ask a bot in chat to create one. Grok Bot runs its routines itself."
            />
          ) : (
            groups.flatMap((group) =>
              group.routines.map((routine) => (
                <NativeRoutineRow
                  key={`${routine.botId}:${routine.id}`}
                  environmentId={environmentId}
                  routine={routine}
                  botLabel={group.botLabel}
                />
              )),
            )
          )}
          {unavailable > 0 ? (
            <SettingsRow
              title="Some bots' routines could not be read"
              description="They are left out of this list, not empty. Reload to try again."
              role="status"
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

function NativeRoutineRow({
  environmentId,
  routine,
  botLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly routine: GrokBotRoutine;
  readonly botLabel: string;
}) {
  const canOperate = useAtomValue(grokBotsSetRoutineEnabled.permissionAtom(environmentId));
  const canDelete = useAtomValue(grokBotsDeleteRoutine.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const setEnabled = useAtomCommand(grokBotsSetRoutineEnabled, {
    label: "grok bot routine enabled",
  });
  const deleteRoutine = useAtomCommand(grokBotsDeleteRoutine, {
    label: "grok bot routine deleted",
  });
  const nowMinute = useNowMinute();
  const nextIso = grokBotRoutineNextRunIso(routine.nextRunAt);
  const nextCopy = !routine.isEnabled
    ? "Paused"
    : nextIso === null
      ? "Not scheduled"
      : `Next run ${relativeLabel(nextIso, Date.parse(nowMinute))}`;
  const toggle = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result = await setEnabled({
      environmentId,
      input: { botId: routine.botId, routineId: routine.id, isEnabled: !routine.isEnabled },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update Grok Bot routine",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  const remove = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const confirmed = await requestConfirmDialog(
      `Delete "${routine.name}"?\nGrok Bot stops running this routine. This can't be undone.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await deleteRoutine({
      environmentId,
      input: { botId: routine.botId, routineId: routine.id },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not delete Grok Bot routine",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <SettingsRow
      title={routine.name}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{botLabel}</Badge>
          <span>
            {grokBotRoutineSummary(routine)} · {nextCopy}
          </span>
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={`Delete ${routine.name}`}
            disabled={busy || !canDelete}
            onClick={() => void remove()}
          >
            <Trash2Icon />
          </Button>
          <Switch
            checked={routine.isEnabled}
            disabled={busy || !canOperate}
            aria-label={`Enable ${routine.name}`}
            onCheckedChange={() => void toggle()}
          />
        </div>
      }
    />
  );
}
