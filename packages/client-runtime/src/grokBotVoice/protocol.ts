/**
 * Wire facts of the xAI realtime socket Grok Bot voice calls dial, taken from the official
 * desktop app: ephemeral secret as a WebSocket subprotocol, 24 kHz mono PCM16 as base64 frames,
 * server VAD, `grok-transcribe` input transcription. Browser-safe: no Node APIs.
 */
export const VOICE_REALTIME_ORIGIN = "wss://api.x.ai/";
export const VOICE_SAMPLE_RATE = 24_000;
export const VOICE_TRANSCRIPTION_MODEL = "grok-transcribe";

export interface VoiceRealtimeCredential {
  readonly clientSecret: string;
  readonly model: string;
  readonly websocketUrl: string;
}

export function isDialableVoiceUrl(value: string): boolean {
  if (!value.startsWith(VOICE_REALTIME_ORIGIN)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      url.host === "api.x.ai" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function realtimeProtocols(credential: VoiceRealtimeCredential): string[] {
  return [`xai-client-secret.${credential.clientSecret}`];
}

/** `conversationId` resumes the same realtime conversation after a dropped socket. */
export function realtimeUrl(credential: VoiceRealtimeCredential, conversationId?: string | null) {
  if (!isDialableVoiceUrl(credential.websocketUrl))
    throw new Error("Voice endpoint is not the allowed realtime origin.");
  const url = new URL(credential.websocketUrl);
  url.searchParams.set("model", credential.model);
  if (conversationId != null && conversationId.length > 0)
    url.searchParams.set("conversation_id", conversationId);
  return url.toString();
}

export interface VoiceSettings {
  readonly voiceId: string | null;
  readonly voiceSpeed: number;
  /** `null` means "let the model detect"; the desktop omits `language_hint` then. */
  readonly voiceLanguage: string | null;
}

export function sessionUpdateFrame(input: {
  readonly instructions: string;
  readonly tools: ReadonlyArray<unknown>;
  readonly voice: VoiceSettings;
  readonly reconnecting: boolean;
}): string {
  const { voice } = input;
  return JSON.stringify({
    type: "session.update",
    session: {
      ...(voice.voiceId === null ? {} : { voice: voice.voiceId }),
      ...(input.reconnecting ? { keep_context: false } : {}),
      instructions: input.instructions,
      turn_detection: { type: "server_vad" },
      audio: {
        input: {
          format: { type: "audio/pcm", rate: VOICE_SAMPLE_RATE },
          transcription: {
            model: VOICE_TRANSCRIPTION_MODEL,
            ...(voice.voiceLanguage === null ? {} : { language_hint: voice.voiceLanguage }),
          },
        },
        output: { format: { type: "audio/pcm", rate: VOICE_SAMPLE_RATE }, speed: voice.voiceSpeed },
      },
      tools: input.tools,
    },
  });
}

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return new Uint8Array(out.buffer);
}

export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength - (bytes.byteLength % 2),
  );
  const out = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function audioAppendFrame(samples: Float32Array): string {
  return JSON.stringify({
    type: "input_audio_buffer.append",
    audio: toBase64(floatToPcm16(samples)),
  });
}

export function functionCallOutputFrame(callId: string, output: string): string {
  return JSON.stringify({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output },
  });
}

export function responseCreateFrame(instructions: string | null): string {
  return JSON.stringify(
    instructions === null
      ? { type: "response.create" }
      : { type: "response.create", response: { instructions } },
  );
}

export function truncateFrame(cut: { itemId: string; contentIndex: number; audioEndMs: number }) {
  return JSON.stringify({
    type: "conversation.item.truncate",
    item_id: cut.itemId,
    content_index: cut.contentIndex,
    audio_end_ms: Math.round(cut.audioEndMs),
  });
}

export type VoiceServerEvent =
  | { readonly type: "session.ready" }
  | { readonly type: "conversation.created"; readonly conversationId: string | null }
  | { readonly type: "response.created" }
  | { readonly type: "response.ended" }
  | {
      readonly type: "audio.delta";
      readonly itemId: string | null;
      readonly contentIndex: number;
      readonly samples: Float32Array;
    }
  | { readonly type: "speech.started" }
  | { readonly type: "speech.stopped" }
  | { readonly type: "transcript.user"; readonly itemId: string | null; readonly text: string }
  | {
      readonly type: "transcript.assistant.delta";
      readonly itemId: string | null;
      readonly delta: string;
    }
  | {
      readonly type: "tool.call";
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "unsupported"; readonly wireType: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : null);
const text = (value: unknown) => {
  const s = str(value)?.trim();
  return s ? s : null;
};

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function parseServerEvent(raw: string): VoiceServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const itemId = str(value.item_id) ?? (isRecord(value.item) ? str(value.item.id) : null);
  switch (value.type) {
    case "session.created":
    case "session.updated":
      return { type: "session.ready" };
    case "conversation.created":
      return {
        type: "conversation.created",
        conversationId: isRecord(value.conversation) ? str(value.conversation.id) : null,
      };
    case "response.created":
      return { type: "response.created" };
    case "response.done":
    case "response.cancelled":
      return { type: "response.ended" };
    case "response.audio.delta":
    case "response.output_audio.delta": {
      const delta = str(value.delta);
      if (delta === null) return null;
      return {
        type: "audio.delta",
        itemId,
        contentIndex:
          typeof value.content_index === "number" && Number.isInteger(value.content_index)
            ? value.content_index
            : 0,
        samples: pcm16ToFloat(fromBase64(delta)),
      };
    }
    case "input_audio_buffer.speech_started":
      return { type: "speech.started" };
    case "input_audio_buffer.speech_stopped":
      return { type: "speech.stopped" };
    case "conversation.item.input_audio_transcription.completed": {
      const t = text(value.transcript) ?? text(value.text);
      return t === null
        ? { type: "unsupported", wireType: value.type }
        : { type: "transcript.user", itemId, text: t };
    }
    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta": {
      const delta = str(value.delta);
      return delta === null ? null : { type: "transcript.assistant.delta", itemId, delta };
    }
    case "response.function_call_arguments.done": {
      const callId = str(value.call_id);
      const name = str(value.name);
      return callId === null || name === null
        ? null
        : { type: "tool.call", callId, name, argumentsJson: str(value.arguments) ?? "{}" };
    }
    case "error": {
      const error = isRecord(value.error) ? value.error : value;
      return { type: "error", message: text(error.message) ?? "Realtime error" };
    }
    default:
      return { type: "unsupported", wireType: value.type };
  }
}
