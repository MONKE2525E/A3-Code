import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CalendarClockIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import { useThreadProjection } from "../../state/entities";
import { grokBotsRoutinesQuery, grokBotsSetRoutineEnabled } from "../../state/grokBots";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  GROK_BOT_ROUTINES_SETTINGS_HASH,
  grokBotRoutineSummary,
  grokBotRoutinesSettingsSearch,
} from "../grokBot/grokBotRoutines";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

/** The bot's native routines, using the same query and mutations as Scheduled tasks. */
export function ThreadGrokBotRoutinesPanel({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useThreadProjection(scopeThreadRef(environmentId, threadId))?.projection.thread;
  const botId = thread?.modelSelection.model;
  const routines = useEnvironmentQuery(
    botId ? grokBotsRoutinesQuery({ environmentId, input: {} }) : null,
  );
  const canOperate = useAtomValue(grokBotsSetRoutineEnabled.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(grokBotsSetRoutineEnabled, { label: "bot routine toggle" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const bound = routines.data?.routines.filter((routine) => routine.botId === botId) ?? [];
  const unavailable = routines.data?.unavailableBotIds.some((id) => id === botId);
  if (!botId || (!routines.error && !unavailable && bound.length === 0)) return null;

  const toggle = async (routineId: string, isEnabled: boolean) => {
    if (
      busyId !== null ||
      !canOperate ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyId(routineId);
    const result = await setEnabled({ environmentId, input: { botId, routineId, isEnabled } });
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update routine",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-bot-routines-heading"
      title="Routines"
      actions={
        <ThreadDetailsControl
          size="icon-xs"
          variant="ghost"
          part="icon"
          aria-label="Manage Grok Bot routines"
          render={
            <Link
              to="/settings/scheduled-tasks"
              search={grokBotRoutinesSettingsSearch(environmentId)}
              hash={GROK_BOT_ROUTINES_SETTINGS_HASH}
            />
          }
        >
          <Settings2Icon className="size-3.5" />
        </ThreadDetailsControl>
      }
    >
      {routines.error || unavailable ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          Could not load this bot's routines.
        </p>
      ) : null}
      <ul className="m-0 list-none p-0">
        {bound.map((routine) => (
          <li
            key={routine.id}
            className={`flex items-center rounded-lg py-1.5 ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS}`}
          >
            <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground/80">
                {routine.name}
              </span>
              <p className="truncate text-2xs text-muted-foreground">
                {grokBotRoutineSummary(routine)}
                {routine.isEnabled ? "" : " · paused"}
              </p>
            </div>
            <Switch
              checked={routine.isEnabled}
              disabled={!canOperate || busyId !== null}
              aria-label={`${routine.isEnabled ? "Pause" : "Resume"} ${routine.name}`}
              onCheckedChange={(enabled) => void toggle(routine.id, enabled)}
            />
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
