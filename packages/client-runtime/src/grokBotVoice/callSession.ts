// @effect-diagnostics globalTimers:off - Call lifecycle timers run outside an Effect runtime and are injectable.
import {
  functionCallOutputFrame,
  parseServerEvent,
  realtimeProtocols,
  realtimeUrl,
  responseCreateFrame,
  sessionUpdateFrame,
  workLandedFrames,
  writtenChatFrame,
  type VoiceRealtimeCredential,
  type VoiceServerEvent,
  type VoiceSettings,
} from "./protocol.ts";

export interface VoiceSocket {
  send(frame: string): void;
  close(code: number, reason: string): void;
  readonly isOpen: boolean;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (event: { code: number; clean: boolean }) => void): void;
}

export interface VoiceCallPorts {
  readonly openSocket: (url: string, protocols: string[]) => VoiceSocket;
  /** Mints a replacement secret for a reconnect; the original one is single-handshake. */
  readonly refreshCredential: () => Promise<VoiceRealtimeCredential>;
  /** Runs one model tool call through the server broker and returns the JSON output string. */
  readonly runTool: (call: {
    callId: string;
    name: string;
    argumentsJson: string;
  }) => Promise<string>;
}

export type VoiceCallPhase = "connecting" | "live" | "reconnecting" | "closed";
export type VoiceCallEnd = "hang_up" | "remote" | "error";

export interface VoiceCallSessionInput {
  readonly credential: VoiceRealtimeCredential;
  readonly instructions: string;
  readonly tools: ReadonlyArray<unknown>;
  readonly voice: VoiceSettings;
  readonly greeting?: string;
  readonly ports: VoiceCallPorts;
  /** Frames are delivered to the audio player / transcript UI; none carries the secret. */
  readonly onEvent: (event: VoiceServerEvent) => void;
  readonly onPhase: (phase: VoiceCallPhase) => void;
  readonly onEnded: (reason: VoiceCallEnd) => void;
  /** The result is known for this call; delivery may still be queued across reconnects. */
  readonly onToolResult?: (callId: string) => void;
  readonly maxReconnects?: number;
  /** Per-attempt time for a socket to deliver `session.ready` before it counts as a dropped path. */
  readonly handshakeTimeoutMs?: number;
  /** How long a session must stay live before spent reconnects are forgiven. */
  readonly healthyWindowMs?: number;
  /** Injected for virtual-clock tests; defaults to the global timers. */
  readonly timers?: VoiceTimers;
}

export interface VoiceTimers {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTHY_WINDOW_MS = 30_000;
const GOING_AWAY = 4000;
const NORMAL = 1000;
// Each response drains at most eight results; payload and identity retention are call-local.
const MAX_QUEUED_RESULTS = 64;
const MAX_QUEUED_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 16_000;
const MAX_BATCH_RESULTS = 8;
const MAX_BATCH_BYTES = 32 * 1024;
const MAX_RETAINED_IDS = 512;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const remember = (ids: Set<string>, id: string) => {
  ids.add(id);
  if (ids.size > MAX_RETAINED_IDS) ids.delete(ids.values().next().value!);
};
const availableInT3 =
  "Additional results are available in T3. Read them on demand using the T3 tools.";
const boundedOutput = (output: string) =>
  output.length <= MAX_OUTPUT_BYTES && bytes(JSON.stringify(output)) <= MAX_OUTPUT_BYTES
    ? output
    : JSON.stringify({ status: "landed", updates: [availableInT3] });

/**
 * One call's realtime lifecycle: handshake, session setup, tool brokering, mute, hang-up, and
 * reconnect onto the same conversation. Audio capture/playback stay outside; callers feed
 * microphone frames through `sendAudio` and play `audio.delta` events.
 */
export function createVoiceCallSession(input: VoiceCallSessionInput) {
  const { ports } = input;
  const maxReconnects = input.maxReconnects ?? 3;
  const handshakeTimeoutMs = input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const healthyWindowMs = input.healthyWindowMs ?? DEFAULT_HEALTHY_WINDOW_MS;
  const timers: VoiceTimers = input.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let handshakeTimer: unknown = null;
  let healthyTimer: unknown = null;
  const clearTimers = () => {
    if (handshakeTimer !== null) timers.clearTimeout(handshakeTimer);
    if (healthyTimer !== null) timers.clearTimeout(healthyTimer);
    handshakeTimer = null;
    healthyTimer = null;
  };
  let socket: VoiceSocket | null = null;
  let phase: VoiceCallPhase = "connecting";
  let muted = false;
  let conversationId: string | null = null;
  let reconnects = 0;
  let generation = 0;
  // Identifies the one reconnect whose refreshed credential may still be attached.
  let reconnectAttempt = 0;
  let responseInFlight = false;
  // Failed delivery waits for a caller speech cycle or a replacement socket.
  let deliveryPaused = false;

  let callerSpeaking = false;
  let greeted = false;
  let configured = false;
  const work = new Map<string, string>();
  const deliveredWork = new Set<string>();
  const seenTools = new Set<string>();
  const pendingTools = new Set<string>();
  const acknowledgedTools = new Set<string>();
  const toolProgressTimers = new Set<unknown>();
  let toolResultSerial = 0;
  const receipts = new Map<string, string>();
  const sentReceipts = new Set<string>();
  const chat = new Map<string, { text: string; atMs: number }>();
  const seenChat = new Set<string>();
  const endedResponses = new Set<string>();
  let queuedWorkBytes = 0;
  let queuedReceiptBytes = 0;
  let overflowCount = 0;
  let overflowSerial = 0;
  // Keep payloads until a successful response ends, including before response.created.
  let delivery: {
    kind: "receipt" | "work";
    ids: string[];
    overflow: number;
  } | null = null;
  let activeResponseId: string | null = null;
  const flushChat = () => {
    if (!configured || phase !== "live" || !socket?.isOpen) return;
    for (const [id, message] of chat) socket.send(writtenChatFrame({ id, ...message }));
    chat.clear();
  };

  const flushWork = () => {
    if (
      !configured ||
      deliveryPaused ||
      [...pendingTools].some((id) => !acknowledgedTools.has(id)) ||
      receipts.size > 0 ||
      responseInFlight ||
      callerSpeaking ||
      phase !== "live" ||
      !socket?.isOpen ||
      (work.size === 0 && overflowCount === 0)
    )
      return;
    const ids: string[] = [];
    let batchBytes = 0;
    for (const [requestId, output] of work) {
      const frames = workLandedFrames(requestId, output);
      const size = frames.reduce((total, frame) => total + bytes(frame), 0);
      if (ids.length >= MAX_BATCH_RESULTS || batchBytes + size > MAX_BATCH_BYTES) break;
      for (const frame of frames) socket.send(frame);
      ids.push(requestId);
      batchBytes += size;
    }
    const overflow = overflowCount;
    let overflowSent = 0;
    if (overflow > 0 && ids.length < MAX_BATCH_RESULTS) {
      const noticeFrames = workLandedFrames(
        "overflow-" + ++overflowSerial,
        JSON.stringify({
          status: "landed",
          updates: [availableInT3],
          additionalResults: overflow,
        }),
      );
      if (
        batchBytes + noticeFrames.reduce((total, frame) => total + bytes(frame), 0) <=
        MAX_BATCH_BYTES
      ) {
        for (const frame of noticeFrames) socket.send(frame);
        overflowSent = overflow;
      }
    }
    delivery = { kind: "work", ids, overflow: overflowSent };
    responseInFlight = true;
    socket.send(responseCreateFrame(null));
  };

  const flushResponses = () => {
    if (!configured || deliveryPaused || callerSpeaking || phase !== "live" || !socket?.isOpen)
      return;
    // Outputs may arrive during the model's tool-request response. Keep them for its follow-up.
    let count = sentReceipts.size;
    let batchBytes = [...sentReceipts].reduce(
      (total, id) => total + bytes(functionCallOutputFrame(id, receipts.get(id)!)),
      0,
    );
    for (const [callId, output] of receipts) {
      if (sentReceipts.has(callId)) continue;
      const frame = functionCallOutputFrame(callId, output);
      const size = bytes(frame);
      if (count >= MAX_BATCH_RESULTS || batchBytes + size > MAX_BATCH_BYTES) break;
      socket.send(frame);
      sentReceipts.add(callId);
      batchBytes += size;
      count += 1;
    }
    if (responseInFlight || callerSpeaking) return;
    if (!greeted) {
      greeted = true;
      responseInFlight = true;
      socket.send(responseCreateFrame(input.greeting?.trim() || null));
    } else if (sentReceipts.size > 0) {
      delivery = { kind: "receipt", ids: [...sentReceipts], overflow: 0 };
      responseInFlight = true;
      socket.send(responseCreateFrame(null));
    } else flushWork();
  };

  const setPhase = (next: VoiceCallPhase) => {
    if (phase === next) return;
    phase = next;
    input.onPhase(next);
  };

  const finish = (reason: VoiceCallEnd) => {
    if (phase === "closed") return;
    generation += 1;
    work.clear();
    for (const timer of toolProgressTimers) timers.clearTimeout(timer);
    toolProgressTimers.clear();
    receipts.clear();
    chat.clear();
    clearTimers();
    const current = socket;
    socket = null;
    setPhase("closed");
    // A socket still handshaking has `isOpen === false` but holds a connection that must be torn down.
    current?.close(NORMAL, reason);
    input.onEnded(reason);
  };

  const attach = (credential: VoiceRealtimeCredential, reconnecting: boolean) => {
    configured = false;
    deliveryPaused = false;
    responseInFlight = false;
    if (activeResponseId !== null) remember(endedResponses, activeResponseId);
    activeResponseId = null;
    delivery = null;
    sentReceipts.clear();
    const mine = ++generation;
    const next = ports.openSocket(
      realtimeUrl(credential, reconnecting ? conversationId : null),
      realtimeProtocols(credential),
    );
    socket = next;
    clearTimers();
    // A socket that connects but never says `session.ready` is a dead path, not a pending one.
    handshakeTimer = timers.setTimeout(() => {
      handshakeTimer = null;
      if (mine !== generation || phase === "live" || phase === "closed") return;
      generation += 1;
      socket = null;
      next.close(GOING_AWAY, "handshake_timeout");
      recover();
    }, handshakeTimeoutMs);
    next.onMessage((data) => {
      if (mine !== generation || socket !== next) return;
      const event = parseServerEvent(data);
      if (event === null) return;
      if (event.type === "conversation.created" && event.conversationId !== null)
        conversationId = event.conversationId;
      if (event.type === "session.ready") {
        if (phase !== "live") {
          next.send(
            sessionUpdateFrame({
              instructions: `${input.instructions}\nA tool result with status running is an acknowledgement, not completion. Keep answering the caller while it runs. The completed result arrives automatically; do not repeat the operation just to check its status.`,
              tools: input.tools,
              voice: input.voice,
              reconnecting,
            }),
          );
          if (handshakeTimer !== null) timers.clearTimeout(handshakeTimer);
          handshakeTimer = null;
          // The budget is only forgiven after the call stays up, so a flapping path still ends.
          healthyTimer = timers.setTimeout(() => {
            healthyTimer = null;
            if (mine === generation) reconnects = 0;
          }, healthyWindowMs);
          setPhase("live");
          responseInFlight = false;
          callerSpeaking = false;
        }
      } else if (event.type === "session.configured") {
        configured = true;
        flushChat();
        flushResponses();
      } else if (event.type === "tool.call") {
        if (event.callId.length > 512) {
          input.onEvent({
            type: "error",
            message: "Voice tool identity is too long; request the result in T3.",
          });
          return;
        }
        if (
          !seenTools.has(event.callId) &&
          !pendingTools.has(event.callId) &&
          !receipts.has(event.callId)
        ) {
          if (
            pendingTools.size + receipts.size >= MAX_QUEUED_RESULTS ||
            seenTools.size >= MAX_RETAINED_IDS
          ) {
            // Do not execute a tool whose result cannot be retained. Tell the model to retry.
            if (configured && !deliveryPaused && next.isOpen)
              next.send(
                functionCallOutputFrame(
                  event.callId,
                  JSON.stringify({
                    error: "voice_result_capacity",
                    message: "Read existing results in T3 before requesting more work.",
                  }),
                ),
              );
            input.onEvent({
              type: "error",
              message:
                "Voice tool capacity reached. Read results in T3 or start a new call before requesting more work.",
            });
            return;
          }
          // Never evict an executed tool identity: a replay must not re-run a backend action.
          seenTools.add(event.callId);
          pendingTools.add(event.callId);
          void runTool(event);
        }
      } else if (event.type === "response.created") {
        if (event.responseId !== null && endedResponses.has(event.responseId)) return;
        if (activeResponseId !== null && activeResponseId !== event.responseId) return;
        responseInFlight = true;
        activeResponseId = event.responseId;
      } else if (event.type === "response.ended") {
        if (
          event.responseId !== null &&
          (endedResponses.has(event.responseId) || activeResponseId !== event.responseId)
        )
          return;
        if (!responseInFlight) return;
        if (activeResponseId !== null) remember(endedResponses, activeResponseId);
        // An ID-less terminal event cannot acknowledge an identified response. Treat it as
        // interrupted, preserving its delivery, rather than stranding a native cancellation.
        const identified = activeResponseId === null || event.responseId === activeResponseId;
        const completed =
          identified && !event.cancelled && (event.status === null || event.status === "completed");
        if (delivery !== null) {
          if (completed) {
            for (const id of delivery.ids) {
              if (delivery.kind === "work") {
                queuedWorkBytes -= bytes(work.get(id)!);
                work.delete(id);
                remember(deliveredWork, id);
              } else {
                queuedReceiptBytes -= bytes(receipts.get(id)!);
                receipts.delete(id);
                sentReceipts.delete(id);
              }
            }
            overflowCount -= delivery.overflow;
          } else if (delivery.kind === "receipt") sentReceipts.clear();
          delivery = null;
        }
        activeResponseId = null;
        responseInFlight = false;
        if (!completed) {
          deliveryPaused = true;
          if (!event.cancelled && !callerSpeaking)
            input.onEvent({
              type: "error",
              message:
                "Voice response did not complete. Results are saved; speak again or reconnect to retry.",
            });
        }
        flushResponses();
      } else if (event.type === "speech.started") {
        callerSpeaking = true;
      } else if (event.type === "speech.stopped") {
        if (callerSpeaking) deliveryPaused = false;
        callerSpeaking = false;
        flushResponses();
      }
      input.onEvent(event);
    });
    next.onClose(({ code, clean }) => {
      if (mine !== generation || phase === "closed") return;
      socket = null;
      clearTimers();
      // A clean remote close ends the call; an abrupt close or our own reconnect code is a dropped path.
      const recoverable = code === GOING_AWAY || !clean;
      if (!recoverable) return finish("remote");
      recover();
    });
  };

  const recover = () => {
    if (phase === "closed") return;
    configured = false;
    if (reconnects >= maxReconnects) return finish("error");
    reconnects += 1;
    setPhase("reconnecting");
    const attempt = ++reconnectAttempt;
    void ports.refreshCredential().then(
      (credential) => {
        // A hang-up, or a newer reconnect, makes this credential late.
        if (phase !== "reconnecting" || attempt !== reconnectAttempt) return;
        try {
          attach(credential, true);
        } catch {
          // An undialable refreshed endpoint is not worth another attempt.
          finish("error");
        }
      },
      () => {
        if (phase === "reconnecting" && attempt === reconnectAttempt) finish("error");
      },
    );
  };

  const enqueueWork = (requestId: string, output: string) => {
    if (phase === "closed" || deliveredWork.has(requestId) || work.has(requestId)) return;
    if (requestId.length > 512) {
      overflowCount += 1;
      flushWork();
      return;
    }
    output = boundedOutput(output);
    if (work.size >= MAX_QUEUED_RESULTS || queuedWorkBytes + bytes(output) > MAX_QUEUED_BYTES) {
      remember(deliveredWork, requestId);
      overflowCount += 1;
    } else {
      work.set(requestId, output);
      queuedWorkBytes += bytes(output);
    }
    flushWork();
  };

  const runTool = async (call: { callId: string; name: string; argumentsJson: string }) => {
    let acknowledged = false;
    // Complete the realtime function receipt promptly, without cancelling or reissuing its action.
    const progressTimer = timers.setTimeout(() => {
      toolProgressTimers.delete(progressTimer);
      if (phase === "closed") return;
      acknowledged = true;
      acknowledgedTools.add(call.callId);
      const progress = JSON.stringify({
        status: "running",
        tool: call.name,
        message:
          "This operation is still running. Its result will arrive automatically. Keep talking with the caller; do not repeat this operation or claim it has finished.",
      });
      receipts.set(call.callId, progress);
      queuedReceiptBytes += bytes(progress);
      flushResponses();
    }, 1000);
    toolProgressTimers.add(progressTimer);
    let output: string;
    try {
      output = await ports.runTool(call);
    } catch {
      output = JSON.stringify({ error: "tool_failed" });
    }
    timers.clearTimeout(progressTimer);
    toolProgressTimers.delete(progressTimer);
    // Socket generations share the call's tool identity; only ending the call invalidates it.
    if (phase === "closed") return;
    output = boundedOutput(output);
    // Reserve space for every admitted tool, even when all 64 receipts finish together.
    if (bytes(JSON.stringify(output)) > 4096)
      output = JSON.stringify({ status: "landed", updates: [availableInT3] });
    if (queuedReceiptBytes + bytes(output) > MAX_QUEUED_BYTES) {
      output = JSON.stringify({ status: "landed", updates: [availableInT3] });
    }
    pendingTools.delete(call.callId);
    acknowledgedTools.delete(call.callId);
    input.onToolResult?.(call.callId);
    if (acknowledged) {
      enqueueWork(
        `tool-result-${++toolResultSerial}`,
        JSON.stringify({
          tool: call.name,
          toolCallId: call.callId,
          output,
        }),
      );
      return;
    }
    receipts.set(call.callId, output);
    queuedReceiptBytes += bytes(output);
    flushResponses();
  };

  attach(input.credential, false);

  return {
    get phase() {
      return phase;
    },
    get muted() {
      return muted;
    },
    setMuted: (value: boolean) => {
      muted = value;
      if (!value) flushWork();
    },
    /** Completion belongs to this call, and may wait through a response or reconnect. */
    deliverWork: enqueueWork,
    deliverChat: (message: {
      readonly id: string;
      readonly text: string;
      readonly atMs: number;
    }) => {
      if (phase === "closed" || seenChat.has(message.id)) return;
      if (message.id.length > 512) return;
      remember(seenChat, message.id);
      chat.set(message.id, { text: message.text.slice(0, 2000), atMs: message.atMs });
      let chatBytes = [...chat.values()].reduce((total, item) => total + bytes(item.text), 0);
      while (chat.size > MAX_QUEUED_RESULTS || chatBytes > MAX_QUEUED_BYTES) {
        const oldest = chat.entries().next().value!;
        chatBytes -= bytes(oldest[1].text);
        chat.delete(oldest[0]);
      }
      flushChat();
    },
    /** Muted or not-yet-live microphone frames are dropped, matching the desktop client. */
    sendAudio: (frame: string) => {
      if (muted || phase !== "live" || socket === null || !socket.isOpen) return;
      socket.send(frame);
    },
    hangUp: () => finish("hang_up"),
    /** Test and recovery hook: drop the socket as if the path failed. */
    dropForReconnect: () => {
      const current = socket;
      if (current === null || phase === "closed") return;
      current.close(GOING_AWAY, "remote");
    },
  };
}
