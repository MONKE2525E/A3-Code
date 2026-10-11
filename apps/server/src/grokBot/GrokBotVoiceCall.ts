import type { GrokBotVoiceCallMarker } from "@t3tools/contracts";

const VOICE_CHANNEL_PREFIX = "voice:";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Bounded fields from native's `voice-call` entry; anything absent or malformed stays absent. */
export function grokBotVoiceCallMarker(value: unknown): GrokBotVoiceCallMarker | undefined {
  const call = record(value);
  const callId = typeof call?.callId === "string" ? call.callId.trim() : "";
  if (callId.length === 0 || callId.length > 128) return undefined;
  const durationMs =
    typeof call?.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= 0
      ? call.durationMs
      : undefined;
  const ending =
    typeof call?.ending === "string" && call.ending.trim().length > 0 && call.ending.length <= 64
      ? call.ending.trim()
      : undefined;
  return {
    callId,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(ending === undefined ? {} : { ending }),
  };
}

/** Native tags a call's summary with `channel: "voice:<callId>"`; anything else is not a call's. */
export function grokBotVoiceCallIdFromChannel(channel: unknown): string | undefined {
  if (typeof channel !== "string" || !channel.startsWith(VOICE_CHANNEL_PREFIX)) return undefined;
  const callId = channel.slice(VOICE_CHANNEL_PREFIX.length).trim();
  return callId.length === 0 || callId.length > 128 ? undefined : callId;
}

/**
 * Native writes a voice call's follow-up instruction as a user message on its `voice:` channel and
 * marks it `suppressed`. Only that marked row is hidden; a user's own voice utterance stays visible.
 */
export function isGrokBotVoiceCallInstruction(entry: Record<string, unknown>): boolean {
  return (
    entry.kind === "message" &&
    entry.role === "user" &&
    typeof entry.channel === "string" &&
    entry.channel.startsWith(VOICE_CHANNEL_PREFIX) &&
    entry.suppressed !== undefined &&
    entry.suppressed !== null
  );
}
