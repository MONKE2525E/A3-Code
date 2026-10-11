import { describe, expect, it } from "vite-plus/test";
import { createVoiceCallSession, type VoiceSocket } from "./callSession.ts";
import {
  audioAppendFrame,
  isDialableVoiceUrl,
  parseServerEvent,
  realtimeProtocols,
  realtimeUrl,
  sessionUpdateFrame,
} from "./protocol.ts";

const credential = {
  clientSecret: "sek",
  model: "grok-voice",
  websocketUrl: "wss://api.x.ai/v1/realtime",
};
const voice = { voiceId: "eve", voiceSpeed: 1, voiceLanguage: null };

function fakeSocket() {
  const sent: string[] = [];
  let open = true;
  const listeners = {
    message: (() => {}) as (data: string) => void,
    close: (() => {}) as (event: { code: number; clean: boolean }) => void,
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
    onMessage: (l) => (listeners.message = l),
    onClose: (l) => (listeners.close = l),
  };
  return { socket, sent, listeners };
}

function harness(overrides: { runTool?: () => Promise<string> } = {}) {
  const sockets: Array<{ url: string; protocols: string[]; fake: ReturnType<typeof fakeSocket> }> =
    [];
  const phases: string[] = [];
  const ended: string[] = [];
  const events: string[] = [];
  const session = createVoiceCallSession({
    credential,
    instructions: "be brief",
    tools: [{ type: "function", name: "send_task" }],
    voice,
    ports: {
      openSocket: (url, protocols) => {
        const fake = fakeSocket();
        sockets.push({ url, protocols, fake });
        return fake.socket;
      },
      refreshCredential: async () => ({ ...credential, clientSecret: "sek2" }),
      runTool: overrides.runTool ?? (async () => '{"ok":true}'),
    },
    onEvent: (event) => void events.push(event.type),
    onPhase: (phase) => void phases.push(phase),
    onEnded: (reason) => void ended.push(reason),
  });
  return { session, sockets, phases, ended, events };
}
const ready = JSON.stringify({ type: "session.created" });
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("protocol", () => {
  it("authenticates with the secret subprotocol and pins the realtime origin", () => {
    expect(realtimeProtocols(credential)).toEqual(["xai-client-secret.sek"]);
    expect(realtimeUrl(credential, "conv-1")).toBe(
      "wss://api.x.ai/v1/realtime?model=grok-voice&conversation_id=conv-1",
    );
    expect(isDialableVoiceUrl("wss://api.x.ai@evil.test/")).toBe(false);
    expect(() => realtimeUrl({ ...credential, websocketUrl: "wss://evil.test/" })).toThrow();
  });

  it("builds the session.update frame the official client sends", () => {
    const frame = JSON.parse(
      sessionUpdateFrame({ instructions: "hi", tools: [], voice, reconnecting: true }),
    );
    expect(frame.session).toMatchObject({
      voice: "eve",
      keep_context: false,
      turn_detection: { type: "server_vad" },
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "grok-transcribe" },
        },
        output: { format: { type: "audio/pcm", rate: 24000 }, speed: 1 },
      },
    });
    expect(frame.session.audio.input.transcription).not.toHaveProperty("language_hint");
  });

  it("encodes microphone samples as base64 PCM16 and decodes audio deltas", () => {
    const frame = JSON.parse(audioAppendFrame(new Float32Array([0, 1, -1])));
    expect(frame.type).toBe("input_audio_buffer.append");
    expect(frame.audio).toBe(btoa(String.fromCharCode(0, 0, 0xff, 0x7f, 0x00, 0x80)));
    const event = parseServerEvent(
      JSON.stringify({ type: "response.output_audio.delta", item_id: "i", delta: frame.audio }),
    );
    expect(event).toMatchObject({ type: "audio.delta", itemId: "i", contentIndex: 0 });
  });

  it("parses tool calls and ignores unreadable frames", () => {
    expect(
      parseServerEvent(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "c",
          name: "send_task",
        }),
      ),
    ).toEqual({ type: "tool.call", callId: "c", name: "send_task", argumentsJson: "{}" });
    expect(parseServerEvent("not json")).toBeNull();
  });
});

describe("call session", () => {
  it("dials with the secret subprotocol, configures the session once ready, and goes live", () => {
    const { session, sockets, phases } = harness();
    expect(sockets[0]?.protocols).toEqual(["xai-client-secret.sek"]);
    sockets[0]!.fake.listeners.message(ready);
    expect(JSON.parse(sockets[0]!.fake.sent[0]!).type).toBe("session.update");
    expect(phases).toEqual(["live"]);
    expect(session.phase).toBe("live");
  });

  it("drops microphone frames until live and while muted", () => {
    const { session, sockets } = harness();
    const { fake } = sockets[0]!;
    session.sendAudio("early");
    fake.listeners.message(ready);
    session.sendAudio("a");
    session.setMuted(true);
    session.sendAudio("b");
    session.setMuted(false);
    session.sendAudio("c");
    expect(fake.sent.slice(1)).toEqual(["a", "c"]);
  });

  it("brokers a tool call and asks the model to continue", async () => {
    const { sockets } = harness();
    const { fake } = sockets[0]!;
    fake.listeners.message(ready);
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "send_task",
        arguments: "{}",
      }),
    );
    await flush();
    expect(fake.sent.slice(1).map((f) => JSON.parse(f))).toEqual([
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "c1", output: '{"ok":true}' },
      },
      { type: "response.create" },
    ]);
  });

  it("reconnects onto the same conversation with a fresh secret and no connect chime state loss", async () => {
    const { session, sockets, phases, ended } = harness();
    sockets[0]!.fake.listeners.message(ready);
    sockets[0]!.fake.listeners.message(
      JSON.stringify({ type: "conversation.created", conversation: { id: "conv-9" } }),
    );
    session.dropForReconnect();
    await flush();
    expect(phases).toEqual(["live", "reconnecting"]);
    expect(sockets[1]?.url).toContain("conversation_id=conv-9");
    expect(sockets[1]?.protocols).toEqual(["xai-client-secret.sek2"]);
    sockets[1]!.fake.listeners.message(ready);
    expect(JSON.parse(sockets[1]!.fake.sent[0]!).session.keep_context).toBe(false);
    expect(session.phase).toBe("live");
    expect(ended).toEqual([]);
  });

  it("does not deliver a tool result into a replaced socket", async () => {
    let finishTool: (value: string) => void = () => {};
    const { session, sockets } = harness({ runTool: () => new Promise((r) => (finishTool = r)) });
    sockets[0]!.fake.listeners.message(ready);
    sockets[0]!.fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "send_task",
      }),
    );
    session.dropForReconnect();
    await flush();
    sockets[1]!.fake.listeners.message(ready);
    finishTool("{}");
    await flush();
    expect(sockets[0]!.fake.sent).toHaveLength(1);
    expect(sockets[1]!.fake.sent).toHaveLength(1);
  });

  it("ends on hang-up, closes the socket, and ignores later frames", () => {
    const { session, sockets, ended, events } = harness();
    const { fake } = sockets[0]!;
    fake.listeners.message(ready);
    session.hangUp();
    expect(ended).toEqual(["hang_up"]);
    expect(fake.socket.isOpen).toBe(false);
    const before = events.length;
    fake.listeners.message(ready);
    session.sendAudio("x");
    expect(events).toHaveLength(before);
    expect(session.phase).toBe("closed");
  });

  it("gives up after the reconnect budget is spent", async () => {
    const { session, sockets, ended } = harness();
    for (let i = 0; i < 4; i += 1) {
      session.dropForReconnect();
      await flush();
    }
    expect(sockets).toHaveLength(4);
    expect(ended).toEqual(["error"]);
  });
});

describe("call session teardown", () => {
  function connectingHarness(refreshCredential: () => Promise<typeof credential>) {
    const closed: Array<{ code: number; reason: string }> = [];
    const listeners: Array<{ close: (event: { code: number; clean: boolean }) => void }> = [];
    const urls: string[] = [];
    const ended: string[] = [];
    const session = createVoiceCallSession({
      credential,
      instructions: "",
      tools: [],
      voice,
      ports: {
        openSocket: (url) => {
          urls.push(url);
          const entry = { close: (() => {}) as (e: { code: number; clean: boolean }) => void };
          listeners.push(entry);
          // Never opens: the WebSocket is still in its handshake.
          return {
            send: () => {},
            close: (code, reason) => void closed.push({ code, reason }),
            isOpen: false,
            onOpen: () => {},
            onMessage: () => {},
            onClose: (l) => (entry.close = l),
          };
        },
        refreshCredential,
        runTool: async () => "{}",
      },
      onEvent: () => {},
      onPhase: () => {},
      onEnded: (reason) => void ended.push(reason),
    });
    return { session, closed, listeners, urls, ended };
  }

  it("closes a socket that is still handshaking when the call is hung up", () => {
    const { session, closed } = connectingHarness(async () => credential);
    session.hangUp();
    expect(closed).toEqual([{ code: 1000, reason: "hang_up" }]);
  });

  it("does not dial a refreshed credential that arrives after hang-up", async () => {
    let resolveRefresh: (value: typeof credential) => void = () => {};
    const { session, listeners, urls, ended } = connectingHarness(
      () => new Promise((resolve) => (resolveRefresh = resolve)),
    );
    listeners[0]!.close({ code: 1006, clean: false });
    expect(session.phase).toBe("reconnecting");
    session.hangUp();
    resolveRefresh(credential);
    await flush();
    expect(urls).toHaveLength(1);
    expect(ended).toEqual(["hang_up"]);
  });

  it("ends the call when the refreshed endpoint is not the official origin", async () => {
    const { session, listeners, urls, ended } = connectingHarness(async () => ({
      ...credential,
      websocketUrl: "wss://evil.test/v1/realtime",
    }));
    listeners[0]!.close({ code: 1006, clean: false });
    await flush();
    expect(urls).toHaveLength(1);
    expect(ended).toEqual(["error"]);
    expect(session.phase).toBe("closed");
  });
});

describe("call session timers", () => {
  function clock() {
    let now = 0;
    let nextId = 1;
    const pending = new Map<number, { at: number; fn: () => void }>();
    return {
      timers: {
        setTimeout: (fn: () => void, ms: number) => {
          const id = nextId++;
          pending.set(id, { at: now + ms, fn });
          return id;
        },
        clearTimeout: (handle: unknown) => void pending.delete(handle as number),
      },
      advance: (ms: number) => {
        const target = now + ms;
        for (;;) {
          const due = [...pending.entries()]
            .filter(([, t]) => t.at <= target)
            .sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          pending.delete(due[0]);
          now = due[1].at;
          due[1].fn();
        }
        now = target;
      },
      get pending() {
        return pending.size;
      },
    };
  }

  function timedHarness(maxReconnects = 2) {
    const c = clock();
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const closes: Array<{ code: number; reason: string }> = [];
    const ended: string[] = [];
    let refreshes = 0;
    const session = createVoiceCallSession({
      credential,
      instructions: "",
      tools: [],
      voice,
      maxReconnects,
      handshakeTimeoutMs: 1000,
      healthyWindowMs: 5000,
      timers: c.timers,
      ports: {
        openSocket: () => {
          const fake = fakeSocket();
          const base = fake.socket.close;
          fake.socket.close = (code, reason) => {
            closes.push({ code, reason });
            base(code, reason);
          };
          sockets.push(fake);
          return fake.socket;
        },
        refreshCredential: async () => {
          refreshes += 1;
          return { ...credential, clientSecret: "sek2" };
        },
        runTool: async () => "{}",
      },
      onEvent: () => {},
      onPhase: () => {},
      onEnded: (reason) => void ended.push(reason),
    });
    return { c, session, sockets, closes, ended, refreshes: () => refreshes };
  }

  it("treats a connected socket that never reports ready as a dropped path", async () => {
    const h = timedHarness();
    h.c.advance(1000);
    expect(h.closes).toEqual([{ code: 4000, reason: "handshake_timeout" }]);
    expect(h.session.phase).toBe("reconnecting");
    await flush();
    expect(h.sockets).toHaveLength(2);
  });

  it("ends with an error once handshake timeouts spend the budget", async () => {
    const h = timedHarness(2);
    for (let i = 0; i < 3; i += 1) {
      h.c.advance(1000);
      await flush();
    }
    expect(h.sockets).toHaveLength(3);
    expect(h.ended).toEqual(["error"]);
    expect(h.c.pending).toBe(0);
  });

  it("cancels the handshake timer once the session is ready", () => {
    const h = timedHarness();
    h.sockets[0]!.listeners.message(ready);
    h.c.advance(1000);
    expect(h.session.phase).toBe("live");
    expect(h.closes).toEqual([]);
  });

  it("does not forgive reconnects for a path that flaps right after ready", async () => {
    const h = timedHarness(2);
    for (let i = 0; i < 3; i += 1) {
      h.sockets[i]!.listeners.message(ready);
      h.c.advance(100);
      h.session.dropForReconnect();
      await flush();
    }
    expect(h.ended).toEqual(["error"]);
    expect(h.sockets).toHaveLength(3);
  });

  it("forgives reconnects after a healthy window", async () => {
    const h = timedHarness(1);
    for (let i = 0; i < 3; i += 1) {
      h.sockets[i]!.listeners.message(ready);
      h.c.advance(5000);
      h.session.dropForReconnect();
      await flush();
    }
    expect(h.ended).toEqual([]);
    expect(h.sockets).toHaveLength(4);
  });

  it("cancels timers on hang-up and never resurrects the call", async () => {
    const h = timedHarness();
    h.sockets[0]!.listeners.close({ code: 1006, clean: false });
    h.session.hangUp();
    h.c.advance(60_000);
    await flush();
    expect(h.c.pending).toBe(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.ended).toEqual(["hang_up"]);
    expect(h.refreshes()).toBe(1);
  });

  it("ignores a late ready from a timed-out socket", async () => {
    const h = timedHarness();
    h.c.advance(1000);
    await flush();
    h.sockets[0]!.listeners.message(ready);
    expect(h.session.phase).toBe("reconnecting");
    expect(h.sockets[0]!.sent).toEqual([]);
  });
});
