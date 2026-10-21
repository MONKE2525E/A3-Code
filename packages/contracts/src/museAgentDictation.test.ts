import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  MuseAgentDictationLanguage,
  MuseAgentDictationPcm,
  MuseAgentDictationRequestError,
  MuseAgentDictationStatus,
  MuseAgentDictationTranscript,
} from "./museAgentDictation.ts";

const decodePcm = Schema.decodeUnknownSync(MuseAgentDictationPcm);
const decodeLanguage = Schema.decodeUnknownSync(MuseAgentDictationLanguage);
const decodeStatus = Schema.decodeUnknownSync(MuseAgentDictationStatus);
const decodeTranscript = Schema.decodeUnknownSync(MuseAgentDictationTranscript);
const decodeError = Schema.decodeUnknownSync(MuseAgentDictationRequestError);

describe("local Muse dictation wire contracts", () => {
  it("accepts bounded PCM16 and fixed local capture metadata", () => {
    const pcm = new Uint8Array([0, 0, 1, 0, 2, 0]);
    expect(decodePcm(pcm)).toEqual(pcm);
    expect(decodePcm(new Uint8Array(2_880_000)).length).toBe(2_880_000);
    expect(
      decodeStatus({
        available: true,
        engineDetected: true,
        modelDetected: true,
        local: true,
        sampleRateHz: 24000,
        maxAudioSeconds: 60,
        reason: "ready",
      }).local,
    ).toBe(true);
    expect(decodeLanguage("auto")).toBe("auto");
    expect(decodeLanguage("en")).toBe("en");
  });
  it("rejects odd, oversized or base64 audio and incompatible capture formats", () => {
    for (const pcm of [new Uint8Array(), new Uint8Array(7), new Uint8Array(2_880_002), "AAABAAIA"])
      expect(() => decodePcm(pcm)).toThrow();
    const status = {
      available: true,
      engineDetected: true,
      modelDetected: true,
      local: true,
      sampleRateHz: 24000,
      maxAudioSeconds: 60,
      reason: "ready",
    };
    expect(() => decodeStatus({ ...status, sampleRateHz: 16000 })).toThrow();
    expect(() => decodeStatus({ ...status, local: false })).toThrow();
    expect(() => decodeLanguage("invalid")).toThrow();
    expect(() => decodeTranscript({ text: "x".repeat(16001) })).toThrow();
  });
  it("decodes safe error codes without exposing helper paths or account data", () => {
    for (const code of [
      "invalid_audio",
      "busy",
      "timeout",
      "no_speech",
      "account_changed",
    ] as const) {
      const error = decodeError({ _tag: "MuseAgentDictationRequestError", code });
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(JSON.stringify(error)).not.toContain("cause");
    }
  });
});
