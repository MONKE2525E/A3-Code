import type { VoiceSocket } from "@t3tools/client-runtime/grok-bot-voice/call-session";
import type { GrokBotVoiceStartResult as StartResultSchema } from "@t3tools/contracts";

type StartResult = typeof StartResultSchema.Type;
import { describe, expect, it, vi } from "vite-plus/test";

import { createVoicePlayer, VoiceAudioError, type VoiceAudio } from "./grokBotVoiceAudio";
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
    chatContext: { afterSequence: 42, messages: [] },
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
    whenDrained: () => null,
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

function harness(overrides: Partial<GrokBotVoiceCallPorts> = {}, watchChat = false) {
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
  // Audio/tool tests hold the independent chat read; chat tests drive it explicitly.
  const callPorts: GrokBotVoiceCallPorts = {
    ...ports,
    runTool: (input) =>
      !watchChat && input.name === "t3_chat_updates" ? new Promise(() => {}) : ports.runTool(input),
  };
  const call = createGrokBotVoiceCall({
    botId: "bot-1",
    ports: callPorts,
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
function callerRequest(fake: ReturnType<typeof fakeSocket>, text = "Run the requested task.") {
  fake.listeners.message(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "current-caller",
      transcript: text,
    }),
  );
}
const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

describe("grok bot voice call", () => {
  it("shows a rejected tool's reason and returns it for a spoken explanation", async () => {
    const h = harness({
      runTool: async () => ({
        kind: "invalid_input",
        output: { code: "capability_denied", message: "This call requires approval in T3." },
      }),
    });
    await h.call.start();
    const fake = h.sockets[0]!.fake;
    fake.listeners.message(ready);
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    callerRequest(fake);
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "denied",
        name: "delegate_task",
        arguments: "{}",
      }),
    );
    await flush();
    expect(h.call.state.notice).toContain("requires approval");
    const output = fake.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.item?.call_id === "denied");
    expect(JSON.parse(output.item.output)).toMatchObject({
      code: "capability_denied",
      error: "This call requires approval in T3.",
    });
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(1);
    expect(
      h.sockets[0]!.fake.sent.map((frame) => JSON.parse(frame)).filter(
        (frame) => frame.item?.type === "force_message",
      ),
    ).toHaveLength(1);
    h.call.hangUp();
  });

  it("reports a lost completion watch without claiming the task failed or finished", async () => {
    const h = harness({
      runTool: async (input) =>
        input.name === "delegate_task"
          ? {
              kind: "served",
              output: { taskId: "task" },
              completion: { requestToolCallId: input.toolCallId, pending: true },
            }
          : { kind: "invalid_input", output: { error: "unavailable" } },
    });
    await h.call.start();
    const fake = h.sockets[0]!.fake;
    fake.listeners.message(ready);
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    callerRequest(fake);
    fake.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "task-call",
        name: "delegate_task",
        arguments: "{}",
      }),
    );
    await flush();
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    await flush();
    expect(h.call.state.notice).toContain("status is unknown");
    expect(fake.sent.join("")).toContain("task_watch_failed");
    h.call.hangUp();
  });
  it("queues an immediately completed launch behind its receipt and ignores mismatched completion", async () => {
    type Result = Awaited<ReturnType<GrokBotVoiceCallPorts["runTool"]>>;
    const receipts = [deferred<void>(), deferred<void>()];
    let nextReceipt = 0;
    const fake = fakeSocket();
    const send = fake.socket.send;
    fake.socket.send = (frame) => {
      send(frame);
      const item = JSON.parse(frame).item;
      if (item?.type === "function_call_output" && !item.call_id.startsWith("seeded-"))
        receipts[nextReceipt++]!.resolve();
    };
    const h = harness({
      openSocket: () => fake.socket,
      runTool: (input) =>
        Promise.resolve<Result>(
          input.name === "t3_thread_launch"
            ? {
                kind: "served",
                output: { accepted: true },
                completion: { requestToolCallId: input.toolCallId, pending: true },
              }
            : {
                kind: "served",
                output: { updates: ["Done"] },
                completion: {
                  requestToolCallId:
                    input.input &&
                    typeof input.input === "object" &&
                    "requestToolCallId" in input.input &&
                    input.input.requestToolCallId === "first"
                      ? "first"
                      : "wrong",
                  pending: false,
                },
              },
        ),
    });
    await h.call.start();
    fake.listeners.message(ready);
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    callerRequest(fake);
    for (const [index, id] of ["first", "second"].entries()) {
      fake.listeners.message(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: id,
          name: "t3_thread_launch",
          arguments: "{}",
        }),
      );
      await receipts[index]!.promise;
      expect(
        fake.sent.map((f) => JSON.parse(f)).filter((f) => f.item?.name === "work_landed"),
      ).toHaveLength(index);
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
    }
    expect(
      fake.sent
        .map((f) => JSON.parse(f))
        .filter((f) => f.item?.name === "work_landed")
        .map((f) => f.item.call_id),
    ).toEqual(["seeded-nudge-t3-first"]);
    h.call.hangUp();
  });

  it("watches acceptance during reconnect once and sends receipt before completion after configuration", async () => {
    type Result = Awaited<ReturnType<GrokBotVoiceCallPorts["runTool"]>>;
    const accepted = deferred<Result>();
    const completion = deferred<Result>();
    const watching = deferred<void>();
    const attached = deferred<void>();
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const inputs: Parameters<GrokBotVoiceCallPorts["runTool"]>[0][] = [];
    const h = harness({
      openSocket: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        if (sockets.length === 2) attached.resolve();
        return socket.socket;
      },
      runTool: (input) => {
        inputs.push(input);
        if (input.name === "t3_thread_launch") return accepted.promise;
        watching.resolve();
        return completion.promise;
      },
    });
    await h.call.start();
    const first = sockets[0]!;
    first.listeners.message(ready);
    first.listeners.message(JSON.stringify({ type: "session.updated" }));
    first.listeners.message(JSON.stringify({ type: "response.done" }));
    callerRequest(first);
    const request = JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "launch",
      name: "t3_thread_launch",
      arguments: "{}",
    });
    first.listeners.message(request);
    first.socket.close(4000, "reconnect");
    await attached.promise;
    accepted.resolve({
      kind: "served",
      output: { accepted: true },
      completion: { requestToolCallId: "launch", pending: true },
    });
    await watching.promise;
    completion.resolve({
      kind: "served",
      output: { updates: ["Done"] },
      completion: { requestToolCallId: "launch", pending: false },
    });
    await completion.promise;
    const next = sockets[1]!;
    next.listeners.message(ready);
    next.listeners.message(request);
    expect(next.sent.map((f) => JSON.parse(f).type)).toEqual(["session.update"]);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(next.sent.map((f) => JSON.parse(f))).toEqual([
      expect.objectContaining({ type: "session.update" }),
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "launch", output: '{"accepted":true}' },
      },
      expect.objectContaining({ type: "response.create" }),
    ]);
    next.listeners.message(JSON.stringify({ type: "response.done" }));
    expect(next.sent.slice(-3).map((f) => JSON.parse(f).item?.type ?? JSON.parse(f).type)).toEqual([
      "function_call",
      "function_call_output",
      "response.create",
    ]);
    expect(inputs.map((i) => i.name)).toEqual(["t3_thread_launch", "t3_task_progress"]);
    expect(first.sent.map((f) => JSON.parse(f)).filter((f) => f.item)).toEqual([]);
    h.call.hangUp();
  });

  it("does not watch or deliver late acceptance from an ended call into a new call", async () => {
    const accepted = deferred<Awaited<ReturnType<GrokBotVoiceCallPorts["runTool"]>>>();
    const inputs: Parameters<GrokBotVoiceCallPorts["runTool"]>[0][] = [];
    let starts = 0;
    const h = harness({
      startCall: async () => started(`call-${++starts}`),
      runTool: (input) => {
        inputs.push(input);
        return accepted.promise;
      },
    });
    await h.call.start();
    const first = h.sockets[0]!.fake;
    first.listeners.message(ready);
    first.listeners.message(JSON.stringify({ type: "session.updated" }));
    callerRequest(first);
    first.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "launch",
        name: "t3_thread_launch",
        arguments: "{}",
      }),
    );
    h.call.hangUp();
    await h.call.start();
    const next = h.sockets[1]!.fake;
    next.listeners.message(ready);
    next.listeners.message(JSON.stringify({ type: "session.updated" }));
    accepted.resolve({
      kind: "served",
      output: { accepted: true },
      completion: { requestToolCallId: "launch", pending: true },
    });
    await accepted.promise;
    expect(inputs.map((i) => i.callId)).toEqual(["call-1"]);
    expect(next.sent.map((f) => JSON.parse(f)).filter((f) => f.item)).toEqual([]);
    h.call.hangUp();
  });

  it("configures canonical chat context and forwards new written messages once on the same call", async () => {
    const update = deferred<Awaited<ReturnType<GrokBotVoiceCallPorts["runTool"]>>>();
    const next = deferred<Awaited<ReturnType<GrokBotVoiceCallPorts["runTool"]>>>();
    let waits = 0;
    const inputs: unknown[] = [];
    const h = harness(
      {
        startCall: async () => ({
          ...started(),
          session: {
            ...started().session,
            chatContext: {
              afterSequence: 42,
              messages: [{ id: "old", role: "user", text: "We agreed on Friday." }],
            },
          },
        }),
        runTool: (input) => {
          inputs.push(input);
          return ++waits === 1 ? update.promise : next.promise;
        },
      },
      true,
    );
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    expect(JSON.parse(fake.sent[0]!).session.instructions).toContain("We agreed on Friday.");
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(inputs[0]).toMatchObject({
      callId: "call-1",
      name: "t3_chat_updates",
      input: { afterSequence: 42 },
    });
    update.resolve({
      kind: "served",
      output: null,
      chatContext: {
        afterSequence: 44,
        messages: [{ id: "new", role: "user", text: "Make that Monday." }],
      },
    });
    await flush();
    const written = fake.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "async_update.add");
    expect(written).toEqual([
      {
        type: "async_update.add",
        event_id: "written-turn-new",
        async_update: {
          topic: "user_message",
          payload: [
            {
              message: { type: "text", content: "Make that Monday." },
              timestampMs: expect.any(Number),
            },
          ],
        },
      },
    ]);
    h.call.hangUp();
    const count = fake.sent.length;
    next.resolve({
      kind: "served",
      output: null,
      chatContext: {
        afterSequence: 45,
        messages: [{ id: "late", role: "user", text: "Ended call" }],
      },
    });
    await flush();
    expect(fake.sent).toHaveLength(count);
  });
  it("greets once after configuration, using the native greeting instruction", async () => {
    const h = harness({
      startCall: async () => ({
        ...started(),
        session: {
          ...started().session,
          greeting: { direction: "Greet the caller.", withLandedWork: "Report the work." },
        },
      }),
    });
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toEqual([]);
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toEqual([
      {
        type: "response.create",
        response: { instructions: expect.stringContaining("Greet the caller.") },
      },
    ]);
    h.call.hangUp();
  });

  it("delivers delayed T3 results as work_landed and wakes once after the receipt response", async () => {
    const completion = deferred<Awaited<ReturnType<GrokBotVoiceCallPorts["runTool"]>>>();
    const calls: Parameters<GrokBotVoiceCallPorts["runTool"]>[0][] = [];
    const h = harness({
      runTool: async (input) => {
        calls.push(input);
        return input.name === "t3_thread_launch"
          ? {
              kind: "served",
              output: { spoken: "Started in T3." },
              completion: { requestToolCallId: input.toolCallId, pending: true },
            }
          : completion.promise;
      },
    });
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    callerRequest(fake);
    fake.sent.splice(1);
    const request = JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "task-1",
      name: "t3_thread_launch",
      arguments: '{"task":"fix it"}',
    });
    fake.listeners.message(request);
    fake.listeners.message(request);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      callId: "call-1",
      name: "t3_task_progress",
      input: { requestToolCallId: "task-1" },
    });
    completion.resolve({
      kind: "served",
      output: { status: "landed", updates: ["The build is fixed."] },
      completion: { requestToolCallId: "task-1", pending: false },
    });
    await flush();
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.item?.name === "work_landed"),
    ).toHaveLength(0);
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    const frames = fake.sent.map((frame) => JSON.parse(frame));
    expect(frames.slice(-3)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call",
          name: "work_landed",
          call_id: "seeded-nudge-t3-task-1",
          arguments: "{}",
        },
      },
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "seeded-nudge-t3-task-1",
          output: '{"status":"landed","updates":["The build is fixed."]}',
        },
      },
      expect.objectContaining({
        type: "conversation.item.create",
        item: expect.objectContaining({ type: "force_message" }),
      }),
    ]);
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "response.create"),
    ).toHaveLength(1);
    expect(
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.item?.type === "force_message"),
    ).toHaveLength(1);
    expect(calls).toHaveLength(2);
    h.call.hangUp();
  });

  it("drops an ended call's delayed completion even when a new call is live", async () => {
    const completion = deferred<Awaited<ReturnType<GrokBotVoiceCallPorts["runTool"]>>>();
    let starts = 0;
    const h = harness({
      startCall: async () => started(`call-${++starts}`),
      runTool: async (input) =>
        input.name === "t3_thread_launch"
          ? {
              kind: "served",
              output: {},
              completion: { requestToolCallId: input.toolCallId, pending: true },
            }
          : completion.promise,
    });
    await h.call.start();
    const old = h.sockets[0]!.fake;
    old.listeners.message(ready);
    old.listeners.message(JSON.stringify({ type: "session.updated" }));
    callerRequest(old);
    old.listeners.message(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "task-1",
        name: "t3_thread_launch",
        arguments: "{}",
      }),
    );
    await flush();
    h.call.hangUp();
    await h.call.start();
    const next = h.sockets[1]!.fake;
    next.listeners.message(ready);
    completion.resolve({
      kind: "served",
      output: { updates: ["Old result"] },
      completion: { requestToolCallId: "task-1", pending: false },
    });
    await flush();
    expect(next.sent.map((frame) => JSON.parse(frame))).toEqual([
      expect.objectContaining({ type: "session.update" }),
    ]);
    h.call.hangUp();
  });
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
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    callerRequest(fake);
    fake.sent.splice(1);
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
      .filter((frame) => frame.item?.type === "function_call_output")
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
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    fake.listeners.message(JSON.stringify({ type: "response.created", response: { id: "old" } }));
    fake.listeners.message(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: "i",
        response_id: "old",
        delta: btoa(String.fromCharCode(0, 0, 0, 0)),
      }),
    );
    expect(h.audio.enqueued).toHaveLength(1);
    fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    expect(h.audio.clears).toBe(1);
    const late = JSON.stringify({
      type: "response.output_audio.delta",
      item_id: "i",
      response_id: "old",
      delta: "AAAAAA==",
    });
    fake.listeners.message(late);
    fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    fake.listeners.message(late);
    expect(h.audio.enqueued).toHaveLength(1);
    fake.listeners.message(
      JSON.stringify({ type: "response.done", response: { id: "old", status: "cancelled" } }),
    );
    fake.listeners.message(JSON.stringify({ type: "response.created", response: { id: "new" } }));
    fake.listeners.message(late);
    fake.listeners.message(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: "new-item",
        response_id: "new",
        delta: "AAAAAA==",
      }),
    );
    expect(h.audio.enqueued).toHaveLength(2);
    h.call.hangUp();
  });

  it("sends the player's actual heard position and content identity on interruption", async () => {
    const context = {
      currentTime: 0,
      destination: {},
      createBuffer: (_channels: number, length: number, rate: number) => ({
        duration: length / rate,
        copyToChannel() {},
      }),
      createBufferSource: () => ({ connect() {}, start() {}, stop() {}, addEventListener() {} }),
    };
    const player = createVoicePlayer(context as unknown as AudioContext);
    const h = harness({
      openAudio: async () => ({
        ...player,
        close: () => {
          player.clear();
        },
      }),
    });
    await h.call.start();
    const fake = h.sockets[0]!.fake;
    const emit = (event: unknown) => fake.listeners.message(JSON.stringify(event));
    emit({ type: "session.created" });
    emit({ type: "session.updated" });
    emit({ type: "response.created", response: { id: "r" } });
    const delta = btoa(String.fromCharCode(...new Uint8Array(24_000)));
    for (let i = 0; i < 3; i += 1)
      emit({
        type: "response.output_audio.delta",
        item_id: "a",
        response_id: "r",
        content_index: 2,
        delta,
      });
    context.currentTime = 0.625;
    emit({ type: "input_audio_buffer.speech_started" });
    const cuts = () =>
      fake.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "conversation.item.truncate");
    expect(cuts()).toEqual([
      { type: "conversation.item.truncate", item_id: "a", content_index: 2, audio_end_ms: 625 },
    ]);
    emit({ type: "response.output_item.done", item: { id: "a" } });
    expect(cuts()).toHaveLength(2);
    expect(cuts()[1]).toEqual(cuts()[0]);
    h.call.hangUp();
  });

  it("upserts cumulative user corrections and authoritative final assistant transcripts once per item", async () => {
    const h = harness();
    await h.call.start();
    const fake = h.sockets[0]!.fake;
    const emit = (event: unknown) => fake.listeners.message(JSON.stringify(event));
    emit({ type: "session.created" });
    emit({ type: "session.updated" });
    for (const transcript of ["Send a tax", "Send a task"])
      emit({
        type: "conversation.item.input_audio_transcription.updated",
        item_id: "u",
        transcript,
      });
    emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u",
      transcript: "Send a task.",
    });
    emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u",
      transcript: "Send a task.",
    });
    emit({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "u",
      transcript: "Stale update",
    });
    emit({ type: "response.created", response: { id: "r1" } });
    emit({
      type: "response.output_audio_transcript.delta",
      item_id: "a",
      response_id: "r1",
      delta: "Sendng",
    });
    emit({
      type: "response.output_audio_transcript.done",
      item_id: "a",
      response_id: "r1",
      transcript: "Sending it now.",
    });
    emit({
      type: "response.output_audio_transcript.done",
      item_id: "a",
      response_id: "r1",
      transcript: "Late duplicate",
    });
    emit({ type: "response.done", response: { id: "r1", status: "completed" } });
    emit({ type: "response.created", response: { id: "r2" } });
    emit({
      type: "response.audio_transcript.done",
      item_id: "b",
      response_id: "r2",
      transcript: "Final-only reply.",
    });
    emit({ type: "response.done", response: { id: "r2", status: "completed" } });
    emit({
      type: "response.audio_transcript.done",
      item_id: "b",
      response_id: "r2",
      transcript: "Must stay closed",
    });
    h.call.hangUp();
    expect(h.endInputs[0]?.turns?.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "u", text: "Send a task." },
      { id: "a", text: "Sending it now." },
      { id: "b", text: "Final-only reply." },
    ]);
  });

  it("keeps an interrupted assistant item closed to late final text while recording the next reply", async () => {
    const h = harness();
    await h.call.start();
    const fake = h.sockets[0]!.fake;
    const emit = (event: unknown) => fake.listeners.message(JSON.stringify(event));
    emit({ type: "session.created" });
    emit({ type: "session.updated" });
    emit({ type: "response.created", response: { id: "r1" } });
    emit({
      type: "response.output_audio_transcript.delta",
      item_id: "a",
      response_id: "r1",
      delta: "I can ",
    });
    emit({ type: "response.created", response: { id: "r1" } });
    emit({ type: "input_audio_buffer.speech_started" });
    emit({ type: "input_audio_buffer.speech_stopped" });
    emit({
      type: "response.output_audio_transcript.done",
      item_id: "a",
      response_id: "r1",
      transcript: "I can continue with unheard text.",
    });
    emit({ type: "response.done", response: { id: "r1", status: "cancelled" } });
    emit({ type: "response.created", response: { id: "r2" } });
    emit({
      type: "response.output_audio_transcript.done",
      item_id: "a",
      transcript: "Late ID-less response",
    });
    emit({
      type: "conversation.item.added",
      item: {
        id: "b",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "New reply" }],
      },
    });
    emit({
      type: "response.output_audio_transcript.done",
      item_id: "b",
      response_id: "r2",
      transcript: "New reply corrected.",
    });
    h.call.hangUp();
    expect(h.endInputs[0]?.turns?.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "a", text: "I can " },
      { id: "b", text: "New reply corrected." },
    ]);
  });

  it("drops muted microphone frames while playing received bot audio", async () => {
    const h = harness();
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    h.sendFrame(new Float32Array(480));
    h.call.setMuted(true);
    expect(h.last()?.muted).toBe(true);
    h.sendFrame(new Float32Array(480));
    const appended = fake.sent.filter((frame) => frame.includes("input_audio_buffer.append"));
    expect(appended).toHaveLength(1);
    fake.listeners.message(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: "muted-audio",
        delta: btoa(String.fromCharCode(0, 0, 0, 0)),
      }),
    );
    expect(h.audio.enqueued).toHaveLength(1);
  });

  it("hands the server the transcript once when a connected call ends, however it ends", async () => {
    const h = harness();
    await h.call.start();
    const { fake } = h.sockets[0]!;
    fake.listeners.message(ready);
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
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
    expect(h.connectedCalls).toEqual([]);
    h.sockets[0]!.fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    h.sockets[0]!.fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    await flush();
    expect(h.connectedCalls).toEqual(["call-1"]);
  });

  it("labels a remote close as disconnected and never records a call that did not connect", async () => {
    const remote = harness();
    await remote.call.start();
    remote.sockets[0]!.fake.listeners.message(ready);
    remote.sockets[0]!.fake.listeners.message(JSON.stringify({ type: "session.updated" }));
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
    expect(
      JSON.parse(
        toolOutput({
          kind: "invalid_input",
          output: {
            tool: "orchestrator_capabilities",
            code: "provider_not_ready",
            error: "Check GrokBot in Settings, then try again.",
            privateDetail: "discard this",
          },
        }),
      ),
    ).toEqual({
      tool: "orchestrator_capabilities",
      code: "provider_not_ready",
      error: "Check GrokBot in Settings, then try again.",
    });
  });

  it("maps unknown failures to a generic message instead of the raw error", () => {
    expect(startFailureMessage(new Error("wss://api.x.ai/secret"))).toBe(
      "The voice call could not be started. Try again.",
    );
  });
});

describe("voice environment authority and subscription recovery", () => {
  it.each(["drain", "barge-in"])(
    "waits for local playback before announcing work and preserves interruption on %s",
    async (ending) => {
      const drain = deferred<void>();
      const terminal = deferred<Result>();
      let playing = false;
      let drainReads = 0;
      let writes = 0;
      const h = harness({
        runTool: async (input) => {
          if (input.name === "t3_task_progress") return terminal.promise;
          writes++;
          return launched;
        },
      });
      h.audio.whenDrained = () => {
        if (!playing) return null;
        drainReads++;
        return drain.promise;
      };
      const clear = h.audio.clear;
      h.audio.clear = () => {
        clear();
        playing = false;
        drain.resolve();
      };
      try {
        await h.call.start();
        const fake = h.sockets[0]!.fake;
        configure(fake);
        fake.listeners.message(launch);
        await flush();
        playing = true;
        fake.listeners.message(
          JSON.stringify({ type: "response.created", response: { id: "receipt" } }),
        );
        fake.listeners.message(
          JSON.stringify({
            type: "response.output_audio.delta",
            item_id: "spoken-receipt",
            delta: "AAAAAA==",
          }),
        );
        fake.listeners.message(
          JSON.stringify({
            type: "response.done",
            response: { id: "receipt", status: "completed" },
          }),
        );
        terminal.resolve(completed);
        await flush();
        const outputs = () =>
          fake.sent
            .map((frame) => JSON.parse(frame))
            .filter((frame) => frame.item?.name === "work_landed");
        expect(drainReads).toBe(1);
        expect(outputs()).toHaveLength(0);
        expect(h.audio.enqueued).toHaveLength(1);
        if (ending === "barge-in") {
          fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
          await flush();
          expect(h.audio.clears).toBe(1);
          expect(outputs()).toHaveLength(0);
          fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
          fake.listeners.message(
            JSON.stringify({ type: "response.created", response: { id: "resumed-receipt" } }),
          );
          fake.listeners.message(
            JSON.stringify({
              type: "response.done",
              response: { id: "resumed-receipt", status: "completed" },
            }),
          );
        } else {
          playing = false;
          drain.resolve();
        }
        await flush();
        expect(outputs()).toHaveLength(1);
        expect(writes).toBe(1);
      } finally {
        h.call.hangUp();
      }
    },
  );

  it.each(["retryable result", "transport error"])(
    "retries a written-chat %s on live sockets and delivers one message with its attachment from the saved cursor",
    async (failure) => {
      vi.useFakeTimers();
      const initial = deferred<Result>();
      const resumed = deferred<Result>();
      const keep = deferred<Result>();
      const cursors: unknown[] = [];
      let recover = () => {};
      let writes = 0;
      const h = harness(
        {
          startCall: startWithChat,
          subscribeEnvironmentRecovery: (listener) => {
            recover = listener;
            return () => {};
          },
          runTool: async (input) => {
            if (input.name === "t3_chat_updates") {
              cursors.push(input.input);
              if (cursors.length === 1) return initial.promise;
              if (cursors.length === 2) {
                if (failure === "transport error") throw transportError;
                return {
                  kind: "invalid_input",
                  output: { error: "Chat read unavailable", retryable: true },
                };
              }
              return cursors.length === 3 ? resumed.promise : keep.promise;
            }
            if (input.name === "t3_task_progress") return completed;
            writes++;
            return launched;
          },
        },
        true,
      );
      try {
        await h.call.start();
        const fake = h.sockets[0]!.fake;
        configure(fake);
        fake.listeners.message(launch);
        await flush();
        initial.resolve(chat(44));
        await flush();
        expect(h.call.state.notice).toContain("Written chat updates are temporarily unavailable");
        await vi.advanceTimersByTimeAsync(499);
        expect(cursors).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(cursors).toEqual([
          { afterSequence: 42 },
          { afterSequence: 44 },
          { afterSequence: 44 },
        ]);
        recover();
        recover();
        await vi.advanceTimersByTimeAsync(8_000);
        expect(cursors).toHaveLength(3);
        resumed.resolve({
          kind: "served",
          output: null,
          chatContext: {
            afterSequence: 47,
            messages: [
              {
                id: "new-message",
                role: "user",
                text: "Inspect this screenshot.",
                attachments: [{ id: "screen", name: "screen.png", type: "image" }],
              },
            ],
          },
        });
        await flush();
        fake.listeners.message(JSON.stringify({ type: "response.done" }));
        const messages = fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "async_update.add");
        expect(messages).toHaveLength(1);
        expect(messages[0].async_update.payload[0].message.content).toContain(
          "Inspect this screenshot.",
        );
        expect(messages[0].async_update.payload[0].message.content).toContain('"id":"screen"');
        expect(cursors.at(-1)).toEqual({ afterSequence: 47 });
        expect(h.call.state.notice).toBeNull();
        expect(h.call.state.phase).toBe("live");
        expect(h.sockets).toHaveLength(1);
        expect(fake.socket.isOpen).toBe(true);
        expect(writes).toBe(1);
      } finally {
        h.call.hangUp();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );

  it.each(["recover", "hang up"])(
    "retries absent chat context without replaying historical schedule/delete requests and cleans up on %s",
    async (ending) => {
      vi.useFakeTimers();
      const initialization = deferred<Result>();
      const update = deferred<Result>();
      const keep = deferred<Result>();
      const inputs: unknown[] = [];
      let writes = 0;
      const h = harness(
        {
          startCall: async () => {
            const result = started();
            return {
              ...result,
              session: {
                instructions: result.session.instructions,
                tools: result.session.tools,
                greeting: result.session.greeting,
                hasOverheard: result.session.hasOverheard,
              },
            };
          },
          runTool: async (input) => {
            if (input.name !== "t3_chat_updates") {
              writes++;
              return { kind: "served", output: null };
            }
            inputs.push(input.input);
            if (inputs.length === 1)
              return {
                kind: "invalid_input",
                output: { error: "Context unavailable", retryable: true },
              };
            if (inputs.length === 2) return initialization.promise;
            return inputs.length === 3 ? update.promise : keep.promise;
          },
        },
        true,
      );
      try {
        await h.call.start();
        configure(h.sockets[0]!.fake, false);
        await flush();
        expect(h.call.state.notice).toContain("Written chat context is unavailable");
        expect(inputs).toEqual([{}]);
        if (ending === "hang up") {
          h.call.hangUp();
          await vi.advanceTimersByTimeAsync(16_000);
          expect(inputs).toEqual([{}]);
          expect(writes).toBe(0);
          return;
        }
        await vi.advanceTimersByTimeAsync(500);
        expect(inputs).toEqual([{}, {}]);
        initialization.resolve({
          kind: "served",
          output: null,
          chatContext: {
            afterSequence: 42,
            messages: [
              {
                id: "old-schedule",
                role: "user",
                text: "Create a webhook schedule that runs Cursor.",
              },
              { id: "old-delete", role: "user", text: "Delete the existing scheduled tasks." },
            ],
          },
        });
        await flush();
        expect(inputs).toEqual([{}, {}, { afterSequence: 42 }]);
        expect(h.call.state.notice).toBeNull();
        const fake = h.sockets[0]!.fake;
        expect(
          fake.sent
            .map((frame) => JSON.parse(frame))
            .filter((frame) => frame.type === "async_update.add"),
        ).toEqual([]);
        expect(writes).toBe(0);
        update.resolve({
          kind: "served",
          output: null,
          chatContext: {
            afterSequence: 44,
            messages: [{ id: "new", role: "user", text: "Now connected" }],
          },
        });
        await flush();
        const updates = fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "async_update.add");
        expect(updates).toHaveLength(1);
        expect(updates[0].async_update).toMatchObject({
          topic: "user_message",
          payload: [{ message: { content: "Now connected" } }],
        });
        expect(inputs.at(-1)).toEqual({ afterSequence: 44 });
        expect(writes).toBe(0);
        h.call.hangUp();
        const frames = fake.sent.length;
        keep.resolve(chat(45));
        await flush();
        expect(fake.sent).toHaveLength(frames);
        expect(inputs).toHaveLength(4);
      } finally {
        h.call.hangUp();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );

  it.each(["recover", "hang up"])(
    "keeps read-only work retries alive beyond six transient failures until %s and executes the action once",
    async (ending) => {
      vi.useFakeTimers();
      const terminal = deferred<Result>();
      let waits = 0;
      let writes = 0;
      const h = harness({
        runTool: async (input) => {
          if (input.name !== "t3_task_progress") {
            writes++;
            return launched;
          }
          if (++waits <= 6)
            return {
              kind: "invalid_input",
              output: { error: "Read unavailable", retryable: true },
            };
          if (waits === 7) return { ...launched, output: null };
          return terminal.promise;
        },
      });
      try {
        await h.call.start();
        const fake = h.sockets[0]!.fake;
        configure(fake);
        fake.listeners.message(launch);
        await flush();
        // Acknowledge the action receipt and the first read-error notice while reads retry.
        fake.listeners.message(JSON.stringify({ type: "response.done" }));
        fake.listeners.message(JSON.stringify({ type: "response.done" }));
        for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
          const before = waits;
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(waits).toBe(before);
          await vi.advanceTimersByTimeAsync(1);
          expect(waits).toBe(before + 1);
        }
        expect(waits).toBe(6);
        expect(writes).toBe(1);
        if (ending === "hang up") {
          h.call.hangUp();
          await vi.advanceTimersByTimeAsync(16_000);
          expect(waits).toBe(6);
          expect(writes).toBe(1);
          return;
        }
        await vi.advanceTimersByTimeAsync(7_999);
        expect(waits).toBe(6);
        await vi.advanceTimersByTimeAsync(1);
        expect(waits).toBe(8);
        terminal.resolve(completed);
        await flush();
        fake.listeners.message(JSON.stringify({ type: "response.done" }));
        fake.listeners.message(JSON.stringify({ type: "response.done" }));
        const outputs = fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.item?.type === "function_call_output");
        expect(
          outputs.filter((frame) => frame.item.output.includes("old-account result")),
        ).toHaveLength(1);
        expect(h.call.state.notice).toBeNull();
        expect(h.call.state.phase).toBe("live");
        expect(fake.socket.isOpen).toBe(true);
        expect(h.sockets).toHaveLength(1);
        expect(writes).toBe(1);
      } finally {
        h.call.hangUp();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );

  it.each(["approval_required", "input_required"] as const)(
    "announces %s once and still announces the later completion",
    async (status) => {
      const terminal = deferred<Result>();
      const inputs: Parameters<GrokBotVoiceCallPorts["runTool"]>[0][] = [];
      let waits = 0;
      const h = harness({
        runTool: async (input) => {
          inputs.push(input);
          if (input.name !== "t3_task_progress") return launched;
          if (++waits === 1)
            return {
              kind: "served",
              output: {
                status,
                title: "Read project metadata",
                taskId: "child-task",
                ...(status === "approval_required"
                  ? { approvals: [{ requestId: "approval-1", title: "Look for project files" }] }
                  : {
                      questions: [
                        { requestId: "approval-1", questions: [{ question: "May I continue?" }] },
                      ],
                    }),
              },
              completion: { requestToolCallId: "launch", pending: true },
            };
          return terminal.promise;
        },
      });
      await h.call.start();
      const fake = h.sockets[0]!.fake;
      configure(fake);
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
      fake.listeners.message(launch);
      await flush();
      expect(
        inputs.filter((input) => input.name === "t3_task_progress").map((input) => input.input),
      ).toEqual([
        { requestToolCallId: "launch", seenApprovalIds: [] },
        { requestToolCallId: "launch", seenApprovalIds: ["approval-1"] },
      ]);
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
      const notifications = () =>
        fake.sent
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.item?.type === "force_message");
      expect(notifications()).toHaveLength(1);
      expect(notifications()[0].item.content[0].text).toContain(
        status === "approval_required"
          ? "needs your approval: Look for project files"
          : "needs your answer: May I continue?",
      );
      terminal.resolve({
        ...completed,
        output: { status: "landed", title: "Read project metadata", runStatus: "completed" },
      });
      await flush();
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
      expect(notifications()).toHaveLength(2);
      expect(notifications()[1].item.content[0].text).toContain("finished");
      expect(inputs.some((input) => input.name === "t3_respond_call_approval")).toBe(false);
      expect(inputs.some((input) => input.name === "t3_pending_request_respond")).toBe(false);
      h.call.hangUp();
    },
  );
  it("recovers a transient result read while the audio socket stays connected", async () => {
    vi.useFakeTimers();
    let waits = 0;
    let launches = 0;
    const h = harness({
      runTool: async (input) => {
        if (input.name === "t3_task_progress") {
          if (++waits === 1) throw { _tag: "GrokBotVoiceError", reason: "unavailable" };
          return completed;
        }
        launches++;
        return launched;
      },
    });
    try {
      await h.call.start();
      const fake = h.sockets[0]!.fake;
      configure(fake);
      fake.listeners.message(launch);
      await flush();
      expect(waits).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      await flush();
      expect(waits).toBe(2);
      expect(launches).toBe(1);
      expect(h.sockets).toHaveLength(1);
      expect(h.call.state.phase).toBe("live");
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
      expect(
        fake.sent.map((f) => JSON.parse(f)).filter((f) => f.item?.name === "work_landed"),
      ).toHaveLength(2);
    } finally {
      h.call.hangUp();
      vi.useRealTimers();
    }
  });
  type Result = Awaited<ReturnType<GrokBotVoiceCallPorts["runTool"]>>;
  const chat = (sequence = 42): Result => ({
    kind: "served",
    output: null,
    chatContext: { afterSequence: sequence, messages: [] },
  });
  const launched: Result = {
    kind: "served",
    output: { accepted: true },
    completion: { requestToolCallId: "launch", pending: true },
  };
  const completed: Result = {
    kind: "served",
    output: { updates: ["old-account result"] },
    completion: { requestToolCallId: "launch", pending: false },
  };
  const launch = JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "launch",
    name: "delegate_task",
    arguments: "{}",
  });
  const configure = (fake: ReturnType<typeof fakeSocket>, currentCaller = true) => {
    fake.listeners.message(ready);
    fake.listeners.message(JSON.stringify({ type: "session.updated" }));
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    // Authorized-tool fixtures include current caller input; startup/reconnect tests opt out.
    if (currentCaller) callerRequest(fake);
  };
  const startWithChat = async () => ({
    ...started(),
    session: { ...started().session, chatContext: { afterSequence: 42, messages: [] } },
  });
  const transportError = {
    _tag: "RpcClientError",
    reason: { _tag: "SocketCloseError", code: 1006 },
  };

  it.each(["caller speaking", "active response"])(
    "ends the exact denied call and clears work/audio buffered behind %s",
    async (buffer) => {
      const update = deferred<Result>();
      const work = deferred<Result>();
      let recover = () => {};
      let workWaits = 0;
      const h = harness(
        {
          startCall: startWithChat,
          subscribeEnvironmentRecovery: (listener) => {
            recover = listener;
            return () => {};
          },
          runTool: (input) => {
            if (input.name === "t3_chat_updates") return update.promise;
            if (input.name === "t3_task_progress") {
              workWaits += 1;
              return work.promise;
            }
            return Promise.resolve(launched);
          },
        },
        true,
      );
      await h.call.start();
      const fake = h.sockets[0]!.fake;
      configure(fake);
      fake.listeners.message(launch);
      await flush();
      if (buffer === "caller speaking") {
        fake.listeners.message(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
        fake.listeners.message(JSON.stringify({ type: "response.done" }));
      }
      work.resolve(completed);
      await flush();
      expect(
        fake.sent.map((f) => JSON.parse(f)).filter((f) => f.item?.name === "work_landed"),
      ).toHaveLength(0);
      update.reject({ _tag: "GrokBotVoiceError", reason: "account_unavailable" });
      await flush();
      const before = fake.sent.length;
      h.call.setMuted(false);
      fake.listeners.message(JSON.stringify({ type: "response.done" }));
      h.sendFrame(new Float32Array([1]));
      recover();
      await flush();
      expect(h.call.state.phase).toBe("idle");
      expect(fake.socket.isOpen).toBe(false);
      expect(h.audio.clears).toBe(buffer === "caller speaking" ? 2 : 1);
      expect(h.audio.closes).toBe(1);
      expect(fake.sent).toHaveLength(before);
      expect(workWaits).toBe(1);
      expect(h.endCalls).toEqual(["call-1"]);
    },
  );

  it.each(["account_unavailable", "unknown_call"])(
    "does not retry a progress authority denial: %s",
    async (reason) => {
      const work = deferred<Result>();
      let recover = () => {};
      let waits = 0;
      const h = harness({
        subscribeEnvironmentRecovery: (listener) => {
          recover = listener;
          return () => {};
        },
        runTool: (input) => {
          if (input.name === "t3_task_progress") {
            waits += 1;
            return work.promise;
          }
          return Promise.resolve(launched);
        },
      });
      await h.call.start();
      configure(h.sockets[0]!.fake);
      h.sockets[0]!.fake.listeners.message(launch);
      await flush();
      work.reject({ _tag: "GrokBotVoiceError", reason });
      await flush();
      recover();
      await flush();
      expect(h.call.state.phase).toBe("idle");
      expect(waits).toBe(1);
      expect(h.audio.closes).toBe(1);
    },
  );

  it("retains failed progress/chat watches and resumes each once on environment recovery with the saved cursor", async () => {
    const firstWork = deferred<Result>();
    const nextWork = deferred<Result>();
    const firstChat = deferred<Result>();
    const nextChat = deferred<Result>();
    const keepChat = deferred<Result>();
    let recover = () => {};
    let stops = 0;
    const inputs: Parameters<GrokBotVoiceCallPorts["runTool"]>[0][] = [];
    let workWaits = 0;
    let chatWaits = 0;
    const h = harness(
      {
        startCall: startWithChat,
        subscribeEnvironmentRecovery: (listener) => {
          recover = listener;
          return () => {
            stops += 1;
          };
        },
        runTool: (input) => {
          inputs.push(input);
          if (input.name === "t3_chat_updates")
            return ++chatWaits === 1
              ? firstChat.promise
              : chatWaits === 2
                ? nextChat.promise
                : keepChat.promise;
          if (input.name === "t3_task_progress")
            return ++workWaits === 1 ? firstWork.promise : nextWork.promise;
          return Promise.resolve(launched);
        },
      },
      true,
    );
    await h.call.start();
    const fake = h.sockets[0]!.fake;
    configure(fake);
    fake.listeners.message(launch);
    await flush();
    fake.listeners.message(JSON.stringify({ type: "response.done" }));
    firstWork.reject(transportError);
    firstChat.reject(transportError);
    await flush();
    expect([workWaits, chatWaits]).toEqual([1, 1]);
    // A realtime reconnect is independent of the failed T3 environment transport.
    fake.socket.close(4000, "remote");
    await flush();
    const next = h.sockets[1]!.fake;
    configure(next, false);
    expect([workWaits, chatWaits]).toEqual([1, 1]);
    recover();
    recover(); // No duplicate watchers while the resumed RPCs are pending.
    expect([workWaits, chatWaits]).toEqual([2, 2]);
    expect(inputs.filter((i) => i.name === "t3_chat_updates").map((i) => i.input)).toEqual([
      { afterSequence: 42 },
      { afterSequence: 42 },
    ]);
    nextWork.resolve(completed);
    nextChat.resolve({
      ...chat(44),
      chatContext: {
        afterSequence: 44,
        messages: [{ id: "recovered", role: "user", text: "New typed message" }],
      },
    });
    await flush();
    const frames = next.sent.map((f) => JSON.parse(f));
    expect(frames.filter((f) => f.item?.name === "work_landed")).toHaveLength(2);
    expect(frames.filter((f) => f.type === "async_update.add")).toHaveLength(1);
    expect(inputs.findLast((i) => i.name === "t3_chat_updates")?.input).toEqual({
      afterSequence: 44,
    });
    h.call.hangUp();
    recover();
    expect([workWaits, chatWaits, stops]).toEqual([2, 3, 1]);
  });

  it("uses a recovery edge that arrives before the rejected RPC settles, without tight retries", async () => {
    const first = deferred<Result>();
    const second = deferred<Result>();
    let recover = () => {};
    let waits = 0;
    const h = harness({
      subscribeEnvironmentRecovery: (listener) => {
        recover = listener;
        return () => {};
      },
      runTool: (input) =>
        input.name === "t3_task_progress"
          ? ++waits === 1
            ? first.promise
            : second.promise
          : Promise.resolve(launched),
    });
    await h.call.start();
    configure(h.sockets[0]!.fake);
    h.sockets[0]!.fake.listeners.message(launch);
    await flush();
    recover();
    first.reject(transportError);
    await flush();
    expect(waits).toBe(2);
    second.reject(transportError);
    await flush();
    expect(waits).toBe(2);
    h.call.hangUp();
    recover();
    await flush();
    expect(waits).toBe(2);
  });

  it("rejects an old call's authority error after a new call starts and never resumes its watchers", async () => {
    const work = deferred<Result>();
    const callbacks: Array<() => void> = [];
    let starts = 0;
    let waits = 0;
    const h = harness({
      startCall: async () => started("call-" + ++starts),
      subscribeEnvironmentRecovery: (listener) => {
        callbacks.push(listener);
        return () => {};
      },
      runTool: (input) =>
        input.name === "t3_task_progress"
          ? ((waits += 1), work.promise)
          : Promise.resolve(launched),
    });
    await h.call.start();
    configure(h.sockets[0]!.fake);
    h.sockets[0]!.fake.listeners.message(launch);
    await flush();
    h.call.hangUp();
    await h.call.start();
    configure(h.sockets[1]!.fake, false);
    work.reject({ _tag: "GrokBotVoiceError", reason: "unknown_call" });
    callbacks[0]!();
    callbacks[1]!();
    await flush();
    expect(h.call.state.phase).toBe("live");
    expect(h.endCalls).toEqual(["call-1"]);
    expect(waits).toBe(1);
    expect(h.sockets[1]!.fake.sent.filter((f) => JSON.parse(f).item)).toHaveLength(0);
    h.call.hangUp();
  });
});
