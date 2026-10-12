import type { GrokBotVoiceCallMarker } from "@t3tools/contracts";
import { PhoneIcon } from "lucide-react";

import { formatGrokBotVoiceCallDuration, grokBotVoiceCallLabel } from "./grokBotConversation";

/** The quiet "Voice chat" line both transcript views share; duration appears only when native recorded one. */
export function GrokBotVoiceCallMarkerLabel({
  marker,
}: {
  readonly marker: GrokBotVoiceCallMarker;
}) {
  return (
    <>
      <PhoneIcon className="size-3.5" aria-hidden />
      <span>{grokBotVoiceCallLabel(marker)}</span>
      {marker.durationMs === undefined ? null : (
        <span className="tabular-nums">{formatGrokBotVoiceCallDuration(marker.durationMs)}</span>
      )}
    </>
  );
}
