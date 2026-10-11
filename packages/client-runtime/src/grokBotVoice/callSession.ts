// @effect-diagnostics globalTimers:off - Call lifecycle timers run outside an Effect runtime and are injectable.
import {
  functionCallOutputFrame,
  parseServerEvent,
  realtimeProtocols,
  realtimeUrl,
  responseCreateFrame,
  sessionUpdateFrame,
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
  readonly ports: VoiceCallPorts;
  /** Frames are delivered to the audio player / transcript UI; none carries the secret. */
  readonly onEvent: (event: VoiceServerEvent) => void;
  readonly onPhase: (phase: VoiceCallPhase) => void;
  readonly onEnded: (reason: VoiceCallEnd) => void;
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

  const setPhase = (next: VoiceCallPhase) => {
    if (phase === next) return;
    phase = next;
    input.onPhase(next);
  };

  const finish = (reason: VoiceCallEnd) => {
    if (phase === "closed") return;
    generation += 1;
    clearTimers();
    const current = socket;
    socket = null;
    setPhase("closed");
    // A socket still handshaking has `isOpen === false` but holds a connection that must be torn down.
    current?.close(NORMAL, reason);
    input.onEnded(reason);
  };

  const attach = (credential: VoiceRealtimeCredential, reconnecting: boolean) => {
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
      if (mine !== generation) return;
      const event = parseServerEvent(data);
      if (event === null) return;
      if (event.type === "conversation.created" && event.conversationId !== null)
        conversationId = event.conversationId;
      if (event.type === "session.ready") {
        if (phase !== "live") {
          next.send(
            sessionUpdateFrame({
              instructions: input.instructions,
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
        }
      } else if (event.type === "tool.call") {
        void runTool(next, mine, event);
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

  const runTool = async (
    owner: VoiceSocket,
    mine: number,
    call: { callId: string; name: string; argumentsJson: string },
  ) => {
    let output: string;
    try {
      output = await ports.runTool(call);
    } catch {
      output = JSON.stringify({ error: "tool_failed" });
    }
    // A result for a socket that was replaced or hung up must not leak into the new one.
    if (mine !== generation || socket !== owner || !owner.isOpen) return;
    owner.send(functionCallOutputFrame(call.callId, output));
    owner.send(responseCreateFrame(null));
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
