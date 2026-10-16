import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  NativeReadError,
  NativeSignedOutError,
  NativeAttachmentError,
} from "../../grokBot/GrokBotNativeService.ts";
import { NativeRuntimeError } from "../../grokBot/GrokBotNativeRuntimeService.ts";
import { GrokBotBindingError } from "./GrokBotManagedBinding.ts";
import { GROK_BOT_UPLOAD_RETRIES, makeGrokBotManagedTurn } from "./GrokBotManagedTurn.ts";
import { makeBindings, makeNative, makeTurn } from "./GrokBotProvider.testkit.ts";

it.effect("uploads attachments before sending and stops before send on upload failure", () =>
  Effect.gen(function* () {
    const original = yield* makeTurn;
    const turn = {
      ...original,
      input: {
        ...original.input,
        message: {
          ...original.input.message,
          attachments: [
            {
              type: "file" as const,
              id: "fixture",
              name: "proof.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
          ],
        },
      },
    };
    const order: string[] = [];
    let fail = true;
    const core = yield* makeGrokBotManagedTurn({
      native: makeNative({
        uploadAttachments: () =>
          fail
            ? Effect.fail(new NativeAttachmentError({ reason: "upload_failed" }))
            : Effect.sync(() => {
                order.push("upload");
                return { paths: ["/uploads/proof.txt"], names: ["proof.txt"] };
              }),
        startTurn: (input) =>
          Effect.sync(() => {
            order.push("send");
            assert.deepEqual(input.attachmentPaths, ["/uploads/proof.txt"]);
            assert.deepEqual(input.attachmentNames, ["proof.txt"]);
            return { delivery: "accepted" as const };
          }),
      }),
      bindings: makeBindings(turn),
    });
    assert.equal((yield* Effect.result(core.send(turn, "/attachments")))._tag, "Failure");
    assert.deepEqual(order, []);
    fail = false;
    yield* core.send(turn, "/attachments");
    assert.deepEqual(order, ["upload", "send"]);
  }),
);

it.effect("sends the persisted message identity and per-run config only once", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const sent: unknown[] = [];
    let receipts = 0;
    const core = yield* makeGrokBotManagedTurn({
      native: makeNative({
        startTurn: (input) =>
          Effect.sync(() => {
            sent.push(input);
            return { delivery: "accepted" as const };
          }),
      }),
      bindings: makeBindings(turn, {
        accepted: () =>
          Effect.sync(() => {
            receipts++;
          }),
      }),
    });
    yield* core.send(turn);
    yield* core.send(turn);
    assert.deepEqual(sent, [
      {
        binding: turn.native.binding,
        botId: turn.native.botId,
        sessionId: "",
        messageId: turn.messageId,
        sentAtMs: turn.sentAtMs,
        text: turn.input.message.text,
        mcpConfig: turn.mcpConfig,
      },
    ]);
    assert.equal(receipts, 1);
  }),
);

it.effect("reconciles accepted outbox delivery before any resend after a restart", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    let receipts = 0;
    const core = yield* makeGrokBotManagedTurn({
      native: makeNative({
        sendStatus: () => Effect.succeed({ status: "accepted", echoEntryId: "native-echo" }),
        startTurn: () => Effect.die("must not resend"),
      }),
      bindings: makeBindings(turn, {
        accepted: (receipt) =>
          Effect.sync(() => {
            assert.equal(receipt.echoEntryId, "native-echo");
            assert.equal(receipt.delivery, "duplicate");
            receipts++;
          }),
      }),
    });
    yield* core.send(turn);
    assert.equal(receipts, 1);
  }),
);

it.effect("checks an ambiguous send receipt instead of retrying the cloud write", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    let checks = 0;
    let writes = 0;
    const core = yield* makeGrokBotManagedTurn({
      native: makeNative({
        sendStatus: () =>
          Effect.sync(() => ({
            status: ++checks === 1 ? ("not_found" as const) : ("accepted" as const),
          })),
        startTurn: () =>
          Effect.sync(() => {
            writes++;
          }).pipe(Effect.andThen(Effect.fail(new NativeReadError({ stage: "request" })))),
      }),
      bindings: makeBindings(turn),
    });
    yield* core.send(turn);
    assert.equal(checks, 2);
    assert.equal(writes, 1);
  }),
);

it.effect.each(["pending", "unknown_durability", "rejected"] as const)(
  "does not send while durable delivery is $0",
  (status) =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const core = yield* makeGrokBotManagedTurn({
        native: makeNative({
          sendStatus: () => Effect.succeed({ status }),
          startTurn: () => Effect.die("must not write"),
        }),
        bindings: makeBindings(turn),
      });
      const failure = yield* core.send(turn).pipe(Effect.flip);
      assert.equal(failure._tag, "GrokBotNativeRuntimeError");
    }),
);

it.effect("preserves an uncertain cloud acceptance when receipt persistence fails", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    let accepted = false;
    let writes = 0;
    let receipts = 0;
    const core = yield* makeGrokBotManagedTurn({
      native: makeNative({
        sendStatus: () =>
          Effect.sync(() => ({
            status: accepted ? ("accepted" as const) : ("not_found" as const),
          })),
        startTurn: () =>
          Effect.sync(() => {
            accepted = true;
            writes++;
            return { delivery: "accepted" as const };
          }),
      }),
      bindings: makeBindings(turn, {
        accepted: () =>
          Effect.suspend(() =>
            ++receipts === 1
              ? Effect.fail(new GrokBotBindingError({ reason: "storage unavailable" }))
              : Effect.void,
          ),
      }),
    });
    yield* core.send(turn).pipe(Effect.flip);
    yield* core.send(turn);
    assert.equal(writes, 1);
    assert.equal(receipts, 2);
  }),
);

it.effect("does not recover a definitive native refusal as acceptance", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    let checks = 0;
    const core = yield* makeGrokBotManagedTurn({
      native: makeNative({
        sendStatus: () =>
          Effect.sync(() => {
            checks++;
            return { status: "not_found" as const };
          }),
        startTurn: () => Effect.fail(new NativeRuntimeError({ kind: "refused" })),
      }),
      bindings: makeBindings(turn),
    });
    yield* core.send(turn).pipe(Effect.flip);
    assert.equal(checks, 1);
  }),
);

it.effect.each(["account_switch", "sign_out"] as const)(
  "holds a saved accepted send when its post-response account check reports %s",
  (transition) =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      let selected: string | null = turn.native.binding;
      let writes = 0;
      let receipts = 0;
      let cloudAccepted = false;
      const accountError = () =>
        transition === "sign_out"
          ? new NativeSignedOutError({})
          : new NativeReadError({ stage: "session" });
      const core = yield* makeGrokBotManagedTurn({
        native: makeNative({
          accountBinding: Effect.suspend(() =>
            selected === null
              ? Effect.fail(new NativeSignedOutError({}))
              : Effect.succeed(selected),
          ),
          sendStatus: () =>
            Effect.suspend(() =>
              selected !== turn.native.binding
                ? Effect.fail(accountError())
                : Effect.succeed({
                    status: cloudAccepted ? ("accepted" as const) : ("not_found" as const),
                  }),
            ),
          startTurn: (message) =>
            Effect.gen(function* () {
              assert.equal(message.messageId, turn.messageId);
              assert.equal(message.sentAtMs, turn.sentAtMs);
              writes++;
              cloudAccepted = true;
              selected = transition === "sign_out" ? null : "b".repeat(64);
              return yield* accountError();
            }),
        }),
        bindings: makeBindings(turn, {
          accepted: () =>
            Effect.sync(() => {
              receipts++;
            }),
        }),
      });
      const ambiguous = yield* core.send(turn).pipe(Effect.flip);
      assert.equal(ambiguous._tag, "GrokBotNativeRuntimeError");
      if (ambiguous._tag !== "GrokBotNativeRuntimeError")
        return yield* Effect.die("Expected uncertain native delivery.");
      assert.equal(ambiguous.kind, "uncertain");
      assert.equal(writes, 1);
      assert.equal(receipts, 0);
      yield* core.send(turn).pipe(Effect.flip);
      assert.equal(writes, 1);
      selected = turn.native.binding;
      yield* core.send(turn);
      assert.equal(writes, 1);
      assert.equal(receipts, 1);
    }),
);

it.effect.each(["account_switch", "sign_out"] as const)(
  "rejects %s before beginning any native send",
  (transition) =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const core = yield* makeGrokBotManagedTurn({
        native: makeNative({
          accountBinding:
            transition === "sign_out"
              ? Effect.fail(new NativeSignedOutError({}))
              : Effect.succeed("b".repeat(64)),
          sendStatus: () => Effect.die("A rejected account must not query native delivery."),
          startTurn: () => Effect.die("A rejected account must not send a native message."),
        }),
        bindings: makeBindings(turn),
      });
      const rejected = yield* core.send(turn).pipe(Effect.flip);
      assert.equal(
        rejected._tag,
        transition === "sign_out" ? "GrokBotNativeSignedOutError" : "GrokBotBindingError",
      );
    }),
);

const attachmentTurn = Effect.gen(function* () {
  const original = yield* makeTurn;
  return {
    ...original,
    input: {
      ...original.input,
      message: {
        ...original.input.message,
        attachments: [
          {
            type: "image" as const,
            id: "fixture",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
      },
    },
  };
});
const transientUpload = () =>
  Effect.fail(new NativeAttachmentError({ reason: "upload_failed", transient: true }));

it.effect("retries a transient upload failure with backoff and delivers the message once", () =>
  Effect.gen(function* () {
    const turn = yield* attachmentTurn;
    let uploads = 0;
    let sends = 0;
    const core = yield* makeGrokBotManagedTurn({
      native: makeNative({
        uploadAttachments: () =>
          Effect.suspend(() =>
            ++uploads < GROK_BOT_UPLOAD_RETRIES + 1
              ? transientUpload()
              : Effect.succeed({ paths: ["/uploads/image.png"], names: ["image.png"] }),
          ),
        startTurn: () =>
          Effect.sync(() => {
            sends++;
            return { delivery: "accepted" as const };
          }),
      }),
      bindings: makeBindings(turn),
    });
    const fiber = yield* core.send(turn, "/attachments").pipe(Effect.forkChild);
    // The backoff is virtual time; the send only finishes once the clock moves past each wait.
    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(fiber);
    assert.equal(uploads, GROK_BOT_UPLOAD_RETRIES + 1);
    assert.equal(sends, 1);
  }),
);

it.effect("gives up after the bounded retries and never sends an undelivered upload", () =>
  Effect.gen(function* () {
    const turn = yield* attachmentTurn;
    let uploads = 0;
    const core = yield* makeGrokBotManagedTurn({
      native: makeNative({
        uploadAttachments: () =>
          Effect.suspend(() => {
            uploads++;
            return transientUpload();
          }),
        startTurn: () => Effect.die("must not send without the attachment"),
      }),
      bindings: makeBindings(turn),
    });
    const fiber = yield* core.send(turn, "/attachments").pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("1 minute");
    const failure = yield* Fiber.join(fiber);
    assert.equal(failure._tag, "GrokBotNativeAttachmentError");
    assert.equal(uploads, GROK_BOT_UPLOAD_RETRIES + 1);
  }),
);

it.effect("does not retry an upload failure that sending again cannot fix", () =>
  Effect.gen(function* () {
    const turn = yield* attachmentTurn;
    let uploads = 0;
    const core = yield* makeGrokBotManagedTurn({
      native: makeNative({
        uploadAttachments: () =>
          Effect.suspend(() => {
            uploads++;
            return Effect.fail(new NativeAttachmentError({ reason: "missing" }));
          }),
      }),
      bindings: makeBindings(turn),
    });
    yield* core.send(turn, "/attachments").pipe(Effect.flip);
    assert.equal(uploads, 1);
  }),
);
