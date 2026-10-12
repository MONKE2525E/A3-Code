import { describe, expect, it, vi } from "vite-plus/test";
import {
  createVoiceCallSession,
  type VoiceSocket,
  type VoiceCallSessionInput,
} from "./callSession.ts";
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

function harness(
  overrides: {
    runTool?: () => Promise<string>;
    onToolResult?: VoiceCallSessionInput["onToolResult"];
    onSocket?: () => void;
    greeting?: string;
  } = {},
) {
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
    ...(overrides.greeting === undefined ? {} : { greeting: overrides.greeting }),
    ...(overrides.onToolResult === undefined ? {} : { onToolResult: overrides.onToolResult }),
    ports: {
      openSocket: (url, protocols) => {
        const fake = fakeSocket();
        sockets.push({ url, protocols, fake });
        overrides.onSocket?.();
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
function configure(fake: ReturnType<typeof fakeSocket>) {
  fake.listeners.message(ready);
  fake.listeners.message(JSON.stringify({ type: "session.updated" }));
  fake.listeners.message(JSON.stringify({ type: "response.done" }));
  fake.sent.splice(1); // These tests focus on the frames after the opening greeting.
}
function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("work completion and greeting", () => {
  it("speaks a failed background task directly without asking the model to choose whether to report it", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    h.session.deliverWork(
      "failed-child",
      JSON.stringify({
        runStatus: "failed",
        error: "The child provider failed to open. Check its sign-in in T3.",
      }),
    );
    const frames = fake.sent.map((frame) => JSON.parse(frame));
    expect(
      frames.find((frame) => frame.item?.type === "force_message")?.item.content[0].text,
    ).toContain("provider failed to open");
    expect(frames.filter((frame) => frame.type === "response.create")).toHaveLength(0);
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    h.session.deliverWork("failed-child", JSON.stringify({ error: "duplicate" }));
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.item?.type === "force_message"),
    ).toHaveLength(1);
    h.session.hangUp();
  });

  it("speaks a rejected tool directly while preserving its function output", async () => {
    const h = harness({
      runTool: async () =>
        JSON.stringify({ error: "Choose a coding provider and model from the catalog." }),
    });
    const fake = h.sockets[0]!.fake;
    configure(fake);
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "rejected",
        name: "delegate_task",
        arguments: "{}",
      }),
    );
    await flush();
    const frames = fake.sent.map((frame) => JSON.parse(frame));
    expect(frames.find((frame) => frame.item?.call_id === "rejected")?.item.output).toContain(
      "coding provider",
    );
    expect(
      frames.find((frame) => frame.item?.type === "force_message")?.item.content[0].text,
    ).toContain("coding provider");
    expect(frames.filter((frame) => frame.type === "response.create")).toHaveLength(0);
    h.session.hangUp();
  });
  it("does not sit silently when the server never acknowledges its opening response", async () => {
    vi.useFakeTimers();
    const h = harness({ greeting: "Greet the caller" });
    try {
      const { fake } = h.sockets[0]!;
      fake.listeners.message(ready);
      fake.listeners.message(JSON.stringify({ type: "session.updated" }));
      await vi.advanceTimersByTimeAsync(10_500);
      expect(h.events).toContain("error");
      expect(
        fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "response.create"),
      ).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(
        fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "response.create"),
      ).toHaveLength(2);
    } finally {
      h.session.hangUp();
      vi.useRealTimers();
    }
  });
  it("delivers a full capabilities catalog instead of replacing it with a generic completion", async () => {
    const catalog = JSON.stringify({
      providers: [
        {
          providerInstanceId: "provider",
          models: Array.from({ length: 200 }, (_, i) => ({
            id: `model-${i}`,
            description: "option".repeat(30),
          })),
        },
      ],
    });
    const h = harness({ runTool: async () => catalog });
    const { fake } = h.sockets[0]!;
    configure(fake);
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "catalog",
        name: "orchestrator_capabilities",
        arguments: "{}",
      }),
    );
    await flush();
    const receipt = fake.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.item?.call_id === "catalog");
    expect(receipt.item.output).toBe(catalog);
    h.session.hangUp();
  });

  it("waits for every parallel tool receipt before continuing", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let count = 0;
    const h = harness({ runTool: () => (++count === 1 ? first.promise : second.promise) });
    const { fake } = h.sockets[0]!;
    configure(fake);
    for (const id of ["first", "second"])
      fake.listeners.message(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: id,
          name: "t3_thread_read",
          arguments: "{}",
        }),
      );
    first.resolve('{"ok":true}');
    await flush();
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(0);
    second.resolve('{"ok":true}');
    await flush();
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(1);
    h.session.hangUp();
  });

  it("recovers a rejected continuation once without repeating the tool action", async () => {
    vi.useFakeTimers();
    let executions = 0;
    const h = harness({
      runTool: async () => {
        executions++;
        return '{"ok":true}';
      },
    });
    try {
      const { fake } = h.sockets[0]!;
      configure(fake);
      fake.listeners.message(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "failed-tool",
          name: "delegate_task",
          arguments: "{}",
        }),
      );
      await flush();
      const reject = () =>
        fake.listeners.message(
          JSON.stringify({ type: "error", error: { message: "Response request failed" } }),
        );
      reject();
      await vi.advanceTimersByTimeAsync(500);
      expect(
        fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "response.create"),
      ).toHaveLength(2);
      reject();
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "response.create"),
      ).toHaveLength(2);
      expect(executions).toBe(1);
      fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
      fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
      expect(
        fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "response.create"),
      ).toHaveLength(3);
    } finally {
      h.session.hangUp();
      vi.useRealTimers();
    }
  });
  it("acknowledges slow tools so the call can answer while the action runs, then speaks the result once", async () => {
    vi.useFakeTimers();
    const result = deferred<string>();
    let executions = 0;
    const h = harness({
      runTool: () => {
        executions++;
        return result.promise;
      },
    });
    try {
      const { fake } = h.sockets[0]!;
      configure(fake);
      const tool = JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "slow",
        name: "t3_thread_read",
        arguments: "{}",
      });
      fake.listeners.message(tool);
      await vi.advanceTimersByTimeAsync(1000);
      const frames = () => fake.sent.map((frame) => JSON.parse(frame));
      const receipt = frames().find((frame) => frame.item?.call_id === "slow");
      expect(JSON.parse(receipt.item.output).status).toBe("running");
      expect(frames().filter((frame) => frame.type === "response.create")).toHaveLength(1);
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
      fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
      fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
      fake.listeners.message(tool);
      expect(executions).toBe(1);
      h.session.deliverWork("independent", "Another task finished");
      expect(frames().filter((frame) => frame.item?.name === "work_landed")).toHaveLength(1);
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
      result.resolve('{"title":"Found thread"}');
      await flush();
      expect(frames().filter((frame) => frame.item?.call_id === "slow")).toHaveLength(1);
      expect(frames().filter((frame) => frame.item?.name === "work_landed")).toHaveLength(2);
      expect(JSON.stringify(frames())).toContain("Found thread");
      expect(executions).toBe(1);
    } finally {
      h.session.hangUp();
      vi.useRealTimers();
    }
  });

  it("drops progress timers and late results when a caller hangs up during a slow tool", async () => {
    vi.useFakeTimers();
    const result = deferred<string>();
    const h = harness({ runTool: () => result.promise });
    try {
      const { fake } = h.sockets[0]!;
      configure(fake);
      fake.listeners.message(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "slow",
          name: "t3_thread_read",
          arguments: "{}",
        }),
      );
      h.session.hangUp();
      const count = fake.sent.length;
      await vi.advanceTimersByTimeAsync(1000);
      result.resolve("late result");
      await flush();
      expect(fake.sent).toHaveLength(count);
    } finally {
      h.session.hangUp();
      vi.useRealTimers();
    }
  });
  it("waits for an active response before speaking a tool receipt, then delivers completed work", async () => {
    const h = harness();
    const { fake } = h.sockets[0]!;
    configure(fake);
    fake.listeners.message(JSON.stringify({ type: "response.created" }));
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "tool",
        name: "t3_thread_launch",
        arguments: "{}",
      }),
    );
    await flush();
    h.session.deliverWork("tool", '{"updates":["Done"]}');
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(0);
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(1);
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.item?.name === "work_landed"),
    ).toHaveLength(0);
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(2);
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.item?.name === "work_landed"),
    ).toHaveLength(1);
    h.session.hangUp();
  });
  it("does not repeat a greeting on reconnect or after hang-up", async () => {
    const h = harness();
    const first = h.sockets[0]!.fake;
    first.listeners.message(ready);
    first.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(
      first.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(1);
    h.session.dropForReconnect();
    await flush();
    const next = h.sockets[1]!.fake;
    next.listeners.message(ready);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(
      next.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(0);
    h.session.hangUp();
    const count = next.sent.length;
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    h.session.deliverWork("late", "{}");
    expect(next.sent).toHaveLength(count);
  });

  it("does not greet when hung up before configuration", () => {
    const h = harness();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    h.session.hangUp();
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toEqual([]);
  });

  it("drops muted microphone input while delivering completed work once", () => {
    const h = harness();
    const { fake } = h.sockets[0]!;
    configure(fake);
    h.session.setMuted(true);
    h.session.deliverWork("task-1", '{"updates":["Done"]}');
    h.session.deliverWork("task-1", '{"updates":["Duplicate"]}');
    h.session.sendAudio("AAAA");
    expect(fake.sent.some((frame) => frame.includes("input_audio_buffer.append"))).toBe(false);
    expect(fake.sent.some((frame) => frame.includes("response.create"))).toBe(true);
    h.session.setMuted(false);
    h.session.deliverWork("task-1", '{"updates":["Duplicate"]}');
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.item?.name === "work_landed"),
    ).toHaveLength(1);
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(1);
    h.session.hangUp();
  });
});

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
      resumption: { enabled: true },
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
    configure(fake);
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
      expect.objectContaining({ type: "response.create" }),
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

describe("call-owned reconnect queues", () => {
  const frames = (fake: ReturnType<typeof fakeSocket>) =>
    fake.sent.map((frame) => JSON.parse(frame));
  const tool = JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "launch",
    name: "t3_thread_launch",
    arguments: "{}",
  });

  it("retains an accepted tool across reconnect, notifies once, and waits for configuration", async () => {
    const result = deferred<string>();
    const known = deferred<void>();
    const attached = deferred<void>();
    let invocations = 0;
    const notified: string[] = [];
    const h = harness({
      runTool: () => {
        invocations += 1;
        return result.promise;
      },
      onToolResult: (id) => {
        notified.push(id);
        known.resolve();
      },
      onSocket: () => {
        if (invocations > 0) attached.resolve();
      },
    });
    const first = h.sockets[0]!.fake;
    configure(first);
    first.listeners.message(tool);
    h.session.dropForReconnect();
    await attached.promise;
    result.resolve('{"accepted":true}');
    await known.promise;
    const next = h.sockets[1]!.fake;
    next.listeners.message(ready);
    next.listeners.message(tool);
    expect(frames(next).map((f) => f.type)).toEqual(["session.update"]);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(frames(next).slice(1)).toEqual([
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "launch", output: '{"accepted":true}' },
      },
      expect.objectContaining({ type: "response.create" }),
    ]);
    expect(notified).toEqual(["launch"]);
    expect(invocations).toBe(1);
    expect(frames(first).filter((f) => f.item)).toEqual([]);
    h.session.hangUp();
  });

  it("resumes an owed receipt after reconnect before completed work, including mute", async () => {
    const known = deferred<void>();
    const attached = deferred<void>();
    let sockets = 0;
    const h = harness({
      onToolResult: () => known.resolve(),
      onSocket: () => {
        if (++sockets === 2) attached.resolve();
      },
    });
    const first = h.sockets[0]!.fake;
    first.listeners.message(ready);
    first.listeners.message(JSON.stringify({ type: "session.updated" }));
    first.listeners.message(tool);
    await known.promise;
    h.session.setMuted(true);
    h.session.dropForReconnect();
    await attached.promise;
    h.session.deliverWork("launch", '{"updates":["Done"]}');
    const next = h.sockets[1]!.fake;
    next.listeners.message(ready);
    expect(frames(next).map((f) => f.type)).toEqual(["session.update"]);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(frames(next).map((f) => f.type)).toEqual([
      "session.update",
      "conversation.item.create",
      "response.create",
    ]);
    h.session.setMuted(false);
    expect(frames(next).filter((f) => f.item?.name === "work_landed")).toHaveLength(0);
    next.listeners.message(JSON.stringify({ type: "response.done" }));
    expect(
      frames(next)
        .slice(-3)
        .map((f) => f.item?.type ?? f.type),
    ).toEqual(["function_call", "function_call_output", "response.create"]);
    h.session.deliverWork("launch", "duplicate");
    next.listeners.message(JSON.stringify({ type: "response.done" }));
    expect(frames(next).filter((f) => f.item?.name === "work_landed")).toHaveLength(1);
    h.session.hangUp();
  });

  it("greets once when the first configuration handshake fails, with initial instruction fallback", async () => {
    const attached = deferred<void>();
    let sockets = 0;
    const h = harness({
      greeting: "  ",
      onSocket: () => {
        if (++sockets === 2) attached.resolve();
      },
    });
    h.sockets[0]!.fake.listeners.message(ready);
    h.session.dropForReconnect();
    await attached.promise;
    const next = h.sockets[1]!.fake;
    next.listeners.message(ready);
    expect(frames(next)[0].session.instructions).toMatch(/^be brief\nA tool result/);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(frames(next).filter((f) => f.type === "response.create")).toEqual([
      expect.objectContaining({ type: "response.create" }),
    ]);
    h.session.hangUp();
  });

  it("holds queued work through replacement configuration and ignores stale acknowledgements", async () => {
    const attached = deferred<void>();
    let sockets = 0;
    const h = harness({
      onSocket: () => {
        if (++sockets === 2) attached.resolve();
      },
    });
    const first = h.sockets[0]!.fake;
    configure(first);
    h.session.dropForReconnect();
    h.session.deliverWork("queued", "{}");
    await attached.promise;
    const next = h.sockets[1]!.fake;
    next.listeners.message(ready);
    first.listeners.message(JSON.stringify({ type: "session.updated" }));
    h.session.setMuted(false);
    expect(frames(next).map((f) => f.type)).toEqual(["session.update"]);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(
      frames(next)
        .slice(1)
        .map((f) => f.item?.type ?? f.type),
    ).toEqual(["function_call", "function_call_output", "response.create"]);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(frames(next).filter((f) => f.item?.name === "work_landed")).toHaveLength(1);
    h.session.hangUp();
  });
});

describe("response-acknowledged delivery and bounded backlog", () => {
  const emit = (fake: ReturnType<typeof fakeSocket>, type: string, id?: string, status?: string) =>
    fake.listeners.message(JSON.stringify({ type, ...(id ? { response: { id, status } } : {}) }));
  const frames = (fake: ReturnType<typeof fakeSocket>) => fake.sent.map((s) => JSON.parse(s));
  const outputs = (fake: ReturnType<typeof fakeSocket>) =>
    frames(fake).filter((f) => f.item?.type === "function_call_output");
  const finishResponse = (fake: ReturnType<typeof fakeSocket>, id: string) => {
    emit(fake, "response.created", id);
    emit(fake, "response.done", id, "completed");
  };

  it.each(
    ["work", "receipt"].flatMap((kind) =>
      ["failed", "incomplete", "unknown"].flatMap((status) =>
        ["caller", "reconnect"].map((recovery) => ({ kind, status, recovery })),
      ),
    ),
  )(
    "pauses $kind on repeated $status terminals until $recovery recovery",
    async ({ kind, status, recovery }) => {
      const initialKnown = deferred<void>();
      const laterKnown = deferred<void>();
      const attached = deferred<void>();
      let socketCount = 0;
      let runs = 0;
      const h = harness({
        runTool: async () => {
          runs += 1;
          return '{"accepted":true}';
        },
        onToolResult: (id) => (id === "initial" ? initialKnown : laterKnown).resolve(),
        onSocket: () => {
          if (++socketCount === 2) attached.resolve();
        },
      });
      const first = h.sockets[0]!.fake;
      configure(first);
      const tool = (id: string) =>
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: id,
          name: "read",
        });
      if (kind === "work") h.session.deliverWork("initial", '{"updates":["Saved"]}');
      else {
        first.listeners.message(tool("initial"));
        await initialKnown.promise;
      }
      expect(outputs(first)).toHaveLength(1);
      const before = first.sent.length;
      // Even unsolicited repeated attempts and stale completions cannot trigger a retry.
      for (let i = 0; i < 10; i += 1) {
        emit(first, "response.created", "failed-" + i);
        emit(first, "response.done", "failed-" + i, status);
        emit(first, "response.done", "failed-" + i, "completed");
        expect(first.sent).toHaveLength(before);
      }
      expect(h.events).toContain("error");
      h.session.deliverWork("later", "{}");
      if (kind === "receipt") {
        first.listeners.message(tool("later"));
        await laterKnown.promise;
        first.listeners.message(tool("initial"));
        expect(runs).toBe(2);
      }
      h.session.setMuted(true);
      h.session.setMuted(false);
      emit(first, "session.updated");
      // A duplicate speech-stopped event is not a new caller recovery edge.
      emit(first, "input_audio_buffer.speech_stopped");
      expect(first.sent).toHaveLength(before);

      let resumed = first;
      if (recovery === "caller") {
        emit(first, "input_audio_buffer.speech_started");
        expect(first.sent).toHaveLength(before);
        emit(first, "input_audio_buffer.speech_stopped");
      } else {
        h.session.dropForReconnect();
        await attached.promise;
        resumed = h.sockets[1]!.fake;
        emit(resumed, "session.created");
        expect(resumed.sent).toHaveLength(1);
        emit(resumed, "session.updated");
      }
      const replay = outputs(resumed).slice(resumed === first ? 1 : 0);
      expect(replay).toHaveLength(2);
      expect(replay[0].item.output).toBe(outputs(first)[0].item.output);
      expect(frames(resumed).filter((f) => f.type === "response.create")).toHaveLength(
        resumed === first ? 2 : 1,
      );
      finishResponse(resumed, "recovered");
      if (kind === "receipt") {
        // Successful receipt acknowledgement still drains queued work.
        expect(outputs(resumed).at(-1).item.call_id).toBe("seeded-nudge-t3-later");
        finishResponse(resumed, "later-work");
      }
      const acknowledged = resumed.sent.length;
      emit(resumed, "response.done", "recovered", "completed");
      h.session.deliverWork(kind === "work" ? "initial" : "later", "duplicate");
      h.session.deliverWork("later", "duplicate");
      if (kind === "receipt") {
        resumed.listeners.message(tool("initial"));
        resumed.listeners.message(tool("later"));
        expect(runs).toBe(2);
      }
      emit(resumed, "input_audio_buffer.speech_started");
      emit(resumed, "input_audio_buffer.speech_stopped");
      h.session.setMuted(false);
      expect(resumed.sent).toHaveLength(acknowledged);
      h.session.hangUp();
    },
  );

  it.each([false, true])(
    "replays unfinished work across disconnect (created=%s), then deduplicates completed delivery",
    async (created) => {
      const h = harness();
      const first = h.sockets[0]!.fake;
      configure(first);
      h.session.deliverWork("recover", '{"updates":["Done"]}');
      if (created) emit(first, "response.created", "old");
      h.session.dropForReconnect();
      await flush();
      const next = h.sockets[1]!.fake;
      emit(next, "session.created");
      expect(next.sent).toHaveLength(1);
      emit(next, "session.updated");
      expect(outputs(next).map((f) => f.item.output)).toEqual(['{"updates":["Done"]}']);
      emit(next, "response.created", "new");
      // Both the old socket and stale IDs on the replacement cannot acknowledge this batch.
      emit(first, "response.done", "old", "completed");
      emit(next, "response.done", "old", "completed");
      emit(next, "response.cancelled", "old");
      h.session.deliverWork("queued", "{}");
      expect(outputs(next)).toHaveLength(1);
      emit(next, "response.done", "new", "completed");
      expect(outputs(next)).toHaveLength(2);
      finishResponse(next, "queued-response");
      h.session.deliverWork("recover", "duplicate");
      h.session.deliverWork("queued", "duplicate");
      h.session.dropForReconnect();
      await flush();
      const last = h.sockets[2]!.fake;
      emit(last, "session.created");
      emit(last, "session.updated");
      expect(frames(last).map((f) => f.type)).toEqual(["session.update"]);
      h.session.hangUp();
    },
  );

  it.each([false, true])(
    "replays an interrupted receipt without invoking its backend again (created=%s)",
    async (created) => {
      let runs = 0;
      const h = harness({
        runTool: async () => {
          runs += 1;
          return '{"accepted":true}';
        },
      });
      const first = h.sockets[0]!.fake;
      configure(first);
      const call = JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "receipt",
        name: "t3_thread_launch",
      });
      first.listeners.message(call);
      await flush();
      if (created) emit(first, "response.created", "receipt-old");
      h.session.dropForReconnect();
      await flush();
      const next = h.sockets[1]!.fake;
      emit(next, "session.created");
      emit(next, "session.updated");
      next.listeners.message(call);
      expect(runs).toBe(1);
      expect(outputs(next).map((f) => f.item.call_id)).toEqual(["receipt"]);
      h.session.deliverWork("receipt", "{}");
      emit(next, "response.created", "receipt-new");
      emit(next, "response.done", "receipt-old", "completed");
      expect(outputs(next)).toHaveLength(1);
      emit(next, "response.done", "receipt-new", "completed");
      expect(outputs(next)).toHaveLength(2);
      finishResponse(next, "work");
      h.session.hangUp();
    },
  );

  it.each(["response.cancelled", "response.done"])(
    "recovers barge-in %s after speech stops and ignores a late terminal event",
    (type) => {
      const h = harness();
      const fake = h.sockets[0]!.fake;
      configure(fake);
      h.session.deliverWork("interrupted", "{}");
      emit(fake, "response.created", "interrupted-response");
      emit(fake, "input_audio_buffer.speech_started");
      emit(fake, type, "interrupted-response", "cancelled");
      expect(outputs(fake)).toHaveLength(1);
      emit(fake, "input_audio_buffer.speech_stopped");
      expect(outputs(fake)).toHaveLength(2);
      emit(fake, "response.created", "retry-response");
      emit(fake, "response.done", "interrupted-response", "completed");
      h.session.deliverWork("later", "{}");
      expect(outputs(fake)).toHaveLength(2);
      emit(fake, "response.done", "retry-response", "completed");
      expect(outputs(fake)).toHaveLength(3);
      h.session.hangUp();
    },
  );

  it("bounds a 5,000-result speaking backlog and drains bounded batches with an exact overflow notice", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    emit(fake, "input_audio_buffer.speech_started");
    const output = JSON.stringify({ updates: ["x".repeat(4000)] });
    for (let i = 0; i < 5000; i += 1) h.session.deliverWork("stress-" + i, output);
    expect(outputs(fake)).toHaveLength(0);
    emit(fake, "input_audio_buffer.speech_stopped");
    expect(outputs(fake)).toHaveLength(8);
    let before = 0;
    let framesBefore = 1;
    for (let i = 0; i < 20; i += 1) {
      const current = outputs(fake);
      const batch = current.slice(before);
      expect(batch.length).toBeLessThanOrEqual(8);
      expect(
        new TextEncoder().encode(batch.map((f) => f.item.output).join("")).byteLength,
      ).toBeLessThanOrEqual(32 * 1024);
      expect(
        new TextEncoder().encode(fake.sent.slice(framesBefore).join("")).byteLength,
      ).toBeLessThanOrEqual(128 * 1024 + 26);
      framesBefore = fake.sent.length;
      before = current.length;
      finishResponse(fake, "batch-" + i);
    }
    const result = outputs(fake);
    expect(result.filter((f) => f.item.call_id.startsWith("seeded-nudge-t3-stress-"))).toHaveLength(
      64,
    );
    const notice = result.map((f) => JSON.parse(f.item.output)).find((o) => o.additionalResults);
    expect(notice.additionalResults).toBe(4936);
    expect(notice.updates[0]).toContain("available in T3");
    expect(notice.updates[0]).toContain("on demand");
    expect(new TextEncoder().encode(fake.sent.join("")).byteLength).toBeLessThan(300_000);
    // An overflowed identity in the retained window must not inflate the notice.
    h.session.deliverWork("stress-4999", output);
    expect(outputs(fake)).toHaveLength(65);
    h.session.hangUp();
  });

  it("enforces the byte budget before the count limit and bounds oversized public delivery", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    h.session.setMuted(true);
    const output = JSON.stringify({ updates: ["😀".repeat(3500)] }); // 14 KB UTF-8, valid server text.
    for (let i = 0; i < 64; i += 1) h.session.deliverWork("bytes-" + i, output);
    h.session.deliverWork("oversize", "z".repeat(100_000));
    h.session.setMuted(false);
    for (let i = 0; i < 20; i += 1) finishResponse(fake, "bytes-response-" + i);
    const result = outputs(fake);
    expect(result.filter((f) => f.item.call_id.startsWith("seeded-nudge-t3-bytes-"))).toHaveLength(
      18,
    );
    expect(
      result.map((f) => JSON.parse(f.item.output)).find((o) => o.additionalResults)
        ?.additionalResults,
    ).toBe(46);
    const oversized = result.find((f) => f.item.call_id === "seeded-nudge-t3-oversize");
    expect(JSON.parse(oversized.item.output).error).toBe("result_too_large");
    expect(new TextEncoder().encode(fake.sent.join("")).byteLength).toBeLessThan(270_000);
    h.session.hangUp();
  });

  it("caps concurrent backend tools and retains bounded receipt payloads across reconnect", async () => {
    const result = deferred<string>();
    let runs = 0;
    const h = harness({
      runTool: () => {
        runs += 1;
        return result.promise;
      },
    });
    const first = h.sockets[0]!.fake;
    configure(first);
    for (let i = 0; i < 5000; i += 1)
      first.listeners.message(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "tool-" + i,
          name: "read",
        }),
      );
    expect(runs).toBe(64);
    result.resolve(JSON.stringify({ text: "x".repeat(16_000) }));
    await flush();
    h.session.dropForReconnect();
    await flush();
    const next = h.sockets[1]!.fake;
    emit(next, "session.created");
    emit(next, "session.updated");
    expect(outputs(next)).toHaveLength(64);
    for (let i = 0; i < 10; i += 1) finishResponse(next, "receipt-batch-" + i);
    const receipts = outputs(next).filter((f) => f.item.call_id.startsWith("tool-"));
    expect(receipts).toHaveLength(64);
    expect(
      receipts.every((f) => {
        const output = JSON.parse(f.item.output);
        return output.text?.length === 16000 || output.error === "voice_result_capacity";
      }),
    ).toBe(true);
    expect(
      new TextEncoder().encode(receipts.map((f) => f.item.output).join("")).byteLength,
    ).toBeLessThan(256 * 1024);
    expect(runs).toBe(64);
    h.session.hangUp();
  });
});

describe("bounded identity retention", () => {
  it("never evicts an executed tool identity to admit another backend action", async () => {
    let runs = 0;
    const h = harness({
      runTool: async () => {
        runs += 1;
        return "{}";
      },
    });
    const fake = h.sockets[0]!.fake;
    configure(fake);
    const tool = (id: number) =>
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "retained-" + id,
        name: "read",
      });
    for (let i = 0; i < 600; i += 1) {
      fake.listeners.message(tool(i));
      await flush();
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
    }
    expect(runs).toBe(512);
    h.session.dropForReconnect();
    await flush();
    const next = h.sockets[1]!.fake;
    next.listeners.message(ready);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    next.listeners.message(tool(0));
    await flush();
    expect(runs).toBe(512);
    expect(next.sent).toHaveLength(1);
    h.session.hangUp();
  });

  it("retains the latest 512 completed-work identities while bounding earlier history", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    for (let i = 0; i < 600; i += 1) {
      h.session.deliverWork("retention-" + i, "{}");
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
    }
    const before = fake.sent.length;
    h.session.deliverWork("retention-599", "{}");
    expect(fake.sent).toHaveLength(before);
    // Work dedupe has a finite history; this never re-executes its backend tool.
    h.session.deliverWork("retention-0", "{}");
    expect(fake.sent).toHaveLength(before + 3);
    h.session.hangUp();
  });
});

describe("native response terminal fields", () => {
  it("preserves optional native response IDs/status and distinguishes cancellation", () => {
    expect(
      parseServerEvent(JSON.stringify({ type: "response.created", response: { id: "r" } })),
    ).toEqual({ type: "response.created", responseId: "r" });
    expect(
      parseServerEvent(
        JSON.stringify({ type: "response.done", response: { id: "r", status: "incomplete" } }),
      ),
    ).toEqual({ type: "response.ended", responseId: "r", status: "incomplete", cancelled: false });
    expect(
      parseServerEvent(JSON.stringify({ type: "response.cancelled", response_id: "r" })),
    ).toEqual({ type: "response.ended", responseId: "r", status: null, cancelled: true });
  });

  it("retries an incomplete receipt after barge-in without re-running its tool", async () => {
    let runs = 0;
    const h = harness({
      runTool: async () => {
        runs += 1;
        return "{}";
      },
    });
    const fake = h.sockets[0]!.fake;
    configure(fake);
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "receipt",
        name: "read",
      }),
    );
    await flush();
    fake.listeners.message(JSON.stringify({ type: "response.created", response: { id: "first" } }));
    fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    fake.listeners.message(
      JSON.stringify({ type: "response.done", response: { id: "first", status: "incomplete" } }),
    );
    const outputs = () =>
      fake.sent.map((s) => JSON.parse(s)).filter((f) => f.item?.type === "function_call_output");
    expect(outputs()).toHaveLength(1);
    fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    expect(outputs()).toHaveLength(2);
    fake.listeners.message(JSON.stringify({ type: "response.created", response: { id: "retry" } }));
    fake.listeners.message(
      JSON.stringify({ type: "response.done", response: { id: "retry", status: "completed" } }),
    );
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "receipt",
        name: "read",
      }),
    );
    await flush();
    expect(runs).toBe(1);
    expect(outputs()).toHaveLength(2);
    h.session.hangUp();
  });
});

describe("ID-less native terminal recovery", () => {
  it.each(["response.done", "response.cancelled"])(
    "retains identified delivery on ambiguous %s and retries it after speech",
    (type) => {
      const h = harness();
      const fake = h.sockets[0]!.fake;
      configure(fake);
      h.session.deliverWork("ambiguous", "{}");
      fake.listeners.message(
        JSON.stringify({ type: "response.created", response: { id: "identified" } }),
      );
      fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
      fake.listeners.message(JSON.stringify({ type }));
      fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
      expect(
        fake.sent.map((s) => JSON.parse(s)).filter((f) => f.item?.name === "work_landed"),
      ).toHaveLength(2);
      fake.listeners.message(
        JSON.stringify({ type: "response.created", response: { id: "retry" } }),
      );
      fake.listeners.message(
        JSON.stringify({ type: "response.done", response: { id: "retry", status: "completed" } }),
      );
      h.session.deliverWork("ambiguous", "{}");
      expect(
        fake.sent.map((s) => JSON.parse(s)).filter((f) => f.item?.name === "work_landed"),
      ).toHaveLength(2);
      h.session.hangUp();
    },
  );
});
