import { MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Alert, AlertDescription } from "../ui/alert";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import type { PinnedGrokBotVoiceCall } from "./useGrokBotVoiceCall";
import { useGrokBotVoiceCall } from "./useGrokBotVoiceCall";
import { voiceCallStatusLabel } from "./GrokBotVoiceCallPanel";

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

  // The shell reserves this footer below the route, so the composer and tool panels shrink with it.
  return (
    <div
      role="region"
      aria-label="Active voice call"
      className="flex min-w-0 shrink-0 justify-end border-t border-border bg-background px-2 pb-safe"
    >
      <div className="flex min-h-11 min-w-0 w-full items-center gap-2 py-1 sm:min-h-0 sm:w-auto sm:max-w-full sm:gap-1 [-webkit-app-region:no-drag]">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="touch-sm"
                className="min-w-0 flex-1 sm:flex-initial"
                aria-label={`Call details for ${call.botName}, ${voiceCallStatusLabel(state)}`}
              />
            }
          >
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />
            <span className="flex min-w-0 flex-col items-start sm:flex-row sm:items-center sm:gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={<span className="min-w-0 max-w-full truncate sm:max-w-40" />}
                >
                  {call.botName}
                </TooltipTrigger>
                <TooltipPopup side="bottom">{call.botName}</TooltipPopup>
              </Tooltip>
              <span className="max-w-full truncate text-xs text-muted-foreground sm:text-sm">
                {voiceCallStatusLabel(state)}
              </span>
            </span>
          </PopoverTrigger>
          <PopoverPopup align="end" side="top" width="sm">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <PopoverTitle className="break-words">Call {call.botName}</PopoverTitle>
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {voiceCallStatusLabel(state)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {state.muted ? "Microphone off" : "Microphone on"}. Bot audio stays on.
                </p>
              </div>
              {state.notice !== null ? (
                <Alert variant="warning" aria-live="polite">
                  <AlertDescription>{state.notice}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </PopoverPopup>
        </Popover>
        <Button
          variant="ghost"
          size="icon-touch-sm"
          aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}
          title={state.muted ? "Microphone off" : "Microphone on"}
          aria-pressed={state.muted}
          onClick={() => onSetMuted(!state.muted)}
        >
          {state.muted ? <MicOffIcon /> : <MicIcon />}
        </Button>
        <Button variant="destructive" size="icon-touch-sm" aria-label="Hang up" onClick={onHangUp}>
          <PhoneOffIcon />
        </Button>
      </div>
    </div>
  );
}
