import type { VoiceSocket } from "@t3tools/client-runtime/grok-bot-voice/call-session";
import type { GrokBotVoiceStartResult as StartResultSchema } from "@t3tools/contracts";

type StartResult = typeof StartResultSchema.Type;
import { describe, expect, it } from "vite-plus/test";

import { VoiceAudioError, type VoiceAudio } from "./grokBotVoiceAudio";
import {
  createGrokBotVoiceCall,
  startFailureMessage,
  toolOutput,
  type GrokBotVoiceCallPorts,
  type GrokBotVoiceCallState,
} from "./grokBotVoiceCall";

const started = (callId = "call-1"): StartResult => ({
  callId,
  credential: {
    clientSecret: "sek",
    expiresAtUnixSeconds: 0,
    model: "grok-voice",
    websocketUrl: "wss://api.x.ai/v1/realtime",
  },
  session: {
    instructions: "be brief",
    tools: [],
    hasOverheard: false,
    greeting: { direction: "", withLandedWork: "" },
  },
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeAudio() {
  const enqueued: Float32Array[] = [];
  const counts = { clears: 0, closes: 0 };
  const audio: VoiceAudio & { readonly enqueued: Float32Array[] } & typeof counts = {
    enqueued,
    get clears() {
      return counts.clears;
    },
    get closes() {
      return counts.closes;
    },
    enqueue: (samples) => void enqueued.push(samples),
    clear: () => void (counts.clears += 1),
    close: () => void (counts.closes += 1),
  };
  return audio;
}

function fakeSocket() {
  const sent: string[] = [];
  let open = true;
  const listeners = {
    message: (_data: string) => {},
    close: (_event: { code: number; clean: boolean }) => {},
  };
  const socket: VoiceSocket = {
    send: (frame) => void sent.push(frame),
    close: (code) => {
      open = false;
      listeners.close({ code, clean: code === 1000 });
    },
    get isOpen() {
      return open;
    },
    onOpen: () => {},
    onMessage: (listener) => (listeners.message = listener),
    onClose: (listener) => (listeners.close = listener),
  };
  return { socket, sent, listeners };
}

function harness(overrides: Partial<GrokBotVoiceCallPorts> = {}) {
  const states: GrokBotVoiceCallState[] = [];
  const sockets: Array<{ url: string; protocols: string[]; fake: ReturnType<typeof fakeSocket> }> =
    [];
  const audio = fakeAudio();
  let onFrame: (samples: Float32Array) => void = () => {};
  const endCalls: string[] = [];
  const connectedCalls: string[] = [];
  const endInputs: Parameters<GrokBotVoiceCallPorts["endCall"]>[0][] = [];
  const toolCalls: unknown[] = [];
  const ports: GrokBotVoiceCallPorts = {
    startCall: async () => started(),
    refreshCredential: async () => started().credential,
    runTool: async (input) => {
      toolCalls.push(input);
      return { kind: "served", output: { ok: true } };
    },
    connectedCall: async (callId) => void connectedCalls.push(callId),
    endCall: async (input) => void (endCalls.push(input.callId), endInputs.push(input)),
    openAudio: async (frame) => {
      onFrame = frame;
      return audio;
    },
    openSocket: (url, protocols) => {
      const fake = fakeSocket();
      sockets.push({ url, protocols, fake });
      return fake.socket;
    },
    ...overrides,
  };
  const call = createGrokBotVoiceCall({
    botId: "bot-1",
    ports,
    onState: (state) => void states.push(state),
  });
  return {
    call,
    states,
    sockets,
    audio,
    endCalls,
    connectedCalls,
    endInputs,
    toolCalls,
    sendFrame: (samples: Float32Array) => onFrame(samples),
    last: () => states.at(-1),
  };
}

const ready = JSON.stringify({ type: "session.created" });
const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

describe("grok bot voice call", () => {
  it("asks for the microphone before minting, then dials with the secret subprotocol", async () => {
    const order: string[] = [];
    const h = harness({
      openAudio: async () => {
        order.push("audio");
        return h.audio;
      },
      startCall: async () => {
        order.push("start");
        return started();
      },
    });
    await h.call.start();
    expect(order).toEqual(["audio", "start"]);
    expect(h.sockets[0]?.protocols).toEqual(["xai-client-secret.sek"]);
    expect(h.last()?.phase).toBe("connecting");
  });

  it("closes a late microphone and never mints a credential when hung up during the prompt", async () => {
    const mic = deferred<VoiceAudio>();
    let startCalls = 0;
    const h = harness({
      openAudio: () => mic.promise,
      startCall: async () => {
        startCalls += 1;
        return started();
      },
    });
    const pending = h.call.start();
    h.call.hangUp();
    mic.resolve(h.audio);
    await pending;
    await flush();
    expect(h.audio.closes).toBe(1);
    expect(startCalls).toBe(0);
    expect(h.last()).toEqual({ phase: "idle", muted: false, notice: null });
  });

  it("ends a call minted after hang-up, so the server releases it", async () => {
    const minted = deferred<StartResult>();
    const h = harness({ startCall: () => minted.promise });
    const pending = h.call.start();
    await flush();
    h.call.hangUp();
    minted.resolve(started("call-late"));
    await pending;
    await flush();
    expect(h.endCalls).toEqual(["call-late"]);
    expect(h.audio.closes).toBe(1);
    expect(h.sockets).toHaveLength(0);
  });

  it("releases the microphone and ends the server call when the bot hangs up", async () => {
    const h = harness();
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    fake.listeners.close({ code: 1000, clean: true });
    await flush();
    expect(h.endCalls).toEqual(["call-1"]);
    expect(h.audio.closes).toBe(1);
    expect(h.last()?.notice).toBe("The call ended.");
    expect(h.last()?.phase).toBe("idle");
  });

  it("reports a denied microphone without minting a credential", async () => {
    let startCalls = 0;
    const h = harness({
      openAudio: async () => {
        throw new VoiceAudioError("permission_denied");
      },
      startCall: async () => {
        startCalls += 1;
        return started();
      },
    });
    await h.call.start();
    expect(startCalls).toBe(0);
    expect(h.last()?.phase).toBe("idle");
    expect(h.last()?.notice).toContain("Microphone access was denied");
  });

  it("releases the microphone and shows the contract message when the account cannot call", async () => {
    const h = harness({
      startCall: async () => {
        throw { _tag: "GrokBotVoiceError", reason: "account_unavailable" };
      },
    });
    await h.call.start();
    expect(h.audio.closes).toBe(1);
    expect(h.last()?.notice).toBe("Connect a Grok Bot account to start a voice call.");
  });

  it("brokers a served tool call with its input and returns a bounded error for unknown tools", async () => {
    const h = harness({
      runTool: async (input) => {
        h.toolCalls.push(input);
        return input.name === "send_task"
          ? { kind: "served", output: { ok: true } }
          : { kind: "unknown_tool", output: null };
      },
    });
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "send_task",
        arguments: '{"title":"x"}',
      }),
    );
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "c2",
        name: "mystery",
        arguments: "{}",
      }),
    );
    await flush();
    const outputs = fake.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "conversation.item.create")
      .map((frame) => frame.item.output);
    expect(outputs).toEqual(['{"ok":true}', '{"error":"unknown_tool"}']);
    expect(h.toolCalls[0]).toMatchObject({
      callId: "call-1",
      toolCallId: "c1",
      name: "send_task",
      input: { title: "x" },
    });
  });

  it("stops queued speech when the caller talks over the bot", async () => {
    const h = harness();
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    fake.listeners.message(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: "i",
        delta: btoa(String.fromCharCode(0, 0, 0, 0)),
      }),
    );
    expect(h.audio.enqueued).toHaveLength(1);
    fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    expect(h.audio.clears).toBe(1);
  });

  it("stops forwarding microphone frames while muted and reports the mute state", async () => {
    const h = harness();
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    h.sendFrame(new Float32Array(480));
    h.call.setMuted(true);
    expect(h.last()?.muted).toBe(true);
    h.sendFrame(new Float32Array(480));
    const appended = fake.sent.filter((frame) => frame.includes("input_audio_buffer.append"));
    expect(appended).toHaveLength(1);
  });

  it("hands the server the transcript once when a connected call ends, however it ends", async () => {
    const h = harness();
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    fake.listeners.message(
      JSON.stringify({ type: "conversation.created", conversation: { id: "conv-9" } }),
    );
    fake.listeners.message(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "hello bot",
      }),
    );
    for (const delta of ["Hi ", "there"])
      fake.listeners.message(
        JSON.stringify({ type: "response.output_audio_transcript.delta", item_id: "a1", delta }),
      );
    h.call.hangUp();
    // A remote close and an unmount racing the hang-up must not end the call a second time.
    fake.listeners.close({ code: 1000, clean: true });
    h.call.dispose();
    await flush();
    expect(h.endInputs).toHaveLength(1);
    const end = h.endInputs[0]!;
    expect(end).toMatchObject({
      callId: "call-1",
      ending: "hung-up",
      realtimeConversationId: "conv-9",
    });
    expect(end.turns?.map(({ id, speaker, text }) => ({ id, speaker, text }))).toEqual([
      { id: "u1", speaker: "user", text: "hello bot" },
      { id: "a1", speaker: "assistant", text: "Hi there" },
    ]);
  });

  it("tells the server once when the realtime session goes live", async () => {
    const h = harness();
    await h.call.start();
    expect(h.connectedCalls).toEqual([]);
    h.sockets[0]!.fake.listeners.message(ready);
    h.sockets[0]!.fake.listeners.message(ready);
    await flush();
    expect(h.connectedCalls).toEqual(["call-1"]);
  });

  it("labels a remote close as disconnected and never records a call that did not connect", async () => {
    const remote = harness();
    await remote.call.start();
    remote.sockets[0]!.fake.listeners.message(ready);
    remote.sockets[0]!.fake.listeners.close({ code: 1000, clean: true });
    await flush();
    expect(remote.endInputs[0]).toMatchObject({ callId: "call-1", ending: "disconnected" });

    const early = harness();
    await early.call.start();
    early.call.hangUp();
    await flush();
    expect(early.endInputs).toEqual([{ callId: "call-1" }]);
  });

  it("ends the call on dispose and can start a fresh one afterwards", async () => {
    const h = harness();
    await h.call.start();
    h.sockets[0]!.fake.listeners.message(ready);
    h.call.dispose();
    expect(h.endCalls).toEqual(["call-1"]);
    expect(h.audio.closes).toBe(1);
    expect(h.last()).toEqual({ phase: "idle", muted: false, notice: null });
    await h.call.start();
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]?.protocols).toEqual(["xai-client-secret.sek"]);
  });
});

describe("voice call messages and tool output", () => {
  it("keeps the server's tool output and bounds everything else", () => {
    expect(toolOutput({ kind: "served", output: { a: 1 } })).toBe('{"a":1}');
    expect(toolOutput({ kind: "invalid_input", output: null })).toBe('{"error":"invalid_input"}');
  });

  it("maps unknown failures to a generic message instead of the raw error", () => {
    expect(startFailureMessage(new Error("wss://api.x.ai/secret"))).toBe(
      "The voice call could not be started. Try again.",
    );
  });
});
