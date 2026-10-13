import { MUSE_DICTATION_SAMPLE_RATE } from "@t3tools/contracts";

import { browserVoiceMedia, VoiceAudioError } from "~/components/grokBot/grokBotVoiceAudio";

import { createLinearResampler, floatToPcm16Le } from "./museAgentDictationAudio";

export interface DictationCapture {
  /** Releases the microphone tracks, the capture graph, and the AudioContext. Safe to call twice. */
  stop(): void;
}

function microphoneFailure(error: unknown): VoiceAudioError["reason"] {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_microphone";
  return "failed";
}

/**
 * Opens the microphone for one explicit recording and delivers 24 kHz PCM16 chunks. The context
 * keeps the device's own sample rate; resampling happens here. Returns null, with everything
 * already released, when `isStale` turned true while the browser was still granting access.
 */
export async function openDictationCapture(options: {
  readonly onPcm: (pcm: Uint8Array) => void;
  readonly isStale: () => boolean;
}): Promise<DictationCapture | null> {
  const media = browserVoiceMedia();
  const context = new AudioContext();
  // Created inside the click that started recording, so the browser allows it to run.
  void context.resume().catch(() => undefined);

  let stream: MediaStream | null = null;
  let capture: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let mute: GainNode | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
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
    try {
      stream = await media.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      throw new VoiceAudioError(microphoneFailure(error));
    }
    if (options.isStale()) {
      close();
      return null;
    }
    capture = await media.loadCapture(context);
    if (options.isStale()) {
      close();
      return null;
    }
    const resampler = createLinearResampler(context.sampleRate, MUSE_DICTATION_SAMPLE_RATE);
    source = context.createMediaStreamSource(stream);
    // The worklet only runs while it reaches the destination; a silent gain keeps the mic unheard.
    mute = context.createGain();
    mute.gain.value = 0;
    source.connect(capture);
    capture.connect(mute);
    mute.connect(context.destination);
    capture.port.addEventListener("message", (event: MessageEvent<Float32Array>) => {
      if (!closed) options.onPcm(floatToPcm16Le(resampler.push(event.data)));
    });
    capture.port.start();
  } catch (error) {
    close();
    throw error instanceof VoiceAudioError ? error : new VoiceAudioError("failed");
  }
  return { stop: close };
}
