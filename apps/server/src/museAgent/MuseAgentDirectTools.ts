import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as NativeTools from "../mcp/direct/NativeAgentDirectTools.ts";

export interface MuseDirectToolSession {
  readonly catalog: NativeTools.DirectToolSession["catalog"];
  readonly acceptRegistration: NativeTools.DirectToolSession["acceptRegistration"];
  readonly revoke: NativeTools.DirectToolSession["revoke"];
  readonly invoke: (
    connectionId: string,
    payload: unknown,
  ) => Effect.Effect<
    {
      readonly method: "client.invoke.result";
      readonly params: {
        readonly invoke_id: string;
        readonly ok: boolean;
        readonly payload_json?: string;
        readonly error?: { readonly code: string; readonly message: string };
      };
      readonly options: { readonly expectedConnectionId: string };
    },
    NativeTools.NativeAgentDirectToolsError
  >;
}

export class MuseAgentDirectTools extends Context.Service<
  MuseAgentDirectTools,
  {
    readonly open: (
      options: NativeTools.DirectToolSessionOptions,
    ) => Effect.Effect<MuseDirectToolSession, NativeTools.NativeAgentDirectToolsError, Scope.Scope>;
  }
>()("t3/museAgent/MuseAgentDirectTools") {}

const Envelope = Schema.Struct({
  invoke_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  command_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  params_json: Schema.String.check(Schema.isMaxLength(NativeTools.DIRECT_TOOL_LIMITS.paramsBytes)),
  timeout_ms: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: NativeTools.DIRECT_TOOL_LIMITS.timeoutMs }),
    ),
  ),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope, { onExcessProperty: "error" });
const decodeField = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      params_json: Schema.String.check(
        Schema.isMaxLength(NativeTools.DIRECT_TOOL_LIMITS.paramsBytes),
      ),
    }),
  ),
  { onExcessProperty: "error" },
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const make = Effect.gen(function* () {
  const nativeTools = yield* NativeTools.NativeAgentDirectTools;
  const open = Effect.fn("MuseAgentDirectTools.open")(function* (
    options: NativeTools.DirectToolSessionOptions,
  ) {
    const session = yield* nativeTools.open(options);
    const invoke: MuseDirectToolSession["invoke"] = Effect.fn("MuseAgentDirectTools.invoke")(
      function* (connectionId, payload) {
        const request = yield* decodeEnvelope(payload).pipe(
          Effect.mapError(
            () => new NativeTools.NativeAgentDirectToolsError({ code: "invalid_request" }),
          ),
        );
        if (
          Buffer.byteLength(request.params_json, "utf8") >
          NativeTools.DIRECT_TOOL_LIMITS.paramsBytes
        )
          return yield* new NativeTools.NativeAgentDirectToolsError({ code: "invalid_params" });
        const field = yield* decodeField(request.params_json).pipe(
          Effect.mapError(
            () => new NativeTools.NativeAgentDirectToolsError({ code: "invalid_params" }),
          ),
        );
        const result = yield* session.invoke(connectionId, {
          ...request,
          params_json: field.params_json,
        });
        const payloadJson =
          result.result === undefined
            ? undefined
            : yield* encodeJson(result.result).pipe(
                Effect.mapError(
                  () => new NativeTools.NativeAgentDirectToolsError({ code: "tool_failed" }),
                ),
              );
        return {
          method: "client.invoke.result",
          params: {
            invoke_id: result.invoke_id,
            ok: result.ok,
            ...(payloadJson === undefined ? {} : { payload_json: payloadJson }),
            ...(result.ok
              ? {}
              : {
                  error: result.error ?? {
                    code: "tool_failed",
                    message: "The T3 tool refused or failed this request.",
                  },
                }),
          },
          // Reply only to the connection validated for this invocation, never the current reconnect.
          options: { expectedConnectionId: connectionId },
        };
      },
    );
    return {
      catalog: session.catalog,
      acceptRegistration: session.acceptRegistration,
      revoke: session.revoke,
      invoke,
    } satisfies MuseDirectToolSession;
  });
  return MuseAgentDirectTools.of({ open });
});

export const layer = Layer.effect(MuseAgentDirectTools, make);
