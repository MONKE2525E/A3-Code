import { MUSE_DICTATION_MAX_BYTES, MUSE_DICTATION_SAMPLE_RATE } from "@t3tools/contracts";

/** Smallest payload the server accepts is 6 bytes; shorter takes are treated as empty. */
const MIN_SAMPLES = 3;

/**
 * Streaming linear resampler. State carries across `push` calls, so chunk boundaries never click
 * or drift: the same input split anywhere produces the same output.
 */
export function createLinearResampler(inputRate: number, outputRate: number) {
  const step = inputRate / outputRate;
  // The last input sample of the previous chunk, which is virtual index 0 of the next one.
  let prev: number | null = null;
  // Where the next output sample falls, in virtual-index units.
  let pos = 0;
  return {
    push(input: Float32Array): Float32Array {
      if (input.length === 0) return new Float32Array(0);
      const offset = prev === null ? 0 : 1;
      const length = input.length + offset;
      const at = (index: number) =>
        offset === 1 ? (index === 0 ? (prev as number) : input[index - 1]!) : input[index]!;
      const out: number[] = [];
      while (pos <= length - 1) {
        const base = Math.floor(pos);
        const frac = pos - base;
        const a = at(base);
        out.push(frac === 0 ? a : a + (at(base + 1) - a) * frac);
        pos += step;
      }
      prev = at(length - 1);
      pos -= length - 1;
      return Float32Array.from(out);
    },
  };
}

/** Clips to [-1, 1] and encodes as signed 16-bit little-endian regardless of host endianness. */
export function floatToPcm16Le(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, Number.isNaN(samples[i]!) ? 0 : samples[i]!));
    view.setInt16(i * 2, Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff), true);
  }
  return bytes;
}

/**
 * Collects 24 kHz PCM16 chunks up to the server's recording limit. `push` reports when the limit
 * is reached so the caller can stop the capture; excess samples are dropped, never sent.
 */
export function createPcmRecorder(maxBytes: number = MUSE_DICTATION_MAX_BYTES) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  return {
    push(chunk: Uint8Array): { readonly full: boolean } {
      const room = maxBytes - bytes;
      const take = Math.min(room, chunk.length) & ~1;
      if (take > 0) {
        chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
        bytes += take;
      }
      return { full: bytes >= maxBytes - 1 };
    },
    seconds: () => bytes / 2 / MUSE_DICTATION_SAMPLE_RATE,
    /** The recording, or null when it is too short to hold any speech. */
    finish(): Uint8Array | null {
      if (bytes / 2 < MIN_SAMPLES) return null;
      const out = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
  };
}

/** Appends a dictated transcript below text the user already typed. */
export function appendDraft(existing: string, addition: string): string {
  return existing.trim().length > 0 ? `${existing}\n\n${addition}` : addition;
}

export type DictationBlock = "insecure" | "unsupported" | null;

/** Microphone capture needs a secure context (HTTPS or localhost) and the Web Audio APIs. */
export function dictationCaptureSupport(host: {
  readonly isSecureContext: boolean;
  readonly hasMediaDevices: boolean;
  readonly hasAudioContext: boolean;
}): DictationBlock {
  if (!host.isSecureContext) return "insecure";
  return host.hasMediaDevices && host.hasAudioContext ? null : "unsupported";
}
