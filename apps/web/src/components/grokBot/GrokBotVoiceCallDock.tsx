import { MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import type { PinnedGrokBotVoiceCall } from "./useGrokBotVoiceCall";
import { useGrokBotVoiceCall } from "./useGrokBotVoiceCall";
import { GrokBotVoiceCallPanel, voiceCallStatusLabel } from "./GrokBotVoiceCallPanel";

/**
 * A compact, always-visible indicator for a live call, mounted in the app shell so it shows on every
 * route. Closing its popover keeps the indicator, mute, and hang-up in place.
 */
export function GrokBotVoiceCallDock() {
  const { call, hangUp, setMuted } = useGrokBotVoiceCall();
  if (call === null || call.state.phase === "idle") return null;
  return <LiveCallDock call={call} onSetMuted={setMuted} onHangUp={hangUp} />;
}

function LiveCallDock(props: {
  readonly call: PinnedGrokBotVoiceCall;
  readonly onSetMuted: (muted: boolean) => void;
  readonly onHangUp: () => void;
}) {
  const { call, onSetMuted, onHangUp } = props;
  const [open, setOpen] = useState(false);
  const { state } = call;

  // Docked just under the top bar, right-aligned: the composer sits at the bottom of the viewport on
  // every width, so a bottom dock would cover it. Bounded by the gutters so it never leaves the screen.
  return (
    <div className="pointer-events-none fixed top-[calc(var(--workspace-controls-top)+var(--workspace-topbar-height)+0.25rem)] right-(--workspace-controls-right) left-(--workspace-controls-left) z-50 flex justify-end">
      <div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-full border border-border bg-popover p-1 shadow-lg/5 [-webkit-app-region:no-drag]">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Call ${call.botName}, ${voiceCallStatusLabel(state)}`}
              />
            }
          >
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 max-w-40 truncate" />}>
                {call.botName}
              </TooltipTrigger>
              <TooltipPopup side="bottom">{call.botName}</TooltipPopup>
            </Tooltip>
            <span className="shrink-0 text-muted-foreground">{voiceCallStatusLabel(state)}</span>
          </PopoverTrigger>
          <PopoverPopup align="end" side="bottom" className="w-72">
            <GrokBotVoiceCallPanel
              botName={call.botName}
              state={state}
              onSetMuted={onSetMuted}
              onHangUp={onHangUp}
            />
          </PopoverPopup>
        </Popover>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={state.muted ? "Unmute" : "Mute"}
          aria-pressed={state.muted}
          onClick={() => onSetMuted(!state.muted)}
        >
          {state.muted ? <MicOffIcon /> : <MicIcon />}
        </Button>
        <Button variant="destructive" size="icon-sm" aria-label="Hang up" onClick={onHangUp}>
          <PhoneOffIcon />
        </Button>
      </div>
    </div>
  );
}
