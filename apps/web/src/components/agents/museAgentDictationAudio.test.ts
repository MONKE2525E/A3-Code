import { describe, expect, it } from "vite-plus/test";

import {
  appendDraft,
  createLinearResampler,
  createPcmRecorder,
  dictationCaptureSupport,
  floatToPcm16Le,
} from "./museAgentDictationAudio";

const ramp = (length: number) => Float32Array.from({ length }, (_, i) => i / length);

describe("createLinearResampler", () => {
  it("downsamples 48 kHz to 24 kHz by taking every second sample", () => {
    const out = createLinearResampler(48_000, 24_000).push(Float32Array.of(0, 1, 2, 3, 4, 5));
    expect([...out]).toEqual([0, 2, 4]);
  });

  it("interpolates when upsampling", () => {
    const out = createLinearResampler(12_000, 24_000).push(Float32Array.of(0, 1, 2));
    expect([...out]).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it("produces the same output however the input is chunked", () => {
    const input = ramp(1000);
    const whole = createLinearResampler(44_100, 24_000).push(input);
    const split = createLinearResampler(44_100, 24_000);
    const parts = [split.push(input.subarray(0, 1)), split.push(input.subarray(1, 333))];
    parts.push(split.push(input.subarray(333)));
    const joined = parts.flatMap((part) => [...part]);
    expect(joined).toHaveLength(whole.length);
    joined.forEach((value, i) => expect(value).toBeCloseTo(whole[i]!, 6));
  });

  it("handles empty chunks without disturbing later output", () => {
    const resampler = createLinearResampler(48_000, 24_000);
    expect(resampler.push(new Float32Array(0))).toHaveLength(0);
    expect([...resampler.push(Float32Array.of(0, 1, 2, 3))]).toEqual([0, 2]);
  });
});

describe("floatToPcm16Le", () => {
  it("encodes little-endian and clips out-of-range samples", () => {
    const bytes = floatToPcm16Le(Float32Array.of(0, 1, -1, 2, -2, Number.NaN));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32768);
    expect(view.getInt16(6, true)).toBe(32767);
    expect(view.getInt16(8, true)).toBe(-32768);
    expect(view.getInt16(10, true)).toBe(0);
    expect([...bytes.subarray(2, 4)]).toEqual([0xff, 0x7f]);
  });
});

describe("createPcmRecorder", () => {
  it("stops accepting audio at the byte limit and reports full", () => {
    const recorder = createPcmRecorder(10);
    expect(recorder.push(new Uint8Array(6)).full).toBe(false);
    expect(recorder.push(new Uint8Array(6)).full).toBe(true);
    expect(recorder.finish()?.byteLength).toBe(10);
    expect(recorder.push(new Uint8Array(4)).full).toBe(true);
    expect(recorder.finish()?.byteLength).toBe(10);
  });

  it("never keeps half a sample", () => {
    const recorder = createPcmRecorder(9);
    recorder.push(new Uint8Array(9));
    expect(recorder.finish()?.byteLength).toBe(8);
  });

  it("treats a recording shorter than the server minimum as empty", () => {
    const recorder = createPcmRecorder();
    recorder.push(new Uint8Array(4));
    expect(recorder.finish()).toBeNull();
  });

  it("joins chunks in order", () => {
    const recorder = createPcmRecorder();
    recorder.push(Uint8Array.of(1, 2, 3, 4));
    recorder.push(Uint8Array.of(5, 6));
    expect([...(recorder.finish() ?? [])]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("appendDraft", () => {
  it("keeps what the user already typed above the transcript", () => {
    expect(appendDraft("hello", "dictated")).toBe("hello\n\ndictated");
    expect(appendDraft("  \n", "dictated")).toBe("dictated");
  });
});

describe("dictationCaptureSupport", () => {
  it("requires a secure context and the audio APIs", () => {
    const ok = { isSecureContext: true, hasMediaDevices: true, hasAudioContext: true };
    expect(dictationCaptureSupport(ok)).toBeNull();
    expect(dictationCaptureSupport({ ...ok, isSecureContext: false })).toBe("insecure");
    expect(dictationCaptureSupport({ ...ok, hasMediaDevices: false })).toBe("unsupported");
  });
});
