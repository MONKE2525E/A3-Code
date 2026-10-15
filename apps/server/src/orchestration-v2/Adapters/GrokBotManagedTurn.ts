import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { isTransientStartCause } from "@t3tools/provider-core/server/failure";
import {
  NativeRuntimeError,
  type GrokBotNativeRuntimeService,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import {
  GrokBotBindingError,
  type GrokBotManagedBinding,
  type GrokBotManagedTurn,
} from "./GrokBotManagedBinding.ts";

/** Attachment upload attempts after the first, before the run's durable redelivery takes over. */
export const GROK_BOT_UPLOAD_RETRIES = 2;

/**
 * Re-sending an upload is safe because chunks are addressed by a deterministic upload id and
 * offset, and nothing is delivered to the bot until every upload has a receipt. Only
 * attachment failures the native layer marked transient qualify; everything else is final.
 */
export const grokBotUploadRetrySchedule = Schedule.exponential("500 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(8))),
  ),
  Schedule.jittered,
);

/** Native acceptance is durable delivery, never successful execution settlement. */
export const makeGrokBotManagedTurn = Effect.fnUntraced(function* (input: {
  readonly native: GrokBotNativeRuntimeService["Service"];
  readonly bindings: GrokBotManagedBinding["Service"];
}) {
  const lock = yield* Semaphore.make(1);
  const acceptedMessages = new Map<string, string>();
  const send = Effect.fnUntraced(function* (turn: GrokBotManagedTurn, attachmentsDir?: string) {
    if ((yield* input.native.accountBinding) !== turn.native.binding)
      return yield* new GrokBotBindingError({
        reason: "The selected native account or team changed.",
      });
    const key = `${turn.native.binding}:${turn.native.botId}:${turn.native.sessionId}:${turn.messageId}`;
    const authority = `${turn.input.runId}:${turn.input.attemptId}`;
    const known = acceptedMessages.get(key);
    if (known !== undefined) {
      if (known !== authority)
        return yield* new GrokBotBindingError({
          reason: "A native send identity belongs to another run.",
        });
      return;
    }
    const statusInput = {
      binding: turn.native.binding,
      botId: turn.native.botId,
      sessionId: turn.native.sessionId,
      messageId: turn.messageId,
    };
    // Also reconciles an outbox retry after host restart, before attempting another send.
    const before = yield* input.native
      .sendStatus(statusInput)
      .pipe(Effect.mapError(() => new NativeRuntimeError({ kind: "uncertain" })));
    if (before.status === "accepted") {
      yield* input.bindings
        .accepted({
          turn,
          delivery: "duplicate",
          ...(before.echoEntryId === undefined ? {} : { echoEntryId: before.echoEntryId }),
        })
        .pipe(Effect.mapError(() => new NativeRuntimeError({ kind: "uncertain" })));
      acceptedMessages.set(key, authority);
      return;
    }
    if (before.status !== "not_found")
      return yield* new NativeRuntimeError({
        kind: before.status === "rejected" ? "refused" : "uncertain",
      });
    const uploaded =
      turn.input.message.attachments.length === 0
        ? undefined
        : yield* input.native
            .uploadAttachments({
              binding: turn.native.binding,
              botId: turn.native.botId,
              sessionId: turn.native.sessionId,
              messageId: turn.messageId,
              attachmentsDir: attachmentsDir ?? "",
              attachments: turn.input.message.attachments,
            })
            .pipe(
              Effect.tapError((error) =>
                isTransientStartCause(error)
                  ? Effect.logWarning("Grok Bot attachment upload failed; it will be retried.", {
                      runId: turn.input.runId,
                      messageId: turn.messageId,
                      error,
                    })
                  : Effect.void,
              ),
              Effect.retry({
                schedule: grokBotUploadRetrySchedule,
                times: GROK_BOT_UPLOAD_RETRIES,
                while: isTransientStartCause,
              }),
            );
    const receipt = yield* input.native
      .startTurn({
        binding: turn.native.binding,
        botId: turn.native.botId,
        sessionId: turn.native.sessionId,
        messageId: turn.messageId,
        sentAtMs: turn.sentAtMs,
        text: turn.nativePrompt,
        mcpConfig: turn.mcpConfig,
        ...(uploaded === undefined
          ? {}
          : { attachmentPaths: uploaded.paths, attachmentNames: uploaded.names }),
      })
      .pipe(
        Effect.catch((error) => {
          // Account checks also run after the cloud response. Once startTurn begins,
          // losing selection cannot prove that the message was never accepted.
          if (
            error._tag === "GrokBotNativeRuntimeError" &&
            ["invalid_input", "refused"].includes(error.kind)
          )
            return Effect.fail(error);
          return input.native.sendStatus(statusInput).pipe(
            Effect.mapError(() => new NativeRuntimeError({ kind: "uncertain" })),
            Effect.flatMap((status) =>
              status.status === "accepted"
                ? Effect.succeed({
                    delivery: "duplicate" as const,
                    ...(status.echoEntryId === undefined
                      ? {}
                      : { echoEntryId: status.echoEntryId }),
                  })
                : Effect.fail(
                    new NativeRuntimeError({
                      kind: status.status === "rejected" ? "refused" : "uncertain",
                    }),
                  ),
            ),
          );
        }),
      );
    // Failed persistence remains uncertain. The next invocation checks native status rather than using a new id.
    yield* input.bindings
      .accepted({ turn, ...receipt })
      .pipe(Effect.mapError(() => new NativeRuntimeError({ kind: "uncertain" })));
    acceptedMessages.set(key, authority);
  });
  return {
    send: (turn: GrokBotManagedTurn, attachmentsDir?: string) =>
      lock.withPermits(1)(send(turn, attachmentsDir)),
  };
});
