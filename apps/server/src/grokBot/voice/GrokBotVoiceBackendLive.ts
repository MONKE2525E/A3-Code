import { GrokBotVoiceError } from "@t3tools/contracts/grokBotVoice";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Native from "../GrokBotNativeService.ts";
import { GrokBotVoiceBackend } from "./GrokBotVoiceService.ts";

const OptionalString = Schema.optionalKey(Schema.String);
const MintResponse = Schema.Struct({
  clientSecret: Schema.String,
  expiresAtUnixSeconds: Schema.Union([Schema.String, Schema.Number]),
  model: Schema.String,
  websocketUrl: Schema.String,
});
const Roster = Schema.Struct({
  agents: Schema.optionalKey(
    Schema.Array(Schema.Struct({ agentId: Schema.String, name: OptionalString })),
  ),
});
const SessionResponse = Schema.Struct({
  instructions: OptionalString,
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: OptionalString,
        name: OptionalString,
        description: OptionalString,
        parameters: Schema.optionalKey(Schema.Unknown),
      }),
    ),
  ),
  hasOverheard: Schema.optionalKey(Schema.Boolean),
  greeting: Schema.optionalKey(
    Schema.Struct({ direction: OptionalString, withLandedWork: OptionalString }),
  ),
  receipt: Schema.optionalKey(
    Schema.Struct({
      output: Schema.optionalKey(Schema.Struct({ receipt: OptionalString })),
      instructions: OptionalString,
    }),
  ),
});
const ToolResponse = Schema.Struct({
  kind: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  output: Schema.optionalKey(Schema.Unknown),
});

const unavailable = new GrokBotVoiceError({ reason: "unavailable" });

/**
 * Native errors can carry credentials, so only a bounded category leaves this adapter: a session
 * mismatch is the account changing, a 4xx is native declining, everything else is transient.
 */
const toVoiceError = (cause: Native.NativeReadError | Native.NativeSignedOutError) => {
  if (cause._tag === "GrokBotNativeSignedOutError")
    return new GrokBotVoiceError({ reason: "account_unavailable" });
  if (cause.stage === "session" || cause.status === 401)
    return new GrokBotVoiceError({ reason: "account_unavailable" });
  if (cause.status !== undefined && cause.status >= 400 && cause.status < 500)
    return new GrokBotVoiceError({ reason: "refused" });
  return unavailable;
};

const decode = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => unavailable));

/** Native sends the outcome as the proto enum name; the number form is accepted for the same values. */
const outcome = (kind: string | number | undefined) => {
  switch (kind) {
    case "VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_SERVED":
    case 1:
      return "served" as const;
    case "VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_UNKNOWN_TOOL":
    case 2:
      return "unknown_tool" as const;
    case "VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_INVALID_INPUT":
    case 3:
      return "invalid_input" as const;
    default:
      return undefined;
  }
};

const make = Effect.gen(function* () {
  const native = yield* Native.GrokBotNativeService;
  const request = (binding: string, method: Native.NativeRuntimeMethod, input: object) =>
    native.runtimeRequest(binding, method, input).pipe(Effect.mapError(toVoiceError));

  return GrokBotVoiceBackend.of({
    accountBinding: native.accountBinding.pipe(
      Effect.mapError((error) =>
        error._tag === "GrokBotNativeSignedOutError"
          ? new GrokBotVoiceError({ reason: "account_unavailable" })
          : unavailable,
      ),
    ),

    mintCredential: Effect.fn("GrokBotVoiceBackend.mintCredential")(function* (binding) {
      const minted = yield* request(binding, "MintSandVoiceCallSecret", {}).pipe(
        Effect.flatMap((value) => decode(MintResponse, value)),
      );
      // int64 arrives as a string in Connect JSON.
      const expiresAtUnixSeconds = Number(minted.expiresAtUnixSeconds);
      if (!Number.isFinite(expiresAtUnixSeconds) || minted.clientSecret.length === 0)
        return yield* unavailable;
      return {
        clientSecret: minted.clientSecret,
        expiresAtUnixSeconds,
        model: minted.model,
        websocketUrl: minted.websocketUrl,
      };
    }),

    openSession: Effect.fn("GrokBotVoiceBackend.openSession")(function* (binding, input) {
      const roster = yield* request(binding, "ListGrokBotAgents", {}).pipe(
        Effect.flatMap((value) => decode(Roster, value)),
      );
      // The bot must be on this account's roster, and speaks as the name native holds for it.
      const bot = roster.agents?.find((agent) => agent.agentId === input.botId);
      if (bot === undefined || !bot.name)
        return yield* new GrokBotVoiceError({ reason: "refused" });
      const session = yield* request(binding, "VoiceCallHarnessSession", {
        agentId: input.botId,
        agentName: bot.name,
        ...(input.userName === undefined ? {} : { userName: input.userName }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.spokenLanguage === undefined ? {} : { spokenLanguage: input.spokenLanguage }),
      }).pipe(Effect.flatMap((value) => decode(SessionResponse, value)));
      if (!session.instructions) return yield* unavailable;
      const receipt = session.receipt;
      return {
        instructions: session.instructions,
        tools: (session.tools ?? []).map((tool) => ({
          type: tool.type ?? "",
          name: tool.name ?? "",
          description: tool.description ?? "",
          parameters: tool.parameters ?? {},
        })),
        hasOverheard: session.hasOverheard ?? false,
        greeting: {
          direction: session.greeting?.direction ?? "",
          withLandedWork: session.greeting?.withLandedWork ?? "",
        },
        ...(receipt?.instructions
          ? {
              receipt: {
                output: receipt.output?.receipt ?? "",
                instructions: receipt.instructions,
              },
            }
          : {}),
      };
    }),

    callTool: Effect.fn("GrokBotVoiceBackend.callTool")(function* (binding, input) {
      const result = yield* request(binding, "VoiceCallHarnessTool", {
        agentId: input.botId,
        callId: input.callId,
        name: input.name,
        input: input.input ?? null,
        line: input.line,
      }).pipe(Effect.flatMap((value) => decode(ToolResponse, value)));
      const kind = outcome(result.kind);
      if (kind === undefined) return yield* unavailable;
      return { kind, output: result.output ?? null };
    }),

    setPresence: Effect.fn("GrokBotVoiceBackend.setPresence")(function* (binding, input) {
      yield* native
        .voiceGateway(binding, {
          method: "setVoiceCallPresence",
          args: { id: input.botId, callId: input.callId, isOnTheLine: input.onTheLine },
        })
        .pipe(Effect.mapError(toVoiceError));
    }),

    recordCall: Effect.fn("GrokBotVoiceBackend.recordCall")(function* (binding, record) {
      yield* native
        .voiceGateway(binding, { method: "recordVoiceCall", args: { record } })
        .pipe(Effect.mapError(toVoiceError));
    }),
  });
});

export const layer = Layer.effect(GrokBotVoiceBackend, make);
