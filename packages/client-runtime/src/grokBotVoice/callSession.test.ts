import { describe, expect, it, vi } from "vite-plus/test";
import { createVoicePlayer } from "../../../../apps/web/src/components/grokBot/grokBotVoiceAudio.ts";
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
    instructions?: string;
    greeting?: string;
    refreshCredential?: VoiceCallSessionInput["ports"]["refreshCredential"];
    waitForPlayback?: VoiceCallSessionInput["waitForPlayback"];
    onEvent?: VoiceCallSessionInput["onEvent"];
  } = {},
) {
  const sockets: Array<{ url: string; protocols: string[]; fake: ReturnType<typeof fakeSocket> }> =
    [];
  const phases: string[] = [];
  const ended: string[] = [];
  const events: string[] = [];
  const session = createVoiceCallSession({
    credential,
    instructions: overrides.instructions ?? "be brief",
    tools: [{ type: "function", name: "send_task" }],
    voice,
    ...(overrides.greeting === undefined ? {} : { greeting: overrides.greeting }),
    ...(overrides.onToolResult === undefined ? {} : { onToolResult: overrides.onToolResult }),
    ...(overrides.waitForPlayback === undefined
      ? {}
      : { waitForPlayback: overrides.waitForPlayback }),
    ports: {
      openSocket: (url, protocols) => {
        const fake = fakeSocket();
        sockets.push({ url, protocols, fake });
        overrides.onSocket?.();
        return fake.socket;
      },
      refreshCredential:
        overrides.refreshCredential ?? (async () => ({ ...credential, clientSecret: "sek2" })),
      runTool: overrides.runTool ?? (async () => '{"ok":true}'),
    },
    onEvent: (event) => {
      events.push(event.type);
      overrides.onEvent?.(event);
    },
    onPhase: (phase) => void phases.push(phase),
    onEnded: (reason) => void ended.push(reason),
  });
  return { session, sockets, phases, ended, events };
}
const ready = JSON.stringify({ type: "session.created" });
function callerRequest(fake: ReturnType<typeof fakeSocket>, text = "Run the requested task") {
  fake.listeners.message(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "current-caller",
      transcript: text,
    }),
  );
}
function configure(fake: ReturnType<typeof fakeSocket>, currentCaller = true) {
  fake.listeners.message(ready);
  fake.listeners.message(JSON.stringify({ type: "session.updated" }));
  // Tool-delivery tests begin after caller input. Startup regressions opt out explicitly.
  if (currentCaller) callerRequest(fake);
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

describe("current caller startup guard", () => {
  const emit = (fake: ReturnType<typeof fakeSocket>, event: unknown) =>
    fake.listeners.message(JSON.stringify(event));
  const tool = (fake: ReturnType<typeof fakeSocket>, callId: string, name = "delegate_task") =>
    emit(fake, {
      type: "response.function_call_arguments.done",
      call_id: callId,
      name,
      arguments: JSON.stringify({ task: "Build the old chat request" }),
    });
  const textInput = (fake: ReturnType<typeof fakeSocket>) =>
    emit(fake, {
      type: "conversation.item.added",
      item: {
        id: "current-text",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Please run the new task" }],
      },
    });
  const outputs = (fake: ReturnType<typeof fakeSocket>) =>
    fake.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.item?.type === "function_call_output");

  it("rejects startup get_async_updates and old delegation without a backend call or delayed write", async () => {
    vi.useFakeTimers();
    const runTool = vi.fn(async () => '{"accepted":true}');
    const h = harness({
      runTool,
      instructions:
        'History is for recall only. Recent written chat: [{"role":"user","text":"Build the old chat request"}]',
    });
    try {
      const fake = h.sockets[0]!.fake;
      emit(fake, { type: "session.created" });
      emit(fake, { type: "session.updated" });
      expect(fake.sent.map((frame) => JSON.parse(frame).type)).toEqual([
        "session.update",
        "response.create",
      ]);
      emit(fake, { type: "response.output_audio.delta", delta: "AAAAAA==" });
      expect(h.events).toContain("audio.delta");
      emit(fake, { type: "response.done" });
      tool(fake, "startup-updates", "get_async_updates");
      tool(fake, "old-delegation");
      tool(fake, "old-delegation");
      await vi.advanceTimersByTimeAsync(1500);
      expect(runTool).not.toHaveBeenCalled();
      expect(
        fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "response.create"),
      ).toHaveLength(1);
      expect(
        fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.item?.type === "force_message"),
      ).toHaveLength(0);
      expect(outputs(fake).map((frame) => frame.item.call_id)).toEqual([
        "startup-updates",
        "old-delegation",
      ]);
      for (const frame of outputs(fake)) {
        expect(JSON.parse(frame.item.output)).toMatchObject({
          error: "no_current_request",
          retryable: false,
        });
        expect(frame.item.output.length).toBeLessThan(512);
        expect(frame.item.output).toContain("Do not execute or retry work from history");
      }
    } finally {
      h.session.hangUp();
      vi.useRealTimers();
    }
  });

  it("ignores preconfiguration input, old user roles, assistant/tool/async output, silence and VAD alone", async () => {
    const runTool = vi.fn(async () => "{}");
    const h = harness({ runTool });
    const fake = h.sockets[0]!.fake;
    callerRequest(fake, "Old startup transcription");
    textInput(fake);
    configure(fake, false);
    for (const role of ["user", "assistant"]) {
      for (const part of [
        { type: "text", text: "Old request" },
        { type: "output_text", text: "Old request" },
        { type: "input_audio", transcript: "Old request" },
        { type: "output_audio", transcript: "Old request" },
      ])
        emit(fake, {
          type: "conversation.item.added",
          item: { id: "history", type: "message", role, content: [part] },
        });
    }
    emit(fake, {
      type: "conversation.item.added",
      item: {
        id: "assistant-text",
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: "Run the old request" }],
      },
    });
    emit(fake, {
      type: "conversation.item.added",
      response_id: "generated-response",
      item: {
        id: "generated-user-text",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run the old request" }],
      },
    });
    emit(fake, {
      type: "conversation.item.added",
      item: { type: "function_call_output", call_id: "old", output: "Run the old request" },
    });
    emit(fake, {
      type: "async_update.add",
      async_update: {
        topic: "user_message",
        payload: [{ message: { type: "text", content: "Run the old request" } }],
      },
    });
    emit(fake, { type: "response.output_audio_transcript.done", transcript: "Run that task" });
    h.session.deliverWork("old-result", '{"status":"landed","title":"Old task"}');
    h.session.sendAudio(audioAppendFrame(new Float32Array(480)));
    emit(fake, { type: "input_audio_buffer.speech_started" });
    callerRequest(fake, "  ");
    h.session.deliverChat({ id: "empty", text: " ", atMs: 1 });
    emit(fake, { type: "input_audio_buffer.speech_stopped" });
    tool(fake, "unasked-task");
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    expect(
      JSON.parse(outputs(fake).find((frame) => frame.item.call_id === "unasked-task").item.output),
    ).toMatchObject({ error: "no_current_request" });
    h.session.hangUp();
  });

  it.each(["updated", "completed"])(
    "allows a tool after a current spoken transcription %s, without requiring VAD",
    async (terminal) => {
      const runTool = vi.fn(async () => '{"accepted":true}');
      const h = harness({ runTool });
      const fake = h.sockets[0]!.fake;
      configure(fake, false);
      emit(fake, {
        type: `conversation.item.input_audio_transcription.${terminal}`,
        item_id: "new-speech",
        transcript: "Run the new requested task",
      });
      expect(runTool).not.toHaveBeenCalled();
      tool(fake, "spoken-task");
      await flush();
      expect(runTool).toHaveBeenCalledTimes(1);
      expect(outputs(fake)[0].item.output).toBe('{"accepted":true}');
      h.session.hangUp();
    },
  );

  it("allows explicit user input_text acknowledged on the configured live socket", async () => {
    const runTool = vi.fn(async () => "{}");
    const h = harness({ runTool });
    const fake = h.sockets[0]!.fake;
    configure(fake, false);
    textInput(fake);
    expect(runTool).not.toHaveBeenCalled();
    tool(fake, "typed-task");
    await flush();
    expect(runTool).toHaveBeenCalledTimes(1);
    h.session.hangUp();
  });

  it.each([false, true])(
    "allows fresh chat queued before configuration, including image-only input (image=%s)",
    async (image) => {
      const runTool = vi.fn(async () => "{}");
      const h = harness({ runTool });
      const fake = h.sockets[0]!.fake;
      h.session.deliverChat({
        id: "new-chat",
        text: image ? "" : "Run the new requested task",
        atMs: 1,
        ...(image ? { attachments: [{ id: "image", name: "screen.png", type: "image" }] } : {}),
      });
      configure(fake, false);
      expect(runTool).not.toHaveBeenCalled();
      tool(fake, "chat-task");
      await flush();
      expect(runTool).toHaveBeenCalledTimes(1);
      h.session.hangUp();
    },
  );

  it("retains rejected startup identities across reconnect and never launches them after current input", async () => {
    const runTool = vi.fn(async () => "{}");
    const h = harness({ runTool });
    const first = h.sockets[0]!.fake;
    configure(first, false);
    tool(first, "old-delegation");
    h.session.dropForReconnect();
    callerRequest(first); // A detached socket cannot authorize its replacement.
    await flush();
    const next = h.sockets[1]!.fake;
    emit(next, { type: "session.created" });
    emit(next, { type: "session.updated" });
    tool(next, "old-delegation");
    tool(next, "another-unasked-task");
    expect(runTool).not.toHaveBeenCalled();
    expect(outputs(next).map((frame) => frame.item.call_id)).toEqual(["another-unasked-task"]);
    callerRequest(next);
    tool(next, "old-delegation");
    tool(next, "another-unasked-task");
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    emit(next, { type: "response.created" });
    tool(next, "current-request");
    await flush();
    expect(runTool).toHaveBeenCalledTimes(1);
    h.session.hangUp();
  });

  it("rejects a tool before configuration without deferring its execution until caller input", async () => {
    const runTool = vi.fn(async () => "{}");
    const h = harness({ runTool });
    const fake = h.sockets[0]!.fake;
    tool(fake, "early-startup-task");
    expect(runTool).not.toHaveBeenCalled();
    emit(fake, { type: "session.created" });
    emit(fake, { type: "session.updated" });
    callerRequest(fake);
    tool(fake, "early-startup-task");
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    expect(outputs(fake).map((frame) => JSON.parse(frame.item.output))).toMatchObject([
      { error: "no_current_request" },
    ]);
    tool(fake, "new-request");
    await flush();
    expect(runTool).toHaveBeenCalledTimes(1);
    h.session.hangUp();
  });

  it.each(["speech", "chat", "input_text"])(
    "retains observed current %s through reconnects and duplicates without an unasked launch",
    async (source) => {
      const runTool = vi.fn(async () => "{}");
      const h = harness({ runTool });
      const first = h.sockets[0]!.fake;
      const message = { id: "new-chat", text: "Run the new task", atMs: 1 };
      const observe = (fake: ReturnType<typeof fakeSocket>) => {
        if (source === "chat") h.session.deliverChat(message);
        else if (source === "speech") callerRequest(fake);
        else textInput(fake);
      };
      configure(first, false);
      observe(first);
      observe(first);
      expect(runTool).not.toHaveBeenCalled();
      tool(first, "current-request");
      await flush();
      h.session.dropForReconnect();
      await flush();
      const next = h.sockets[1]!.fake;
      configure(next, false);
      tool(next, "current-request");
      expect(runTool).toHaveBeenCalledTimes(1);
      emit(next, { type: "response.created" });
      tool(next, "current-followup");
      await flush();
      observe(next);
      observe(next);
      tool(next, "current-followup");
      await flush();
      expect(runTool).toHaveBeenCalledTimes(2);
      h.session.hangUp();
    },
  );
});

describe("tool response ownership", () => {
  const emit = (fake: ReturnType<typeof fakeSocket>, event: unknown) =>
    fake.listeners.message(JSON.stringify(event));
  const tool = (
    fake: ReturnType<typeof fakeSocket>,
    callId: string,
    responseId?: string,
    task = "Run the caller's current request",
  ) =>
    emit(fake, {
      type: "response.function_call_arguments.done",
      call_id: callId,
      name: "delegate_task",
      arguments: JSON.stringify({ task }),
      ...(responseId === undefined ? {} : { response_id: responseId }),
    });

  it("rejects a late old delegate after cancelled greeting and Hello, then admits the current response", async () => {
    const runTool = vi.fn(async () => '{"accepted":true}');
    const h = harness({ runTool });
    const fake = h.sockets[0]!.fake;
    emit(fake, { type: "session.created" });
    emit(fake, { type: "session.updated" });
    emit(fake, { type: "response.created", response: { id: "greeting" } });
    emit(fake, { type: "response.cancelled", response_id: "greeting" });
    callerRequest(fake, "Hello");
    tool(fake, "old-delegate", "greeting", "Build the old canonical chat request");
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    expect(fake.sent.some((frame) => JSON.parse(frame).item?.call_id === "old-delegate")).toBe(
      false,
    );
    emit(fake, { type: "response.created", response: { id: "current-response" } });
    tool(fake, "old-delegate", "current-response");
    tool(fake, "old-delegate");
    tool(fake, "another-old-delegate", "greeting");
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    tool(fake, "current-delegate", "current-response");
    tool(fake, "current-delegate", "current-response");
    await flush();
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith(expect.objectContaining({ callId: "current-delegate" }));
    h.session.hangUp();
  });

  it.each(["completed", "cancelled"])(
    "rejects tools from an ended %s response even after fresh caller input",
    async (status) => {
      const runTool = vi.fn(async () => "{}");
      const h = harness({ runTool });
      const fake = h.sockets[0]!.fake;
      configure(fake, false);
      emit(fake, { type: "response.created", response: { id: "old" } });
      emit(fake, { type: "response.done", response: { id: "old", status } });
      callerRequest(fake);
      tool(fake, "ended-tool", "old");
      tool(fake, "id-less-ended-tool");
      await flush();
      expect(runTool).not.toHaveBeenCalled();
      emit(fake, { type: "response.created", response: { id: "current" } });
      tool(fake, "id-less-ended-tool", "current");
      tool(fake, "active-id-less-tool");
      await flush();
      expect(runTool).toHaveBeenCalledTimes(1);
      h.session.hangUp();
    },
  );

  it("rejects stale and interrupted tool frames before their response ends", async () => {
    const runTool = vi.fn(async () => "{}");
    const h = harness({ runTool });
    const fake = h.sockets[0]!.fake;
    configure(fake);
    emit(fake, { type: "response.created", response: { id: "old-response" } });
    tool(fake, "mismatched-tool", "different-response");
    emit(fake, { type: "input_audio_buffer.speech_started" });
    callerRequest(fake, "Run a new request");
    tool(fake, "interrupted-tool", "old-response");
    tool(fake, "interrupted-id-less-tool");
    emit(fake, { type: "input_audio_buffer.speech_stopped" });
    tool(fake, "late-interrupted-tool", "old-response");
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    emit(fake, { type: "response.cancelled", response_id: "old-response" });
    emit(fake, { type: "response.created", response: { id: "new-response" } });
    tool(fake, "mismatched-tool", "new-response");
    tool(fake, "interrupted-tool", "new-response");
    tool(fake, "interrupted-id-less-tool");
    tool(fake, "late-interrupted-tool", "new-response");
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    tool(fake, "new-tool", "new-response");
    await flush();
    expect(runTool).toHaveBeenCalledTimes(1);
    h.session.hangUp();
  });

  it("remembers unmatched terminal response IDs without interrupting the active response", async () => {
    const runTool = vi.fn(async () => "{}");
    const h = harness({ runTool });
    const fake = h.sockets[0]!.fake;
    configure(fake);
    emit(fake, { type: "response.cancelled", response_id: "cancelled-before-created" });
    emit(fake, { type: "response.created", response: { id: "cancelled-before-created" } });
    tool(fake, "unknown-ended-tool", "cancelled-before-created");
    await flush();
    expect(runTool).not.toHaveBeenCalled();
    emit(fake, { type: "response.created", response: { id: "active" } });
    emit(fake, { type: "response.cancelled", response_id: "other-stale-response" });
    tool(fake, "active-tool", "active");
    await flush();
    expect(runTool).toHaveBeenCalledTimes(1);
    h.session.hangUp();
  });
});

describe("work completion and greeting", () => {
  it("updates a failed screenshot import with recovered references without replaying identical chat", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    const message = { id: "screenshot-message", text: "Check this screenshot", atMs: 100 };
    h.session.deliverChat(message);
    h.session.deliverChat({ ...message, atMs: 200 });
    const recovered = {
      ...message,
      attachments: [{ id: "recovered-screenshot", name: "screen.png", type: "image" }],
    };
    h.session.deliverChat(recovered);
    h.session.deliverChat({ ...recovered, atMs: 300 });
    const updates = fake.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "async_update.add");
    expect(updates).toHaveLength(2);
    expect(updates[0].event_id).toBe("written-turn-screenshot-message");
    expect(updates[1].event_id).not.toBe(updates[0].event_id);
    expect(updates[0].async_update.payload[0].message.content).not.toContain(
      "recovered-screenshot",
    );
    expect(updates[1].async_update.payload[0].message.content).toContain(
      '"id":"recovered-screenshot"',
    );
    h.session.hangUp();
  });

  it("coalesces recovered chat before configuration and ignores its replay after reconnect", async () => {
    const h = harness();
    const first = h.sockets[0]!.fake;
    const message = { id: "queued-screenshot", text: "", atMs: 100 };
    h.session.deliverChat(message);
    const recovered = {
      ...message,
      attachments: [{ id: "image", name: "screen.png", type: "image" }],
    };
    h.session.deliverChat(recovered);
    first.listeners.message(ready);
    first.listeners.message(JSON.stringify({ type: "session.updated" }));
    const updates = (fake: ReturnType<typeof fakeSocket>) =>
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "async_update.add");
    expect(updates(first)).toHaveLength(1);
    expect(updates(first)[0].async_update.payload[0].message.content).toContain('"id":"image"');
    h.session.dropForReconnect();
    await flush();
    const next = h.sockets[1]!.fake;
    next.listeners.message(ready);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    h.session.deliverChat({ ...recovered, atMs: 200 });
    expect(updates(next)).toHaveLength(0);
    h.session.deliverChat({ ...recovered, text: "Use this recovered screenshot" });
    expect(updates(next)).toHaveLength(1);
    expect(updates(next)[0].event_id).not.toBe(updates(first)[0].event_id);
    h.session.hangUp();
  });

  it("delivers image-only chat references to the voice context without reading files", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    h.session.deliverChat({
      id: "image-message",
      text: "",
      atMs: 100,
      attachments: [{ id: "chat-screenshot", name: "screen.png", type: "image" }],
    });
    const update = fake.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "async_update.add");
    expect(update.async_update.payload[0].message.content).toContain('"id":"chat-screenshot"');
    expect(update.async_update.payload[0].message.content).toContain('"name":"screen.png"');
    h.session.hangUp();
  });
  it("wakes on completion with a short task name announcement without a model continuation", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    h.session.deliverWork(
      "finished",
      JSON.stringify({
        status: "landed",
        runStatus: "completed",
        title: "Sync project icons",
        updates: ["Long technical result"],
      }),
    );
    const frames = fake.sent.map((frame) => JSON.parse(frame));
    expect(frames.find((frame) => frame.item?.type === "force_message")?.item.content[0].text).toBe(
      "Sync project icons finished. Its result is ready in T3.",
    );
    expect(frames.filter((frame) => frame.type === "response.create")).toHaveLength(0);
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    h.session.deliverWork("finished", JSON.stringify({ status: "landed", title: "Duplicate" }));
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.item?.type === "force_message"),
    ).toHaveLength(1);
    h.session.hangUp();
  });
  it("keeps full tool errors in context but removes internal IDs from scripted speech", async () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    const h = harness({
      runTool: async () =>
        JSON.stringify({
          error: `Thread ${id} failed. Check node:delegated-task:private-id in T3.`,
        }),
    });
    const fake = h.sockets[0]!.fake;
    configure(fake);
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "error",
        name: "delegate_task",
        arguments: "{}",
      }),
    );
    await flush();
    const frames = fake.sent.map((frame) => JSON.parse(frame));
    expect(
      frames.find((frame) => frame.item?.type === "function_call_output").item.output,
    ).toContain(id);
    const speech = frames.find((frame) => frame.item?.type === "force_message").item.content[0]
      .text;
    expect(speech).not.toContain(id);
    expect(speech).not.toContain("private-id");
    expect(speech).toContain("failed");
    h.session.hangUp();
  });
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

describe("individual work notices", () => {
  const question = {
    status: "input_required",
    title: "Choose cache",
    questions: [{ questions: [{ header: "Cache", question: "Which cache should I use?" }] }],
  };
  const approval = {
    status: "approval_required",
    title: "Update package",
    approvals: [{ title: "Install the new version?" }],
  };
  const finished = { status: "landed", runStatus: "completed", title: "Sync icons" };
  const frames = (fake: ReturnType<typeof fakeSocket>) =>
    fake.sent.map((frame) => JSON.parse(frame));
  const notices = (fake: ReturnType<typeof fakeSocket>) =>
    frames(fake).filter((frame) => frame.item?.type === "force_message");
  const outputs = (fake: ReturnType<typeof fakeSocket>) =>
    frames(fake).filter((frame) => frame.item?.type === "function_call_output");
  const emit = (fake: ReturnType<typeof fakeSocket>, type: string, id?: string, status?: string) =>
    fake.listeners.message(JSON.stringify({ type, ...(id ? { response: { id, status } } : {}) }));
  const finishResponse = (fake: ReturnType<typeof fakeSocket>, id: string) => {
    emit(fake, "response.created", id);
    emit(fake, "response.done", id, "completed");
  };

  it("uses the provider approval prompt and preserves a bounded approve-or-decline instruction", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    h.session.deliverWork(
      "approval",
      JSON.stringify({
        ...approval,
        title: "Very long delegated task name that should be shortened for a quick call notice",
        approvals: [
          {
            title: "Command execution",
            prompt:
              "Install the missing image dependency in this project? " +
              "extra detail ".repeat(100),
          },
        ],
      }),
    );
    const speech = notices(fake)[0].item.content[0].text;
    expect(speech).toContain("Install the missing image dependency");
    expect(speech).not.toContain("Command execution");
    expect(speech).toContain("Say approve or decline.");
    expect(speech.length).toBeLessThanOrEqual(300);
    expect(speech.split(/\s+/).length).toBeLessThanOrEqual(35);
    h.session.hangUp();
  });

  it.each([
    [question, approval, finished],
    [finished, approval, question],
    [approval, { ...approval, title: "Publish release" }, finished],
    [
      finished,
      { ...finished, title: "Old task", runStatus: "cancelled" },
      { ...finished, title: "Other task", runStatus: "interrupted" },
    ],
    [{ error: "The provider failed to open." }, question, approval],
  ])("speaks every queued notice separately in order: %j", (...results) => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    emit(fake, "input_audio_buffer.speech_started");
    results.forEach((result, index) =>
      h.session.deliverWork("notice-" + index, JSON.stringify(result)),
    );
    emit(fake, "input_audio_buffer.speech_stopped");
    results.forEach((result, index) => {
      expect(outputs(fake).map((frame) => frame.item.call_id)).toEqual(
        results.slice(0, index + 1).map((_, i) => "seeded-nudge-t3-notice-" + i),
      );
      const speech = notices(fake)[index].item.content[0].text;
      expect(speech).toContain("title" in result ? result.title : "provider failed to open");
      expect(speech.split(/\s+/).length).toBeLessThanOrEqual(35);
      expect(speech.length).toBeLessThanOrEqual(300);
      if ("status" in result && result.status === "input_required")
        expect(speech).toContain("Which cache");
      if ("status" in result && result.status === "approval_required")
        expect(speech).toContain("approve or decline");
      if ("runStatus" in result && result.runStatus !== "completed") {
        expect(speech).toContain(result.runStatus);
        expect(speech).not.toContain("finished");
      }
      finishResponse(fake, "spoken-" + index);
      h.session.deliverWork("notice-" + index, JSON.stringify({ error: "duplicate" }));
    });
    expect(notices(fake)).toHaveLength(results.length);
    h.session.hangUp();
  });

  it("keeps omitted generic context and the next actionable notice queued", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    emit(fake, "input_audio_buffer.speech_started");
    h.session.deliverWork("question", JSON.stringify(question));
    h.session.deliverWork("details", '{"updates":["Extra detail in T3"]}');
    h.session.deliverWork("approval", JSON.stringify(approval));
    emit(fake, "input_audio_buffer.speech_stopped");
    expect(outputs(fake).map((frame) => frame.item.call_id)).toEqual(["seeded-nudge-t3-question"]);
    finishResponse(fake, "question");
    expect(outputs(fake).map((frame) => frame.item.call_id)).toEqual([
      "seeded-nudge-t3-question",
      "seeded-nudge-t3-details",
    ]);
    expect(notices(fake)).toHaveLength(1);
    expect(frames(fake).filter((frame) => frame.type === "response.create")).toHaveLength(1);
    finishResponse(fake, "details");
    expect(outputs(fake).at(-1).item.call_id).toBe("seeded-nudge-t3-approval");
    expect(notices(fake).at(-1).item.content[0].text).toContain(
      "Update package needs your approval",
    );
    h.session.hangUp();
  });

  it.each(["cancelled", "incomplete"])(
    "retries a %s notice without acknowledging the following notice",
    (status) => {
      const h = harness();
      const fake = h.sockets[0]!.fake;
      configure(fake);
      emit(fake, "input_audio_buffer.speech_started");
      h.session.deliverWork("approval", JSON.stringify(approval));
      h.session.deliverWork("completion", JSON.stringify(finished));
      emit(fake, "input_audio_buffer.speech_stopped");
      emit(fake, "response.created", "interrupted");
      emit(fake, "input_audio_buffer.speech_started");
      emit(fake, "response.done", "interrupted", status);
      expect(outputs(fake)).toHaveLength(1);
      emit(fake, "input_audio_buffer.speech_stopped");
      expect(outputs(fake).map((frame) => frame.item.call_id)).toEqual([
        "seeded-nudge-t3-approval",
        "seeded-nudge-t3-approval",
      ]);
      finishResponse(fake, "retried");
      expect(outputs(fake).at(-1).item.call_id).toBe("seeded-nudge-t3-completion");
      expect(notices(fake).at(-1).item.content[0].text).toContain("Sync icons finished");
      h.session.hangUp();
    },
  );
});

describe("playback-acknowledged notices", () => {
  function playbackHarness(runTool?: () => Promise<string>) {
    const sources: Array<{ ended: () => void; stopped: boolean }> = [];
    const context = {
      currentTime: 0,
      destination: {},
      createBuffer: (_channels: number, length: number, rate: number) => ({
        duration: length / rate,
        copyToChannel: () => {},
      }),
      createBufferSource: () => {
        const source = {
          ended: () => {},
          stopped: false,
          connect: () => {},
          start: () => {},
          stop: () => {
            source.stopped = true;
          },
          addEventListener: (_type: string, listener: () => void) => {
            source.ended = listener;
          },
        };
        sources.push(source);
        return source;
      },
    };
    const player = createVoicePlayer(context as unknown as AudioContext);
    const h = harness({
      ...(runTool === undefined ? {} : { runTool }),
      waitForPlayback: () => player.whenDrained(),
      onEvent: (event) => {
        if (event.type === "audio.delta") player.enqueue(event.samples);
        if (event.type === "speech.started") player.clear();
      },
    });
    return { ...h, sources, player };
  }
  const emit = (fake: ReturnType<typeof fakeSocket>, type: string, id?: string, status?: string) =>
    fake.listeners.message(JSON.stringify({ type, ...(id ? { response: { id, status } } : {}) }));
  const noticeIds = (fake: ReturnType<typeof fakeSocket>) =>
    fake.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.item?.type === "function_call_output")
      .map((frame) => frame.item.call_id);
  const audio = (fake: ReturnType<typeof fakeSocket>, itemId = "spoken-notice") =>
    fake.listeners.message(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: itemId,
        delta: "AAAAAA==",
      }),
    );
  const output = JSON.stringify({ status: "landed", runStatus: "completed", title: "Sync icons" });

  it("speaks two parallel tool failures separately after sending all function outputs, retaining an interrupted second notice", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ error: "first_failed", message: "First operation failed." }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ error: "second_failed", message: "Second operation failed." }),
      );
    const h = playbackHarness(runTool);
    const fake = h.sockets[0]!.fake;
    configure(fake);
    for (const callId of ["first-tool", "second-tool"])
      fake.listeners.message(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: callId,
          name: "write_task",
          arguments: "{}",
        }),
      );
    await flush();
    const frames = () => fake.sent.map((frame) => JSON.parse(frame));
    const notices = () =>
      frames()
        .filter((frame) => frame.item?.type === "force_message")
        .map((frame) => frame.item.content[0].text);
    expect(
      frames()
        .slice(1, 3)
        .map((frame) => frame.item?.call_id),
    ).toEqual(["first-tool", "second-tool"]);
    expect(notices()).toEqual(["The T3 operation failed. First operation failed."]);
    emit(fake, "response.created", "first-failure");
    audio(fake, "first-failure-item");
    emit(fake, "response.done", "first-failure", "completed");
    await flush();
    expect(notices()).toHaveLength(1);
    h.sources[0]!.ended();
    await flush();
    expect(notices()).toEqual([
      "The T3 operation failed. First operation failed.",
      "The T3 operation failed. Second operation failed.",
    ]);
    emit(fake, "response.created", "second-failure");
    audio(fake, "second-failure-item");
    emit(fake, "input_audio_buffer.speech_started");
    emit(fake, "response.done", "second-failure", "cancelled");
    emit(fake, "input_audio_buffer.speech_stopped");
    expect(notices().at(-1)).toBe("The T3 operation failed. Second operation failed.");
    expect(notices()).toHaveLength(3);
    emit(fake, "response.created", "second-retry");
    audio(fake, "second-retry-item");
    emit(fake, "response.done", "second-retry", "completed");
    h.sources[2]!.ended();
    await flush();
    for (const callId of ["first-tool", "second-tool"])
      fake.listeners.message(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: callId,
          name: "write_task",
          arguments: "{}",
        }),
      );
    expect(runTool).toHaveBeenCalledTimes(2);
    expect(notices()).toHaveLength(3);
    h.session.hangUp();
  });

  it("waits for every playing source to end after generation finishes before starting one later notice", async () => {
    const h = playbackHarness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    h.session.deliverWork("first", output);
    emit(fake, "response.created", "first");
    audio(fake);
    audio(fake);
    h.session.deliverWork("later", output);
    emit(fake, "response.done", "first", "completed");
    expect(noticeIds(fake)).toEqual(["seeded-nudge-t3-first"]);
    h.sources[0]!.ended();
    await flush();
    expect(noticeIds(fake)).toEqual(["seeded-nudge-t3-first"]);
    h.sources[1]!.ended();
    await flush();
    expect(noticeIds(fake)).toEqual(["seeded-nudge-t3-first", "seeded-nudge-t3-later"]);
    emit(fake, "response.created", "later");
    emit(fake, "response.done", "later", "completed");
    h.session.deliverWork("first", output);
    h.session.deliverWork("later", output);
    expect(noticeIds(fake)).toHaveLength(2);
    h.session.hangUp();
  });

  it("retains the wake when barge-in clears generated but unplayed audio, then delivers the later notice once", async () => {
    const h = playbackHarness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    h.session.deliverWork("first", output);
    emit(fake, "response.created", "first");
    audio(fake);
    audio(fake);
    emit(fake, "response.done", "first", "completed");
    h.session.deliverWork("later", output);
    emit(fake, "input_audio_buffer.speech_started");
    expect(h.sources.every((source) => source.stopped)).toBe(true);
    await flush();
    expect(noticeIds(fake)).toEqual(["seeded-nudge-t3-first"]);
    emit(fake, "input_audio_buffer.speech_stopped");
    expect(noticeIds(fake)).toEqual(["seeded-nudge-t3-first", "seeded-nudge-t3-first"]);
    emit(fake, "response.created", "retry");
    audio(fake, "retry-notice");
    emit(fake, "response.done", "retry", "completed");
    // End callbacks and completions for cleared audio cannot acknowledge the new attempt.
    h.sources[0]!.ended();
    h.sources[1]!.ended();
    emit(fake, "response.done", "first", "completed");
    await flush();
    expect(noticeIds(fake)).toHaveLength(2);
    h.sources[2]!.ended();
    await flush();
    expect(noticeIds(fake)).toEqual([
      "seeded-nudge-t3-first",
      "seeded-nudge-t3-first",
      "seeded-nudge-t3-later",
    ]);
    emit(fake, "response.created", "later");
    emit(fake, "response.done", "later", "completed");
    h.session.deliverWork("first", output);
    h.session.deliverWork("later", output);
    expect(noticeIds(fake)).toHaveLength(3);
    h.session.hangUp();
  });

  it.each([false, true])(
    "does not acknowledge an interrupted notice when generation ends after speech stopped=%s",
    async (stopped) => {
      const h = playbackHarness();
      const fake = h.sockets[0]!.fake;
      configure(fake);
      h.session.deliverWork("first", output);
      emit(fake, "response.created", "first");
      audio(fake);
      emit(fake, "input_audio_buffer.speech_started");
      if (stopped) emit(fake, "input_audio_buffer.speech_stopped");
      emit(fake, "response.done", "first", "completed");
      if (!stopped) emit(fake, "input_audio_buffer.speech_stopped");
      await flush();
      expect(noticeIds(fake)).toEqual(["seeded-nudge-t3-first", "seeded-nudge-t3-first"]);
      h.session.hangUp();
    },
  );

  it("ignores a late drain after hang-up without starting the queued notice", async () => {
    const h = playbackHarness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    h.session.deliverWork("first", output);
    emit(fake, "response.created", "first");
    audio(fake);
    emit(fake, "response.done", "first", "completed");
    h.session.deliverWork("later", output);
    h.session.hangUp();
    h.player.clear();
    await flush();
    expect(noticeIds(fake)).toEqual(["seeded-nudge-t3-first"]);
    expect(h.ended).toEqual(["hang_up"]);
  });

  it("ignores a late drain after reconnect and retains the notice for the replacement socket", async () => {
    const h = playbackHarness();
    const first = h.sockets[0]!.fake;
    configure(first);
    h.session.deliverWork("first", output);
    emit(first, "response.created", "first");
    audio(first);
    emit(first, "response.done", "first", "completed");
    h.session.dropForReconnect();
    h.sources[0]!.ended();
    await flush();
    const next = h.sockets[1]!.fake;
    emit(next, "session.created");
    emit(next, "session.updated");
    expect(noticeIds(next)).toEqual(["seeded-nudge-t3-first"]);
    h.session.hangUp();
  });
});

describe("credential refresh recovery", () => {
  it.each([
    { _tag: "GrokBotVoiceError", reason: "unavailable" },
    { _tag: "EnvironmentRpcUnavailableError" },
    { _tag: "ConnectionTransientError" },
    { _tag: "RpcClientError", reason: { _tag: "SocketReadError" } },
    { _tag: "RpcClientError", reason: { _tag: "SocketCloseError", code: 1006 } },
    { _tag: "RpcClientError", reason: { _tag: "HttpError", kind: "TransportError" } },
  ])("retries a recoverable refresh failure and delivers retained work once: %j", async (error) => {
    vi.useFakeTimers();
    let refreshes = 0;
    const h = harness({
      refreshCredential: async () => {
        if (++refreshes === 1) throw error;
        return { ...credential, clientSecret: "replacement" };
      },
    });
    try {
      const first = h.sockets[0]!.fake;
      configure(first);
      h.session.deliverWork("retained", '{"status":"landed","title":"Sync icons"}');
      h.session.dropForReconnect();
      await flush();
      expect(h.session.phase).toBe("reconnecting");
      expect(h.ended).toEqual([]);
      expect(refreshes).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(refreshes).toBe(2);
      expect(h.sockets).toHaveLength(2);
      const next = h.sockets[1]!.fake;
      next.listeners.message(ready);
      next.listeners.message(JSON.stringify({ type: "session.updated" }));
      next.listeners.message(JSON.stringify({ type: "response.done" }));
      h.session.deliverWork("retained", '{"status":"landed","title":"Duplicate"}');
      expect(
        next.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.item?.name === "work_landed"),
      ).toHaveLength(1);
      expect(h.ended).toEqual([]);
    } finally {
      h.session.hangUp();
      vi.useRealTimers();
    }
  });

  it.each([
    { _tag: "GrokBotVoiceError", reason: "account_unavailable" },
    { _tag: "GrokBotVoiceError", reason: "unknown_call" },
    { _tag: "ConnectionBlockedError", reason: "authentication" },
    { _tag: "EnvironmentAuthorizationError" },
    { _tag: "RpcClientError", reason: { _tag: "RpcClientDefect" } },
    { _tag: "RpcClientError", reason: { _tag: "HttpError", kind: "StatusCodeError" } },
  ])("ends immediately on authority denial or an unrecoverable refresh: %j", async (error) => {
    vi.useFakeTimers();
    let refreshes = 0;
    const h = harness({
      refreshCredential: async () => {
        refreshes += 1;
        throw error;
      },
    });
    try {
      configure(h.sockets[0]!.fake);
      h.session.dropForReconnect();
      await flush();
      expect(h.ended).toEqual(["error"]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refreshes).toBe(1);
    } finally {
      h.session.hangUp();
      vi.useRealTimers();
    }
  });

  it("bounds repeated transient refresh failures to the reconnect budget and cancels retry on hang-up", async () => {
    vi.useFakeTimers();
    let refreshes = 0;
    const h = harness({
      refreshCredential: async () => {
        refreshes += 1;
        throw { _tag: "GrokBotVoiceError", reason: "unavailable" };
      },
    });
    try {
      configure(h.sockets[0]!.fake);
      h.session.dropForReconnect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refreshes).toBe(3);
      expect(h.ended).toEqual(["error"]);
      const cancelled = harness({
        refreshCredential: async () => {
          refreshes += 1;
          throw { _tag: "EnvironmentRpcUnavailableError" };
        },
      });
      configure(cancelled.sockets[0]!.fake);
      cancelled.session.dropForReconnect();
      await flush();
      cancelled.session.hangUp();
      const before = refreshes;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refreshes).toBe(before);
      expect(cancelled.ended).toEqual(["hang_up"]);
    } finally {
      h.session.hangUp();
      vi.useRealTimers();
    }
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
    expect(event).toMatchObject({ type: "audio.delta", itemId: "i", contentIndex: null });
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
    ).toEqual({
      type: "tool.call",
      callId: "c",
      responseId: null,
      name: "send_task",
      argumentsJson: "{}",
    });
    expect(parseServerEvent("not json")).toBeNull();
  });
});

describe("call session", () => {
  it("dials with the secret subprotocol, configures the session once ready, and goes live", () => {
    const { session, sockets, phases } = harness();
    expect(sockets[0]?.protocols).toEqual(["xai-client-secret.sek"]);
    sockets[0]!.fake.listeners.message(ready);
    expect(JSON.parse(sockets[0]!.fake.sent[0]!).type).toBe("session.update");
    expect(phases).toEqual([]);
    expect(session.phase).toBe("connecting");
    sockets[0]!.fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(phases).toEqual(["live"]);
    expect(session.phase).toBe("live");
  });

  it("drops microphone frames until live and while muted", () => {
    const { session, sockets } = harness();
    const { fake } = sockets[0]!;
    session.sendAudio("early");
    configure(fake);
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
    sockets[0]!.fake.listeners.message(JSON.stringify({ type: "session.updated" }));
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
    expect(session.phase).toBe("reconnecting");
    sockets[1]!.fake.listeners.message(JSON.stringify({ type: "session.updated" }));
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

  function timedHarness(maxReconnects = 2, configurationTimeoutMs = 1000) {
    const c = clock();
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const closes: Array<{ code: number; reason: string }> = [];
    const ended: string[] = [];
    let refreshes = 0;
    const runTool = vi.fn(async () => '{"result":"retained receipt"}');
    const session = createVoiceCallSession({
      credential,
      instructions: "",
      tools: [],
      voice,
      maxReconnects,
      handshakeTimeoutMs: 1000,
      configurationTimeoutMs,
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
        runTool,
      },
      onEvent: () => {},
      onPhase: () => {},
      onEnded: (reason) => void ended.push(reason),
    });
    return { c, session, sockets, closes, ended, runTool, refreshes: () => refreshes };
  }

  it("bounds created-but-unconfigured sessions, ignores late acknowledgements, and spends the reconnect budget", async () => {
    const h = timedHarness(1);
    const first = h.sockets[0]!;
    first.listeners.message(ready);
    h.c.advance(999);
    first.listeners.message(ready); // A duplicate creation cannot extend the deadline.
    expect(h.session.phase).toBe("connecting");
    h.c.advance(1);
    await flush();
    expect(h.closes[0]).toEqual({ code: 4000, reason: "configuration_timeout" });
    first.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(h.session.phase).toBe("reconnecting");
    h.sockets[1]!.listeners.message(ready);
    h.c.advance(1000);
    await flush();
    expect(h.ended).toEqual(["error"]);
    expect(h.c.pending).toBe(0);
  });

  it("does not forgive spent reconnects before configuration is acknowledged", async () => {
    const h = timedHarness(1, 6000);
    h.session.dropForReconnect();
    await flush();
    h.sockets[1]!.listeners.message(ready);
    h.c.advance(5000);
    expect(h.session.phase).toBe("reconnecting");
    h.session.dropForReconnect();
    await flush();
    expect(h.ended).toEqual(["error"]);
    expect(h.c.pending).toBe(0);
  });

  it("recovers a rejected update with queued chat, completion, and function receipts, without repeating the tool", async () => {
    const h = timedHarness(2);
    const first = h.sockets[0]!;
    configure(first);
    first.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "write",
        name: "write_task",
        arguments: "{}",
      }),
    );
    await flush();
    h.session.dropForReconnect();
    await flush();
    const rejected = h.sockets[1]!;
    h.session.deliverWork("queued", JSON.stringify({ status: "landed", title: "Queued work" }));
    h.session.deliverChat({ id: "chat", text: "Still waiting", atMs: 1 });
    rejected.listeners.message(ready);
    rejected.listeners.message(
      JSON.stringify({ type: "error", error: { message: "Update rejected" } }),
    );
    await flush();
    expect(h.closes.at(-1)).toEqual({ code: 4000, reason: "configuration_rejected" });
    rejected.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(h.session.phase).toBe("reconnecting");
    const recovered = h.sockets[2]!;
    recovered.listeners.message(ready);
    recovered.listeners.message(JSON.stringify({ type: "session.updated" }));
    const frames = () => recovered.sent.map((frame) => JSON.parse(frame));
    expect(h.runTool).toHaveBeenCalledTimes(1);
    expect(frames().filter((frame) => frame.item?.call_id === "write")).toHaveLength(1);
    expect(frames().filter((frame) => frame.type === "async_update.add")).toHaveLength(1);
    expect(frames().some((frame) => frame.item?.type === "force_message")).toBe(false);
    recovered.listeners.message(JSON.stringify({ type: "response.done" }));
    expect(frames().some((frame) => frame.item?.type === "force_message")).toBe(true);
    h.session.hangUp();
  });

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

  it("cancels the configuration deadline only once the session is configured", () => {
    const h = timedHarness();
    h.sockets[0]!.listeners.message(ready);
    h.c.advance(999);
    expect(h.session.phase).toBe("connecting");
    h.sockets[0]!.listeners.message(JSON.stringify({ type: "session.updated" }));
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
      h.sockets[i]!.listeners.message(JSON.stringify({ type: "session.updated" }));
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

describe("interrupted response frames", () => {
  it("drops old audio during speech, after speech stops, and after the next response begins", () => {
    const accepted: string[] = [];
    const h = harness({
      onEvent: (event) => {
        if (event.type === "audio.delta") accepted.push(event.itemId!);
      },
    });
    const fake = h.sockets[0]!.fake;
    configure(fake);
    const emit = (event: unknown) => fake.listeners.message(JSON.stringify(event));
    const audio = (responseId: string, itemId: string) =>
      emit({
        type: "response.output_audio.delta",
        response_id: responseId,
        item_id: itemId,
        content_index: 2,
        delta: "AAAAAA==",
      });
    emit({ type: "response.created", response: { id: "old" } });
    audio("old", "old-item");
    emit({ type: "input_audio_buffer.speech_started" });
    audio("old", "old-item");
    emit({ type: "input_audio_buffer.speech_stopped" });
    audio("old", "late-old-item");
    emit({ type: "response.done", response: { id: "old", status: "cancelled" } });
    audio("old", "old-item");
    emit({ type: "response.created", response: { id: "new" } });
    audio("old", "another-old-item");
    audio("new", "old-item");
    audio("new", "new-item");
    expect(accepted).toEqual(["old-item", "new-item"]);
    h.session.hangUp();
  });

  it("repeats the measured truncation once a generating item ends and ignores duplicate terminals", () => {
    const h = harness();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    const emit = (event: unknown) => fake.listeners.message(JSON.stringify(event));
    emit({ type: "response.created", response: { id: "r" } });
    emit({
      type: "response.output_audio.delta",
      response_id: "r",
      item_id: "a",
      content_index: 1,
      delta: "AAAAAA==",
    });
    emit({ type: "input_audio_buffer.speech_started" });
    h.session.truncateAudio([{ itemId: "a", contentIndex: 1, audioEndMs: 625.4 }]);
    const cuts = () =>
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "conversation.item.truncate");
    expect(cuts()).toEqual([
      { type: "conversation.item.truncate", item_id: "a", content_index: 1, audio_end_ms: 625 },
    ]);
    emit({ type: "conversation.item.truncated", item_id: "a" });
    emit({ type: "response.output_item.done", item: { id: "a" } });
    emit({ type: "response.output_item.done", item: { id: "a" } });
    emit({ type: "response.done", response: { id: "r", status: "cancelled" } });
    expect(cuts()).toHaveLength(2);
    expect(cuts()[1]).toEqual(cuts()[0]);
    h.session.hangUp();
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
    callerRequest(first);
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
      const tool = (id: string, responseId?: string) =>
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: id,
          name: "read",
          ...(responseId === undefined ? {} : { response_id: responseId }),
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
        // A new tool belongs to a fresh server response; the failed response can only replay receipts.
        emit(first, "response.created", "later-tool-response");
        first.listeners.message(tool("later", "later-tool-response"));
        emit(first, "response.done", "later-tool-response", status);
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
