import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon } from "lucide-react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

import type { GrokBotVoiceCallState, GrokBotVoicePhase } from "./grokBotVoiceCall";

const STATUS_LABEL: Record<GrokBotVoicePhase, string> = {
  idle: "Not in a call",
  starting: "Starting…",
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
};

function voiceCallStatusLabel(state: GrokBotVoiceCallState): string {
  return state.phase === "live" && state.muted ? "Muted" : STATUS_LABEL[state.phase];
}

/**
 * The call's controls, shared by the thread header and the app-shell dock. `start` is only offered
 * when this panel may begin a new call; a live call always shows its own mute and hang-up controls.
 */
export function GrokBotVoiceCallPanel(props: {
  readonly botName: string;
  readonly state: GrokBotVoiceCallState;
  readonly start?: { readonly canStart: boolean; readonly onStart: () => void } | undefined;
  readonly hint?: string | null | undefined;
  readonly onSetMuted: (muted: boolean) => void;
  readonly onHangUp: () => void;
}) {
  const { botName, state, start, hint, onSetMuted, onHangUp } = props;
  const inCall = state.phase !== "idle";
  const starting = state.phase === "starting";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="break-words text-sm font-medium text-foreground">Call {botName}</p>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {voiceCallStatusLabel(state)}
        </p>
      </div>
      {state.notice !== null ? (
        <Alert variant="warning" aria-live="polite">
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {inCall ? (
        <p className="text-xs text-muted-foreground">
          {state.muted ? "Microphone off" : "Microphone on"}. Bot audio stays on.
        </p>
      ) : null}
      {inCall ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="touch-sm"
            aria-pressed={state.muted}
            onClick={() => onSetMuted(!state.muted)}
          >
            {state.muted ? <MicOffIcon /> : <MicIcon />}
            {state.muted ? "Unmute mic" : "Mute mic"}
          </Button>
          <Button variant="destructive" size="touch-sm" onClick={onHangUp}>
            <PhoneOffIcon />
            Hang up
          </Button>
        </div>
      ) : start ? (
        <Button
          size="touch-sm"
          disabled={!start.canStart || starting}
          onClick={start.onStart}
          className="self-start"
        >
          <PhoneIcon />
          {starting ? "Starting…" : "Start call"}
        </Button>
      ) : null}
    </div>
  );
}
