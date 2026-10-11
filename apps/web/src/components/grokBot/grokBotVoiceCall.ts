import {
  createVoiceCallSession,
  type VoiceCallEnd,
  type VoiceCallPhase,
  type VoiceSocket,
} from "@t3tools/client-runtime/grok-bot-voice/call-session";
import {
  audioAppendFrame,
  type VoiceRealtimeCredential,
  type VoiceServerEvent,
  type VoiceSettings,
} from "@t3tools/client-runtime/grok-bot-voice/protocol";
import {
  GrokBotVoiceEndInput,
  GrokBotVoiceError,
  GrokBotVoiceStartResult,
  GrokBotVoiceToolInput,
  GrokBotVoiceToolResult,
} from "@t3tools/contracts";

import { VoiceAudioError, type VoiceAudio } from "./grokBotVoiceAudio";

/** The server picks the voice when none is named, the same as the desktop default. */
type VoiceStartResult = typeof GrokBotVoiceStartResult.Type;
type VoiceToolInput = typeof GrokBotVoiceToolInput.Type;
type VoiceToolResult = typeof GrokBotVoiceToolResult.Type;
type VoiceEndInput = typeof GrokBotVoiceEndInput.Type;
type VoiceTurn = NonNullable<VoiceEndInput["turns"]>[number];

const MAX_TURNS = 1_000;
const MAX_TURN_CHARS = 16_000;

const VOICE_SETTINGS: VoiceSettings = { voiceId: null, voiceSpeed: 1, voiceLanguage: null };

export type GrokBotVoicePhase = "idle" | "starting" | "connecting" | "live" | "reconnecting";

/** Only phases, flags, and user-safe messages. Credentials and transcripts never enter state. */
export interface GrokBotVoiceCallState {
  readonly phase: GrokBotVoicePhase;
  readonly muted: boolean;
  readonly notice: string | null;
}

export interface GrokBotVoiceCallPorts {
  readonly startCall: (botId: string) => Promise<VoiceStartResult>;
  readonly refreshCredential: (callId: string) => Promise<VoiceRealtimeCredential>;
  readonly runTool: (input: VoiceToolInput) => Promise<VoiceToolResult>;
  /** Tells the server the realtime session is live; best effort, the server also learns from tool calls. */
  readonly connectedCall: (callId: string) => Promise<unknown>;
  readonly endCall: (input: VoiceEndInput) => Promise<unknown>;
  readonly openAudio: (onFrame: (samples: Float32Array) => void) => Promise<VoiceAudio>;
  readonly openSocket: (url: string, protocols: string[]) => VoiceSocket;
}

interface ActiveCall {
  callId: string | null;
  session: ReturnType<typeof createVoiceCallSession> | null;
  audio: VoiceAudio | null;
  // Turn flags the desktop sends with each tool call so the broker can pace replies.
  theyJustTalked: boolean;
  alreadySpokeThisTurn: boolean;
  // Native records only a call that connected. The transcript lives here until hang-up and is
  // sent once, to the server, to be recorded; it is never stored or logged.
  connected: boolean;
  realtimeConversationId: string | null;
  turns: VoiceTurn[];
  assistantTurns: Map<string, VoiceTurn>;
}

const IDLE: GrokBotVoiceCallState = { phase: "idle", muted: false, notice: null };
const noop = () => undefined;

/**
 * One bot's voice call, from the explicit Start click to hang-up. A call is independent of the
 * thread's orchestration: tools go through the server's broker, and nothing here waits on a turn.
 * `dispose` ends any call and is safe to call repeatedly, so the controller can be reused after
 * an effect cleanup (React StrictMode mounts twice).
 */
export function createGrokBotVoiceCall(options: {
  readonly botId: string;
  readonly ports: GrokBotVoiceCallPorts;
  readonly onState: (state: GrokBotVoiceCallState) => void;
}) {
  const { ports } = options;
  let state: GrokBotVoiceCallState = IDLE;
  let call: ActiveCall | null = null;

  const emit = (next: GrokBotVoiceCallState) => {
    state = next;
    options.onState(next);
  };

  /** Runs once per call: every end path detaches the call first, and the server ignores repeats. */
  const release = (current: ActiveCall, ending: VoiceEndInput["ending"]) => {
    current.audio?.close();
    current.audio = null;
    if (current.callId === null) return;
    const record =
      ending !== undefined && current.connected
        ? {
            ending,
            ...(current.realtimeConversationId === null
              ? {}
              : { realtimeConversationId: current.realtimeConversationId }),
            turns: current.turns.slice(0, MAX_TURNS),
          }
        : {};
    void ports.endCall({ callId: current.callId, ...record }).catch(noop);
  };

  const finishFromSession = (current: ActiveCall, reason: VoiceCallEnd) => {
    // hangUp detaches the call before closing the session, so this only handles remote or fatal ends.
    if (call !== current) return;
    call = null;
    release(
      current,
      reason === "error" ? "failed" : reason === "remote" ? "disconnected" : "hung-up",
    );
    emit({ ...IDLE, notice: endNotice(reason) });
  };

  const runTool = async (
    current: ActiveCall,
    tool: { callId: string; name: string; argumentsJson: string },
  ) => {
    const parsed = parseToolArguments(tool.argumentsJson);
    if (parsed === null) return JSON.stringify({ error: "invalid_input" });
    const callId = current.callId;
    if (callId === null) return JSON.stringify({ error: "unknown_call" });
    const line = {
      theyJustTalked: current.theyJustTalked,
      newsOwed: false,
      receiptOwed: false,
      alreadySpokeThisTurn: current.alreadySpokeThisTurn,
    };
    current.theyJustTalked = false;
    const result = await ports.runTool({
      callId,
      toolCallId: tool.callId,
      name: tool.name,
      input: parsed,
      line,
    });
    return toolOutput(result);
  };

  const handleEvent = (current: ActiveCall, event: VoiceServerEvent) => {
    switch (event.type) {
      case "audio.delta":
        current.alreadySpokeThisTurn = true;
        current.audio?.enqueue(event.samples);
        return;
      case "speech.started":
        // Barge-in: the caller spoke over the bot, so queued speech stops.
        current.theyJustTalked = true;
        current.audio?.clear();
        return;
      case "conversation.created":
        if (event.conversationId !== null) current.realtimeConversationId = event.conversationId;
        return;
      case "transcript.user":
        current.theyJustTalked = true;
        addTurn(current, {
          id: event.itemId ?? `user-${current.turns.length}`,
          speaker: "user",
          text: event.text,
          atMs: Date.now(),
        });
        return;
      case "transcript.assistant.delta": {
        const id = event.itemId ?? `assistant-${current.turns.length}`;
        const open = current.assistantTurns.get(id);
        if (open !== undefined) {
          // Turns are append-only snapshots, so a growing reply replaces its own entry.
          const grown = { ...open, text: (open.text + event.delta).slice(0, MAX_TURN_CHARS) };
          current.assistantTurns.set(id, grown);
          current.turns[current.turns.indexOf(open)] = grown;
          return;
        }
        const turn = addTurn(current, {
          id,
          speaker: "assistant",
          text: event.delta,
          atMs: Date.now(),
        });
        if (turn !== null) current.assistantTurns.set(id, turn);
        return;
      }
      case "response.ended":
        current.alreadySpokeThisTurn = false;
        return;
      default:
        return;
    }
  };

  /** The stored turn, or null once the call has as many turns as the server accepts. */
  const addTurn = (current: ActiveCall, turn: VoiceTurn) => {
    if (current.turns.length >= MAX_TURNS) return null;
    const stored = { ...turn, text: turn.text.slice(0, MAX_TURN_CHARS) };
    current.turns.push(stored);
    return stored;
  };

  const onPhase = (current: ActiveCall, phase: VoiceCallPhase) => {
    if (call !== current || phase === "closed") return;
    if (phase === "live" && !current.connected) {
      current.connected = true;
      if (current.callId !== null) void ports.connectedCall(current.callId).catch(noop);
    }
    emit({ phase, muted: state.muted, notice: null });
  };

  const start = async () => {
    if (call !== null) return;
    const current: ActiveCall = {
      callId: null,
      session: null,
      audio: null,
      theyJustTalked: false,
      alreadySpokeThisTurn: false,
      connected: false,
      realtimeConversationId: null,
      turns: [],
      assistantTurns: new Map(),
    };
    call = current;
    emit({ phase: "starting", muted: false, notice: null });
    try {
      // The microphone is asked for first, so a denied prompt never burns a minted credential.
      const audio = await ports.openAudio((samples) => {
        if (call === current) current.session?.sendAudio(audioAppendFrame(samples));
      });
      if (call !== current) {
        audio.close();
        return;
      }
      current.audio = audio;
      const started = await ports.startCall(options.botId);
      if (call !== current) {
        void ports.endCall({ callId: started.callId }).catch(noop);
        return;
      }
      current.callId = started.callId;
      current.session = createVoiceCallSession({
        credential: started.credential,
        instructions: started.session.instructions,
        tools: started.session.tools,
        voice: VOICE_SETTINGS,
        ports: {
          openSocket: ports.openSocket,
          refreshCredential: () => ports.refreshCredential(started.callId),
          runTool: (tool) => runTool(current, tool),
        },
        onEvent: (event) => {
          if (call === current) handleEvent(current, event);
        },
        onPhase: (phase) => onPhase(current, phase),
        onEnded: (reason) => finishFromSession(current, reason),
      });
      // The session dials in its constructor and reports only later transitions, so this one is ours.
      emit({ phase: "connecting", muted: false, notice: null });
    } catch (error) {
      if (call !== current) return;
      call = null;
      release(current, undefined);
      emit({ ...IDLE, notice: startFailureMessage(error) });
    }
  };

  const hangUp = (notice: string | null) => {
    const current = call;
    if (current === null) return;
    call = null;
    current.session?.hangUp();
    release(current, "hung-up");
    emit({ ...IDLE, notice });
  };

  return {
    get state() {
      return state;
    },
    start,
    hangUp: () => hangUp(null),
    setMuted: (muted: boolean) => {
      const session = call?.session;
      if (!session) return;
      session.setMuted(muted);
      emit({ ...state, muted });
    },
    dispose: () => hangUp(null),
  };
}

function parseToolArguments(argumentsJson: string): unknown | null {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return null;
  }
}

/** A served tool returns its own JSON; anything else is a bounded error the model can speak about. */
export function toolOutput(result: VoiceToolResult): string {
  if (result.kind !== "served") return JSON.stringify({ error: result.kind });
  return JSON.stringify(result.output) ?? "{}";
}

function endNotice(reason: VoiceCallEnd): string | null {
  if (reason === "remote") return "The call ended.";
  if (reason === "error") return "The call dropped and could not reconnect.";
  return null;
}

const AUDIO_FAILURE_MESSAGES: Record<VoiceAudioError["reason"], string> = {
  insecure_context: "Voice calls need a secure connection (HTTPS or localhost).",
  unsupported: "This browser cannot run voice calls.",
  permission_denied: "Microphone access was denied. Allow it for T3 Code and try again.",
  no_microphone: "No microphone was found.",
  failed: "The microphone could not be opened.",
};

/** Maps a failed start to a message. Only contract-owned and audio-owned text reaches the UI. */
export function startFailureMessage(error: unknown): string {
  if (error instanceof VoiceAudioError) return AUDIO_FAILURE_MESSAGES[error.reason];
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "GrokBotVoiceError" &&
    "reason" in error &&
    typeof error.reason === "string"
  ) {
    const reason = error.reason as GrokBotVoiceError["reason"];
    return new GrokBotVoiceError({ reason }).message;
  }
  return "The voice call could not be started. Try again.";
}
