import * as Schema from "effect/Schema";

export const MUSE_DICTATION_SAMPLE_RATE = 24_000;
export const MUSE_DICTATION_MAX_SECONDS = 60;
export const MUSE_DICTATION_MAX_BYTES = MUSE_DICTATION_SAMPLE_RATE * MUSE_DICTATION_MAX_SECONDS * 2;
export const MuseAgentDictationLanguage = Schema.Literals([
  "auto",
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ja",
  "ko",
  "zh",
  "ru",
  "ar",
  "hi",
  "nl",
  "pl",
  "uk",
]);
export type MuseAgentDictationLanguage = typeof MuseAgentDictationLanguage.Type;
export const MuseAgentDictationStatus = Schema.Struct({
  available: Schema.Boolean,
  engineDetected: Schema.Boolean,
  modelDetected: Schema.Boolean,
  local: Schema.Literal(true),
  sampleRateHz: Schema.Literal(MUSE_DICTATION_SAMPLE_RATE),
  maxAudioSeconds: Schema.Literal(MUSE_DICTATION_MAX_SECONDS),
  reason: Schema.Literals(["ready", "unsupported_host", "engine_missing", "model_missing"]),
});
export type MuseAgentDictationStatus = typeof MuseAgentDictationStatus.Type;
export const MuseAgentDictationTranscript = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(16_000)),
});
export type MuseAgentDictationTranscript = typeof MuseAgentDictationTranscript.Type;
/** Only bounded PCM16LE mono recordings at the declared sample rate cross this endpoint. */
export const MuseAgentDictationPcm = Schema.Uint8Array.check(
  Schema.isMinLength(6),
  Schema.isMaxLength(MUSE_DICTATION_MAX_BYTES),
  Schema.makeFilter((bytes) => bytes.byteLength % 2 === 0),
);
export class MuseAgentDictationRequestError extends Schema.TaggedError<MuseAgentDictationRequestError>()(
  "MuseAgentDictationRequestError",
  {
    code: Schema.Literals([
      "unavailable",
      "invalid_audio",
      "busy",
      "timeout",
      "failed",
      "no_speech",
      "account_changed",
    ]),
  },
  { httpApiStatus: 422 },
) {
  override get message(): string {
    switch (this.code) {
      case "unavailable":
        return "Prepare Muse for Linux's speech helper and model to use local dictation.";
      case "invalid_audio":
        return "Record at most 60 seconds of 24 kHz mono PCM16 audio.";
      case "busy":
        return "Another recording is still being transcribed. Try again when it finishes.";
      case "timeout":
        return "Local speech recognition timed out. Try a shorter recording.";
      case "no_speech":
        return "No speech was detected in this recording.";
      case "account_changed":
        return "The selected Muse account changed. Restore its connection before transcribing.";
      case "failed":
        return "Local speech recognition failed. Try again.";
    }
  }
}
