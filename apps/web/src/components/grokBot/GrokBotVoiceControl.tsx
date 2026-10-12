import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { PhoneIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { grokBotsListQuery } from "~/state/grokBots";
import { grokBotsVoiceStart } from "~/state/grokBotVoice";
import { useEnvironmentQuery } from "~/state/query";

import type { GrokBotVoiceCallState } from "./grokBotVoiceCall";
import { GrokBotVoiceCallPanel } from "./GrokBotVoiceCallPanel";
import { useGrokBotVoiceCall } from "./useGrokBotVoiceCall";

/**
 * Header control for calling this thread's bot. The popover is only a panel: closing it leaves a
 * live call running, and the dock keeps the call visible. A live call for another bot is shown
 * as-is, and this bot can only start once that call ends.
 */
export function GrokBotVoiceControl(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly fallbackTitle: string;
}) {
  const { environmentId, botId, fallbackTitle } = props;
  const [open, setOpen] = useState(false);
  const { call, start, hangUp, setMuted } = useGrokBotVoiceCall();
  const canCall = useAtomValue(grokBotsVoiceStart.permissionAtom(environmentId));
  const roster = useEnvironmentQuery(grokBotsListQuery({ environmentId, input: {} })).data;
  const botName = roster?.find((entry) => entry.id === botId)?.name ?? fallbackTitle;
  const ownTarget = { environmentId, botId, botName };

  const live = call !== null && call.state.phase !== "idle";
  const sameBot = call !== null && call.environmentId === environmentId && call.botId === botId;
  const inThisCall = live && sameBot;
  // Shows the pinned call whenever one is live or ended for this bot; otherwise this bot's idle panel.
  const shown = call !== null && (live || sameBot) ? call : { ...ownTarget, state: IDLE_STATE };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Toggle
            aria-label="Voice call"
            className="relative shrink-0 [-webkit-app-region:no-drag]"
            pressed={inThisCall}
            variant="ghost"
            size="touch-sm"
          />
        }
      >
        <PhoneIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup align="end" width="md">
        <GrokBotVoiceCallPanel
          botName={shown.botName}
          state={shown.state}
          start={live ? undefined : { canStart: canCall, onStart: () => start(ownTarget) }}
          hint={live && !sameBot ? `Hang up ${call.botName} to call ${botName}.` : null}
          onSetMuted={setMuted}
          onHangUp={hangUp}
        />
      </PopoverPopup>
    </Popover>
  );
}

const IDLE_STATE: GrokBotVoiceCallState = { phase: "idle", muted: false, notice: null };
