import {
  GROK_BOT_VOICE_REALTIME_ORIGIN,
  GrokBotVoiceError,
  type GrokBotVoiceCredential,
  type GrokBotVoiceEndInput,
  type GrokBotVoiceSession,
  type GrokBotVoiceToolInput,
  type GrokBotVoiceToolResult,
} from "@t3tools/contracts/grokBotVoice";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no UUID generator; the call id must be unguessable.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Bridge from "../voiceRouting/GrokBotVoiceT3Bridge.ts";

/** Longest a call stays registered; real calls are minutes, this only bounds leaked entries. */
const CALL_MAX_AGE_MS = 4 * 60 * 60 * 1000;
/** A minted secret closer than this to expiry cannot survive the WebSocket handshake. */
const CREDENTIAL_MIN_REMAINING_MS = 5_000;

type Credential = typeof GrokBotVoiceCredential.Type;
type EndInput = typeof GrokBotVoiceEndInput.Type;
type Session = typeof GrokBotVoiceSession.Type;

/** The desktop's `recordVoiceCall` record. Nudges and overheard stay empty: T3 has neither. */
export interface VoiceCallRecord {
  readonly callId: string;
  readonly agentId: string;
  readonly model: string;
  readonly realtimeConversationId?: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly ending: "hung-up" | "disconnected" | "failed";
  readonly turns: NonNullable<EndInput["turns"]>;
  readonly nudges: readonly [];
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly argumentsJson: string;
    readonly atMs: number;
    readonly result: { readonly json: string; readonly atMs: number } | null;
  }[];
  readonly overheard: readonly [];
  /** Native may only collect the call for training when privacy mode is known off; T3 never asserts that. */
  readonly harnessMayCollect: false;
}

/** Bounds what a runaway call can make the server hold until hang-up. */
const MAX_TOOL_CALLS = 200;
const MAX_TOOL_JSON_CHARS = 64_000;

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const toJson = (value: unknown) =>
  encodeJson(value ?? null).pipe(Effect.orElseSucceed(() => "null"));

/**
 * The native Grok Bot account calls this service needs, backed by the signed-in account's
 * Connect client (`MintSandVoiceCallSecret`, `VoiceCallHarnessSession`, `VoiceCallHarnessTool`).
 * Every call after `accountBinding` carries that binding so a switched account or team fails
 * instead of being served under the new identity. NativeService supplies the live layer.
 */
export class GrokBotVoiceBackend extends Context.Service<
  GrokBotVoiceBackend,
  {
    /** The selected account/team right now, as the opaque binding the other methods are bound to. */
    readonly accountBinding: Effect.Effect<string, GrokBotVoiceError>;
    readonly mintCredential: (binding: string) => Effect.Effect<Credential, GrokBotVoiceError>;
    /** Verifies the bot is on this account's roster and speaks as its native name. */
    readonly openSession: (
      binding: string,
      input: {
        readonly botId: string;
        readonly userName?: string;
        readonly description?: string;
        readonly spokenLanguage?: string;
      },
    ) => Effect.Effect<Session, GrokBotVoiceError>;
    readonly callTool: (
      binding: string,
      input: {
        readonly botId: string;
        /** The call's own id, which native keys the harness by; not the realtime tool call id. */
        readonly callId: string;
        readonly name: string;
        readonly input: unknown;
        readonly line: typeof GrokBotVoiceToolInput.Type.line;
      },
    ) => Effect.Effect<typeof GrokBotVoiceToolResult.Type, GrokBotVoiceError>;
    /** Marks the bot on or off the line for this call (`setVoiceCallPresence`). */
    readonly setPresence: (
      binding: string,
      input: { readonly botId: string; readonly callId: string; readonly onTheLine: boolean },
    ) => Effect.Effect<void, GrokBotVoiceError>;
    /** Hands native the finished call (`recordVoiceCall`), which writes its history entry. */
    readonly recordCall: (
      binding: string,
      record: VoiceCallRecord,
    ) => Effect.Effect<void, GrokBotVoiceError>;
  }
>()("t3/grokBot/voice/GrokBotVoiceService/GrokBotVoiceBackend") {}

/** Mirrors the desktop `isDialableURL`, but parses instead of prefix-matching so `wss://api.x.ai@evil` fails. */
export function isDialableVoiceUrl(value: string): boolean {
  if (!value.startsWith(GROK_BOT_VOICE_REALTIME_ORIGIN)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      url.host === "api.x.ai" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export class GrokBotVoiceService extends Context.Service<
  GrokBotVoiceService,
  {
    readonly start: (input: {
      readonly botId: string;
      readonly userName?: string;
      readonly description?: string;
      readonly spokenLanguage?: string;
    }) => Effect.Effect<
      { readonly callId: string; readonly credential: Credential; readonly session: Session },
      GrokBotVoiceError
    >;
    /** A replacement credential for an active call; the call keeps its id, bot, and account. */
    readonly refresh: (callId: string) => Effect.Effect<Credential, GrokBotVoiceError>;
    /**
     * `access` is what the calling RPC's authorized scope allows; it is supplied by the transport,
     * never by the wire input or the model.
     */
    readonly tool: (
      input: typeof GrokBotVoiceToolInput.Type,
      access: Bridge.VoiceAccess,
    ) => Effect.Effect<typeof GrokBotVoiceToolResult.Type, GrokBotVoiceError>;
    /**
     * The client's realtime session is live. Idempotent: only the first notification for a call
     * marks it connected and puts the bot on the line; a call already ended is `unknown_call`.
     */
    readonly connected: (
      callId: string,
    ) => Effect.Effect<{ readonly first: boolean }, GrokBotVoiceError>;
    /**
     * Forgets the call and, when it connected, records it natively. The first end wins: later
     * ones (remote close racing a hang-up, an unmount) find nothing and record nothing.
     */
    readonly end: (
      input: EndInput,
    ) => Effect.Effect<{ readonly ended: boolean; readonly recorded: boolean }>;
  }
>()("t3/grokBot/voice/GrokBotVoiceService") {}

interface ActiveCall {
  readonly binding: string;
  readonly botId: string;
  readonly model: string;
  readonly at: number;
  /** Set once the client (or a tool call) proves the realtime session is live; dates the call. */
  connectedAtMs: number | undefined;
  readonly authorityReady: Deferred.Deferred<void>;
  readonly toolCalls: VoiceCallRecord["toolCalls"][number][];
}

const make = Effect.gen(function* () {
  const backend = yield* GrokBotVoiceBackend;
  const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
  // callId -> the account and bot it speaks for. Later requests can only reach those.
  const calls = yield* Ref.make(new Map<string, ActiveCall>());

  const forget = (callId: string) =>
    Ref.update(calls, (current) => {
      const next = new Map(current);
      next.delete(callId);
      return next;
    }).pipe(Effect.andThen(bridge.forget(callId)));

  const sweep = (now: number) =>
    Ref.modify(calls, (current) => {
      const next = new Map(current);
      const expired: string[] = [];
      for (const [id, call] of next)
        if (now - call.at > CALL_MAX_AGE_MS) {
          next.delete(id);
          expired.push(id);
        }
      return [expired, next] as const;
    }).pipe(Effect.flatMap((expired) => Effect.forEach(expired, bridge.forget, { discard: true })));

  /** The call, if it is still within its lifetime and the selected account is the one that opened it. */
  const active = Effect.fnUntraced(function* (callId: string) {
    const now = yield* Clock.currentTimeMillis;
    const call = (yield* Ref.get(calls)).get(callId);
    if (call === undefined) return yield* new GrokBotVoiceError({ reason: "unknown_call" });
    if (now - call.at > CALL_MAX_AGE_MS) {
      yield* forget(callId);
      return yield* new GrokBotVoiceError({ reason: "unknown_call" });
    }
    const current = yield* Effect.exit(backend.accountBinding);
    if (current._tag === "Failure" || current.value !== call.binding) {
      yield* forget(callId);
      return yield* new GrokBotVoiceError({ reason: "account_unavailable" });
    }
    return call;
  });

  const dialable = Effect.fnUntraced(function* (credential: Credential) {
    const now = yield* Clock.currentTimeMillis;
    if (!isDialableVoiceUrl(credential.websocketUrl))
      return yield* new GrokBotVoiceError({ reason: "undialable_endpoint" });
    if (credential.expiresAtUnixSeconds * 1000 - now < CREDENTIAL_MIN_REMAINING_MS)
      return yield* new GrokBotVoiceError({ reason: "expired_credential" });
    return credential;
  });

  /**
   * Marks the call connected exactly once and puts the bot on the line. Presence is best effort.
   * If the call ended while the true was in flight, `end` may have sent false first, so false is
   * sent again to keep a late true from resurrecting presence.
   */
  const markConnected = Effect.fnUntraced(function* (callId: string, call: ActiveCall) {
    const now = yield* Clock.currentTimeMillis;
    const first = yield* Ref.modify(calls, (current) => {
      if (current.get(callId) !== call || call.connectedAtMs !== undefined)
        return [false, current] as const;
      call.connectedAtMs = now;
      return [true, current] as const;
    });
    if (!first) {
      if ((yield* Ref.get(calls)).get(callId) !== call) return false;
      yield* Deferred.await(call.authorityReady);
      return false;
    }
    yield* bridge
      .activate({ binding: call.binding, botId: call.botId, callId })
      .pipe(Effect.ensuring(Deferred.succeed(call.authorityReady, undefined)));
    if (!(yield* Ref.get(calls)).has(callId)) yield* bridge.forget(callId);
    const presence = { botId: call.botId, callId };
    yield* backend.setPresence(call.binding, { ...presence, onTheLine: true }).pipe(Effect.ignore);
    if (!(yield* Ref.get(calls)).has(callId))
      yield* backend
        .setPresence(call.binding, { ...presence, onTheLine: false })
        .pipe(Effect.ignore);
    return true;
  });

  const connected: GrokBotVoiceService["Service"]["connected"] = Effect.fn(
    "GrokBotVoice.connected",
  )(function* (callId) {
    const call = yield* active(callId);
    return { first: yield* markConnected(callId, call) };
  });

  const start: GrokBotVoiceService["Service"]["start"] = Effect.fn("GrokBotVoice.start")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      yield* sweep(now);
      const binding = yield* backend.accountBinding;
      const credential = yield* backend.mintCredential(binding).pipe(Effect.flatMap(dialable));
      const session = yield* backend.openSession(binding, input);
      const chatContext = yield* bridge.context(input.botId);
      // The account may have changed while the credential and session were being fetched.
      if ((yield* backend.accountBinding) !== binding)
        return yield* new GrokBotVoiceError({ reason: "account_unavailable" });
      // Same shape as the desktop's call ids.
      const callId = yield* Effect.sync(() => `call-${NodeCrypto.randomUUID()}`);
      const authorityReady = yield* Deferred.make<void>();
      yield* Ref.update(calls, (current) =>
        new Map(current).set(callId, {
          binding,
          botId: input.botId,
          model: credential.model,
          at: now,
          connectedAtMs: undefined,
          authorityReady,
          toolCalls: [],
        }),
      );
      // Execution goes through T3, not native: swap the native execution tool for the T3 ones.
      return {
        callId,
        credential,
        session: {
          ...session,
          ...(chatContext === undefined ? {} : { chatContext }),
          instructions: Bridge.withT3Instructions(session.instructions),
          tools: Bridge.routeSessionTools(session.tools),
        },
      };
    },
  );

  const refresh: GrokBotVoiceService["Service"]["refresh"] = Effect.fn("GrokBotVoice.refresh")(
    function* (callId) {
      const call = yield* active(callId);
      return yield* backend.mintCredential(call.binding).pipe(Effect.flatMap(dialable));
    },
  );

  const tool: GrokBotVoiceService["Service"]["tool"] = Effect.fn("GrokBotVoice.tool")(
    function* (input, access) {
      const call = yield* active(input.callId);
      const startedAt = yield* Clock.currentTimeMillis;
      // A tool call is also proof of connection, for a client that never sent the notification.
      yield* markConnected(input.callId, call);
      yield* active(input.callId);
      // T3 tools are served here, conversation controls go to native, anything else is refused.
      const result = Bridge.isRoutedLocally(input.name)
        ? yield* bridge.call({
            binding: call.binding,
            botId: call.botId,
            callId: input.callId,
            toolCallId: input.toolCallId,
            name: input.name,
            input: input.input,
            access,
          })
        : Bridge.isNativeControl(input.name)
          ? yield* backend.callTool(call.binding, {
              botId: call.botId,
              callId: input.callId,
              name: input.name,
              input: input.input,
              line: input.line,
            })
          : // A name outside the session's tool list (a stale connector's orchestration tool, a
            // guess) is never forwarded: native has no say in what runs for this server.
            ({ kind: "unknown_tool", output: { error: "unknown tool" } } as const);
      // A completion wait can outlive hang-up or an account switch. Recheck after waiting,
      // before allowing its result back onto the wire.
      yield* active(input.callId);
      const endedAt = yield* Clock.currentTimeMillis;
      const json = yield* toJson(result.output);
      const argumentsJson = yield* toJson(input.input);
      // Entries stay on the call object, so a call already ended simply drops them.
      if (
        call.toolCalls.length < MAX_TOOL_CALLS &&
        input.name !== Bridge.T3_CHAT_UPDATES &&
        !(input.name === Bridge.T3_TASK_PROGRESS && result.completion !== undefined)
      )
        call.toolCalls.push({
          id: input.toolCallId,
          name: input.name,
          argumentsJson: argumentsJson.slice(0, MAX_TOOL_JSON_CHARS),
          atMs: startedAt,
          result: { json: json.slice(0, MAX_TOOL_JSON_CHARS), atMs: endedAt },
        });
      return result;
    },
  );

  const end: GrokBotVoiceService["Service"]["end"] = Effect.fn("GrokBotVoice.end")(
    function* (input) {
      // Removal is the single decision point: only the caller that removes the call may finalize it.
      const call = yield* Ref.modify(calls, (current) => {
        const entry = current.get(input.callId);
        if (entry === undefined) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(input.callId);
        return [entry, next] as const;
      });
      if (call === undefined) return { ended: false, recorded: false };
      yield* bridge.forget(input.callId);
      const endedAtMs = yield* Clock.currentTimeMillis;
      // The record and the presence reset both go out under the account that opened the call, so a
      // switched account fails them instead of writing into the new account's history.
      const recorded =
        input.ending === undefined
          ? false
          : yield* backend
              .recordCall(call.binding, {
                callId: input.callId,
                agentId: call.botId,
                model: call.model,
                ...(input.realtimeConversationId
                  ? { realtimeConversationId: input.realtimeConversationId }
                  : {}),
                startedAtMs: call.connectedAtMs ?? call.at,
                endedAtMs,
                durationMs: Math.max(0, endedAtMs - (call.connectedAtMs ?? call.at)),
                ending: input.ending,
                turns: input.turns ?? [],
                nudges: [],
                toolCalls: [...call.toolCalls],
                overheard: [],
                harnessMayCollect: false,
              })
              .pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
      if (call.connectedAtMs !== undefined)
        yield* backend
          .setPresence(call.binding, { botId: call.botId, callId: input.callId, onTheLine: false })
          .pipe(Effect.ignore);
      return { ended: true, recorded };
    },
  );

  // Hanging up is the only cleanup the credential needs: it lives in the response and nowhere else.
  yield* Effect.addFinalizer(() =>
    Ref.getAndSet(calls, new Map()).pipe(
      Effect.flatMap((current) => Effect.forEach(current.keys(), bridge.forget, { discard: true })),
    ),
  );

  return GrokBotVoiceService.of({ start, refresh, tool, connected, end });
});

export const layer = Layer.effect(GrokBotVoiceService, make);
