import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_CAPTURE_FRAME_SAMPLES,
  VoiceAudioError,
  createFrameChunker,
  createVoicePlayer,
  openVoiceAudio,
  type VoiceMedia,
} from "./grokBotVoiceAudio";

function ramp(length: number, offset = 0) {
  return Float32Array.from({ length }, (_, i) => offset + i);
}

function fakeTrack() {
  return {
    stops: 0,
    stop() {
      this.stops += 1;
    },
  };
}

function fakeStream(tracks = [fakeTrack()]) {
  return { getTracks: () => tracks };
}

interface FakeSource {
  buffer: { duration: number } | null;
  startedAt: number | null;
  stopped: boolean;
  connect(): void;
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  start(at: number): void;
  stop(): void;
}

function fakeContext(sampleRate = 24_000) {
  const sources: FakeSource[] = [];
  const context = {
    sampleRate,
    currentTime: 1,
    destination: {},
    closes: 0,
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, copyToChannel: () => undefined };
    },
    createBufferSource(): FakeSource {
      const source: FakeSource = {
        buffer: null,
        startedAt: null,
        stopped: false,
        connect() {},
        addEventListener() {},
        start(at) {
          this.startedAt = at;
        },
        stop() {
          if (this.stopped) throw new Error("already stopped");
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    resume: () => Promise.resolve(),
    close() {
      context.closes += 1;
      return Promise.resolve();
    },
    audioWorklet: { addModule: async () => undefined },
    sources,
  };
  return context;
}

type FakeContext = ReturnType<typeof fakeContext>;

function fakeCapture() {
  const node = {
    port: {
      listeners: [] as Array<(event: { data: Float32Array }) => void>,
      closed: false,
      addEventListener(_type: string, listener: (event: { data: Float32Array }) => void) {
        node.port.listeners.push(listener);
      },
      start() {},
      close() {
        node.port.closed = true;
      },
    },
    disconnects: 0,
    connect: () => node,
    disconnect() {
      node.disconnects += 1;
    },
  };
  return node;
}

function mediaWith(
  context: FakeContext,
  options: {
    stream?: ReturnType<typeof fakeStream>;
    getUserMedia?: () => Promise<unknown>;
    loadCapture?: () => Promise<unknown>;
  } = {},
) {
  const stream = options.stream ?? fakeStream();
  const capture = fakeCapture();
  const media: VoiceMedia = {
    getUserMedia: (async () => options.getUserMedia?.() ?? stream) as VoiceMedia["getUserMedia"],
    createContext: () => context as unknown as AudioContext,
    loadCapture: (async () =>
      options.loadCapture ? await options.loadCapture() : capture) as VoiceMedia["loadCapture"],
  };
  return { media, stream, capture };
}

describe("voice capture framing", () => {
  it("emits fixed 20 ms frames across render-quantum boundaries, in order", () => {
    const frames: Float32Array[] = [];
    const chunker = createFrameChunker(VOICE_CAPTURE_FRAME_SAMPLES, (frame) => frames.push(frame));
    for (let block = 0; block < 4; block += 1) chunker.push(ramp(128, block * 128));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(480);
    expect(frames[0]?.[0]).toBe(0);
    expect(frames[0]?.[479]).toBe(479);
  });

  it("keeps each emitted frame as its own buffer", () => {
    const frames: Float32Array[] = [];
    const chunker = createFrameChunker(4, (frame) => frames.push(frame));
    chunker.push(Float32Array.from([1, 2, 3, 4]));
    chunker.push(Float32Array.from([5, 6, 7, 8]));
    expect(Array.from(frames[0]!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(frames[1]!)).toEqual([5, 6, 7, 8]);
  });
});

describe("voice playback", () => {
  it("schedules each model chunk right after the previous one", () => {
    const context = fakeContext();
    const player = createVoicePlayer(context as unknown as AudioContext);
    player.enqueue(new Float32Array(12_000));
    player.enqueue(new Float32Array(6_000));
    const [first, second] = context.sources;
    expect(first?.startedAt).toBe(1);
    expect(second?.startedAt).toBeCloseTo(1.5);
  });

  it("stops everything still queued when the caller barges in", () => {
    const context = fakeContext();
    const player = createVoicePlayer(context as unknown as AudioContext);
    player.enqueue(new Float32Array(12_000));
    player.enqueue(new Float32Array(12_000));
    player.clear();
    expect(context.sources.every((source) => source.stopped)).toBe(true);
  });
});

describe("voice audio lifecycle", () => {
  it("requests a mono mic with echo cancellation and noise suppression", async () => {
    const context = fakeContext();
    const requested: unknown[] = [];
    const media: VoiceMedia = {
      getUserMedia: async (constraints) => {
        requested.push(constraints);
        return fakeStream() as unknown as MediaStream;
      },
      createContext: () => context as unknown as AudioContext,
      loadCapture: async () => fakeCapture() as unknown as AudioWorkletNode,
    };
    await openVoiceAudio({ onFrame: () => undefined, media });
    expect(requested).toEqual([
      { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } },
    ]);
  });

  it("delivers 20 ms frames from the capture node to the caller", async () => {
    const { media, capture } = mediaWith(fakeContext());
    const lengths: number[] = [];
    await openVoiceAudio({ onFrame: (frame) => lengths.push(frame.length), media });
    for (const listener of capture.port.listeners)
      listener({ data: new Float32Array(VOICE_CAPTURE_FRAME_SAMPLES * 2) });
    expect(lengths).toEqual([VOICE_CAPTURE_FRAME_SAMPLES, VOICE_CAPTURE_FRAME_SAMPLES]);
  });

  it("releases the microphone track, capture graph, and context on close, once", async () => {
    const context = fakeContext();
    const track = fakeTrack();
    const { media, capture } = mediaWith(context, { stream: fakeStream([track]) });
    const audio = await openVoiceAudio({ onFrame: () => undefined, media });
    audio.close();
    audio.close();
    expect(track.stops).toBe(1);
    expect(capture.port.closed).toBe(true);
    expect(capture.disconnects).toBe(1);
    expect(context.closes).toBe(1);
  });

  it("drops playback that arrives after close", async () => {
    const context = fakeContext();
    const { media } = mediaWith(context);
    const audio = await openVoiceAudio({ onFrame: () => undefined, media });
    audio.close();
    audio.enqueue(new Float32Array(100));
    expect(context.sources).toHaveLength(0);
  });

  it("maps a denied prompt to permission_denied and closes the context it opened", async () => {
    const context = fakeContext();
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const { media } = mediaWith(context, { getUserMedia: () => Promise.reject(denied) });
    const failure = await openVoiceAudio({ onFrame: () => undefined, media }).catch((e) => e);
    expect(failure).toBeInstanceOf(VoiceAudioError);
    expect(failure.reason).toBe("permission_denied");
    expect(context.closes).toBe(1);
  });

  it("releases a granted microphone when the capture graph fails to load", async () => {
    const context = fakeContext();
    const track = fakeTrack();
    const { media } = mediaWith(context, {
      stream: fakeStream([track]),
      loadCapture: async () => {
        throw new Error("worklet blocked");
      },
    });
    const failure = await openVoiceAudio({ onFrame: () => undefined, media }).catch((e) => e);
    expect(failure.reason).toBe("failed");
    expect(track.stops).toBe(1);
    expect(context.closes).toBe(1);
  });

  it("refuses a context that cannot run at 24 kHz without asking for the microphone", async () => {
    const context = fakeContext(48_000);
    let asked = false;
    const { media } = mediaWith(context, {
      getUserMedia: async () => {
        asked = true;
        return fakeStream();
      },
    });
    const failure = await openVoiceAudio({ onFrame: () => undefined, media }).catch((e) => e);
    expect(failure.reason).toBe("unsupported");
    expect(asked).toBe(false);
    expect(context.closes).toBe(1);
  });
});
