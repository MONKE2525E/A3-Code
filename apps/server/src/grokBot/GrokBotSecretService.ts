import {
  GrokBotSecretError,
  type GrokBotSecretDismissInput,
  type GrokBotSecretDismissResult,
  type GrokBotSecretPendingInput,
  type GrokBotSecretPendingResult,
  type GrokBotSecretSubmitInput,
  type GrokBotSecretSubmitResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Runtime from "./GrokBotNativeRuntimeService.ts";

export class GrokBotSecretService extends Context.Service<
  GrokBotSecretService,
  {
    /** The secret questions a bot is asking in one session. Never carries a value. */
    readonly pending: (
      input: typeof GrokBotSecretPendingInput.Type,
    ) => Effect.Effect<typeof GrokBotSecretPendingResult.Type, GrokBotSecretError>;
    /**
     * Delivers a secret to the native secure input of an existing pending request in this
     * account's bot/session. Resolves only when native accepts it; never returns the value.
     */
    readonly submit: (
      input: typeof GrokBotSecretSubmitInput.Type,
    ) => Effect.Effect<typeof GrokBotSecretSubmitResult.Type, GrokBotSecretError>;
    /**
     * Native cannot cancel a secure input. Checks the request is still pending in this account's
     * bot/session, then fails `unsupported` without sending anything, so a client can hide the card
     * on its own without claiming the bot was told.
     */
    readonly dismiss: (
      input: typeof GrokBotSecretDismissInput.Type,
    ) => Effect.Effect<typeof GrokBotSecretDismissResult.Type, GrokBotSecretError>;
  }
>()("t3/grokBot/GrokBotSecretService") {}

// Only the bounded failure category crosses this boundary, never the request.
const unavailable = (error: Runtime.RuntimeError) =>
  new GrokBotSecretError({
    reason:
      error._tag === "GrokBotNativeRuntimeError" && error.kind === "refused"
        ? "refused"
        : "unavailable",
  });

const make = Effect.gen(function* () {
  const runtime = yield* Runtime.GrokBotNativeRuntimeService;
  const bound = runtime.accountBinding.pipe(
    Effect.mapError(() => new GrokBotSecretError({ reason: "account_unavailable" })),
  );
  const requests = (binding: string, input: typeof GrokBotSecretPendingInput.Type) =>
    runtime
      .secretRequests({ binding, botId: input.botId, sessionId: input.sessionId })
      .pipe(Effect.mapError(unavailable));

  /** The write is bound to the account first, then to a request native is still asking in this exact bot and session. */
  const pendingTarget = Effect.fnUntraced(function* (
    binding: string,
    input: { readonly botId: string; readonly sessionId: string; readonly entryId: string },
  ) {
    const target = (yield* requests(binding, input)).find(
      (request) => request.entryId === input.entryId,
    );
    if (target === undefined) return yield* new GrokBotSecretError({ reason: "request_not_found" });
    if (target.state !== "pending")
      return yield* new GrokBotSecretError({ reason: "already_answered" });
  });

  /**
   * Runs a native write, then settles an error against what native now shows. A write can land
   * even when its reply fails, so a request native already answered reports `already_answered`
   * rather than a delivery failure. Only a request still pending keeps the original error, which
   * the client can retry. Nothing here claims a value was stored.
   */
  const settleWrite = (
    binding: string,
    input: { readonly botId: string; readonly sessionId: string; readonly entryId: string },
    write: Effect.Effect<void, Runtime.RuntimeError>,
  ) =>
    write.pipe(
      Effect.catch((error) =>
        pendingTarget(binding, input).pipe(
          // Still pending, or the re-read itself failed: the original write error is what to report.
          Effect.matchEffect({
            onSuccess: () => Effect.fail(unavailable(error)),
            onFailure: (settled) =>
              settled.reason === "already_answered" || settled.reason === "request_not_found"
                ? Effect.fail(settled)
                : Effect.fail(unavailable(error)),
          }),
        ),
      ),
    );

  const submit = Effect.fnUntraced(function* (input: typeof GrokBotSecretSubmitInput.Type) {
    const binding = yield* bound;
    yield* pendingTarget(binding, input);
    yield* settleWrite(
      binding,
      input,
      runtime.submitSecret({
        binding,
        botId: input.botId,
        sessionId: input.sessionId,
        entryId: input.entryId,
        value: Redacted.make(input.value),
      }),
    );
    return { accepted: true as const };
  });

  const dismiss = Effect.fnUntraced(function* (input: typeof GrokBotSecretDismissInput.Type) {
    const binding = yield* bound;
    yield* pendingTarget(binding, input);
    // Native has no dismissal for a secure input, and `DismissGrokBotWidget` targets `widget`
    // entries, so nothing is sent: the bot is not told and the request stays open.
    return yield* new GrokBotSecretError({ reason: "unsupported" });
  });

  const pending = Effect.fnUntraced(function* (input: typeof GrokBotSecretPendingInput.Type) {
    const found = yield* requests(yield* bound, input);
    return {
      requests: found.map(({ entryId, title, description, state }) => ({
        entryId,
        sessionId: input.sessionId,
        title,
        ...(description === undefined ? {} : { description }),
        state,
      })),
    };
  });

  return GrokBotSecretService.of({ pending, submit, dismiss });
});
export const layer = Layer.effect(GrokBotSecretService, make);
