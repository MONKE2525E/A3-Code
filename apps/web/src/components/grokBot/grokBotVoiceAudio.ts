import {
  VOICE_SAMPLE_RATE,
  type VoiceAudioCut,
} from "@t3tools/client-runtime/grok-bot-voice/protocol";

/** One realtime input frame: 20 ms at 24 kHz, the cadence the desktop client sends. */
export const VOICE_CAPTURE_FRAME_SAMPLES = 480;
const CAPTURE_PROCESSOR_NAME = "t3-voice-capture";

// Forwards each render quantum to the main thread; framing happens there so it stays testable.
const CAPTURE_WORKLET_SOURCE = `
class T3VoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR_NAME)}, T3VoiceCapture);
`;

export type VoiceAudioFailure =
  | "insecure_context"
  | "unsupported"
  | "permission_denied"
  | "no_microphone"
  | "failed";

export class VoiceAudioError extends Error {
  readonly reason: VoiceAudioFailure;

  constructor(reason: VoiceAudioFailure) {
    super(`Voice audio failed: ${reason}`);
    this.name = "VoiceAudioError";
    this.reason = reason;
  }
}

export interface VoiceAudio {
  enqueue(
    samples: Float32Array,
    part?: { itemId: string | null; contentIndex: number | null },
  ): void;
  /** Null when empty; otherwise settles after every queued/playing source ends or is cleared. */
  whenDrained(): Promise<void> | null;
  /** Stops everything queued or playing, for barge-in and hang-up. */
  clear(): readonly VoiceAudioCut[] | void;
  /** Releases the microphone tracks, the capture graph, and the AudioContext. Safe to call twice. */
  close(): void;
}

/** The browser surface voice audio needs. Tests substitute fakes; production uses `browserVoiceMedia`. */
export interface VoiceMedia {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(): AudioContext;
  loadCapture(context: AudioContext): Promise<AudioWorkletNode>;
}

/** Splits arbitrary-sized sample blocks into fixed frames. Each emitted frame is a fresh buffer. */
export function createFrameChunker(size: number, emit: (frame: Float32Array) => void) {
  let pending = new Float32Array(size);
  let filled = 0;
  return {
    push(samples: Float32Array) {
      let offset = 0;
      while (offset < samples.length) {
        const take = Math.min(size - filled, samples.length - offset);
        pending.set(samples.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === size) {
          const frame = pending;
          pending = new Float32Array(size);
          filled = 0;
          emit(frame);
        }
      }
    },
  };
}

/** Plays model audio back-to-back on the context clock, so chunks never overlap or gap. */
export function createVoicePlayer(context: AudioContext) {
  interface PlaybackPart {
    itemId: string;
    contentIndex: number;
    playedSeconds: number;
    sources: number;
  }
  const parts = new Map<string, PlaybackPart>();
  let latestPart: string | null = null;
  const playing = new Map<
    AudioBufferSourceNode,
    { startAt: number; duration: number; part: PlaybackPart | null }
  >();
  const drainWaiters = new Set<() => void>();
  const notifyDrained = () => {
    if (playing.size > 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };
  let nextStart = 0;
  return {
    enqueue(
      samples: Float32Array,
      metadata?: { itemId: string | null; contentIndex: number | null },
    ) {
      if (samples.length === 0) return;
      const buffer = context.createBuffer(1, samples.length, VOICE_SAMPLE_RATE);
      // copyToChannel only accepts a non-shared buffer, so decoded frames are copied in.
      buffer.copyToChannel(new Float32Array(samples), 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime, nextStart);
      const key =
        metadata?.itemId != null &&
        metadata.contentIndex != null &&
        Number.isInteger(metadata.contentIndex) &&
        metadata.contentIndex >= 0
          ? JSON.stringify([metadata.itemId, metadata.contentIndex])
          : null;
      latestPart = key;
      let part = key === null ? null : (parts.get(key) ?? null);
      if (
        key !== null &&
        part === null &&
        metadata?.itemId != null &&
        metadata.contentIndex != null
      ) {
        part = {
          itemId: metadata.itemId,
          contentIndex: metadata.contentIndex,
          playedSeconds: 0,
          sources: 0,
        };
        parts.set(key, part);
      }
      for (const [oldKey, oldPart] of parts) {
        if (oldKey !== key && oldPart.sources === 0) parts.delete(oldKey);
      }
      source.start(startAt);
      nextStart = startAt + buffer.duration;
      playing.set(source, { startAt, duration: buffer.duration, part });
      if (part !== null) part.sources += 1;
      source.addEventListener(
        "ended",
        () => {
          if (!playing.delete(source)) return;
          if (part !== null) {
            part.playedSeconds += buffer.duration;
            part.sources -= 1;
            if (key !== latestPart && part.sources === 0) parts.delete(key!);
          }
          notifyDrained();
        },
        { once: true },
      );
    },
    whenDrained() {
      return playing.size === 0 ? null : new Promise<void>((resolve) => drainWaiters.add(resolve));
    },
    clear() {
      const queued = [...playing];
      playing.clear();
      for (const [source, span] of queued) {
        if (span.part !== null)
          span.part.playedSeconds += Math.max(
            0,
            Math.min(span.duration, context.currentTime - span.startAt),
          );
        try {
          source.stop();
        } catch {
          // Already stopped by the clock; nothing to release.
        }
      }
      const cuts = [...parts.values()].map((part) => ({
        itemId: part.itemId,
        contentIndex: part.contentIndex,
        audioEndMs: part.playedSeconds * 1000,
      }));
      parts.clear();
      latestPart = null;
      nextStart = 0;
      notifyDrained();
      return cuts;
    },
  };
}

/** Opens the microphone and 24 kHz playback for one call. Nothing is requested until this runs. */
export async function openVoiceAudio(options: {
  readonly onFrame: (samples: Float32Array) => void;
  readonly media?: VoiceMedia;
}): Promise<VoiceAudio> {
  const media = options.media ?? browserVoiceMedia();
  const context = media.createContext();
  // Created inside the click that started the call, so the browser allows it to run.
  void context.resume().catch(() => undefined);

  let stream: MediaStream | null = null;
  let capture: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let mute: GainNode | null = null;
  let closed = false;
  const player = createVoicePlayer(context);
  const chunker = createFrameChunker(VOICE_CAPTURE_FRAME_SAMPLES, options.onFrame);

  const close = () => {
    if (closed) return;
    closed = true;
    player.clear();
    if (capture !== null) {
      capture.port.close();
      capture.disconnect();
    }
    source?.disconnect();
    mute?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => undefined);
  };

  try {
    if (context.sampleRate !== VOICE_SAMPLE_RATE) throw new VoiceAudioError("unsupported");
    try {
      stream = await media.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      throw new VoiceAudioError(microphoneFailure(error));
    }
    capture = await media.loadCapture(context);
    source = context.createMediaStreamSource(stream);
    // The worklet only runs while it reaches the destination; a silent gain keeps the mic unheard.
    mute = context.createGain();
    mute.gain.value = 0;
    source.connect(capture);
    capture.connect(mute);
    mute.connect(context.destination);
    capture.port.addEventListener("message", (event: MessageEvent<Float32Array>) =>
      chunker.push(event.data),
    );
    capture.port.start();
  } catch (error) {
    close();
    throw error instanceof VoiceAudioError ? error : new VoiceAudioError("failed");
  }

  return {
    whenDrained: () => player.whenDrained(),
    enqueue: (samples, part) => {
      if (!closed) player.enqueue(samples, part);
    },
    clear: () => player.clear(),
    close,
  };
}

function microphoneFailure(error: unknown): VoiceAudioFailure {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_microphone";
  return "failed";
}

/** The real browser surface, or a typed reason it is missing. Read lazily so non-browser imports stay safe. */
function browserVoiceMedia(): VoiceMedia {
  if (typeof window === "undefined" || !window.isSecureContext) {
    throw new VoiceAudioError("insecure_context");
  }
  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (
    mediaDevices === undefined ||
    typeof AudioContext === "undefined" ||
    typeof AudioWorkletNode === "undefined"
  ) {
    throw new VoiceAudioError("unsupported");
  }
  return {
    getUserMedia: (constraints) => mediaDevices.getUserMedia(constraints),
    createContext: () => new AudioContext({ sampleRate: VOICE_SAMPLE_RATE }),
    loadCapture: async (context) => {
      const url = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }),
      );
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      return new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME);
    },
  };
}
