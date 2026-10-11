import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Runtime from "./GrokBotNativeRuntimeService.ts";
import * as Secret from "./GrokBotSecretService.ts";
import type { GrokBotSecretRequest } from "./GrokBotSecretRequest.ts";

const input = { botId: "bot-1", sessionId: "s", entryId: "e1", value: "hunter2" };
const pendingRequest = {
  entryId: "e1",
  title: "OpenAI API key",
  description: undefined,
  state: "pending",
} as const;
const run = <A, E>(
  runtime: Partial<Runtime.GrokBotNativeRuntimeService["Service"]>,
  effect: Effect.Effect<A, E, Secret.GrokBotSecretService>,
) =>
  effect.pipe(
    Effect.provide(
      Secret.layer.pipe(Layer.provide(Layer.mock(Runtime.GrokBotNativeRuntimeService)(runtime))),
    ),
  );

it.effect("binds the submission to the account, bot and an existing pending request", () => {
  const seen: unknown[] = [];
  const reads: unknown[] = [];
  return run(
    {
      accountBinding: Effect.succeed("account-1"),
      secretRequests: (owner) =>
        Effect.sync(() => {
          reads.push(owner);
          return [pendingRequest];
        }),
      submitSecret: (request) =>
        Effect.sync(() => {
          seen.push({ ...request, value: Redacted.value(request.value) });
          assert.notInclude(String(request.value), "hunter2");
        }),
    },
    Effect.gen(function* () {
      const result = yield* (yield* Secret.GrokBotSecretService).submit(input);
      assert.deepStrictEqual(result, { accepted: true });
      assert.notInclude(JSON.stringify(result), "hunter2");
      assert.deepStrictEqual(reads, [{ binding: "account-1", botId: "bot-1", sessionId: "s" }]);
      assert.deepStrictEqual(seen, [{ binding: "account-1", ...input }]);
    }),
  );
});

it.effect("never writes to an entry that is not a pending request of that bot and session", () => {
  let submitted = 0;
  const base = {
    accountBinding: Effect.succeed("account-1"),
    submitSecret: () => Effect.sync(() => void (submitted += 1)),
  };
  return Effect.gen(function* () {
    const missing = yield* run(
      { ...base, secretRequests: () => Effect.succeed([]) },
      Secret.GrokBotSecretService.pipe(
        Effect.flatMap((service) => service.submit(input)),
        Effect.flip,
      ),
    );
    assert.strictEqual(missing.reason, "request_not_found");
    const answered = yield* run(
      {
        ...base,
        secretRequests: () => Effect.succeed([{ ...pendingRequest, state: "responded" }]),
      },
      Secret.GrokBotSecretService.pipe(
        Effect.flatMap((service) => service.submit(input)),
        Effect.flip,
      ),
    );
    assert.strictEqual(answered.reason, "already_answered");
    const other = yield* run(
      { ...base, secretRequests: () => Effect.succeed([{ ...pendingRequest, entryId: "e2" }]) },
      Secret.GrokBotSecretService.pipe(
        Effect.flatMap((service) => service.submit(input)),
        Effect.flip,
      ),
    );
    assert.strictEqual(other.reason, "request_not_found");
    assert.strictEqual(submitted, 0);
    for (const failure of [missing, answered, other])
      assert.notInclude(JSON.stringify(failure), "hunter2");
  });
});

it.effect("maps native failures to bounded errors without the value", () =>
  run(
    {
      accountBinding: Effect.succeed("account-1"),
      secretRequests: () => Effect.succeed([pendingRequest]),
      submitSecret: () => Effect.fail(new Runtime.NativeRuntimeError({ kind: "refused" })),
    },
    Effect.gen(function* () {
      const failure = yield* (yield* Secret.GrokBotSecretService).submit(input).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "refused");
      assert.notInclude(JSON.stringify(failure), "hunter2");
    }),
  ),
);

it.effect("does not read or submit without an account binding", () => {
  let called = false;
  const mark = () => Effect.sync(() => void (called = true));
  return run(
    {
      accountBinding: Effect.fail(new Runtime.NativeRuntimeError({ kind: "refused" })) as never,
      secretRequests: () => mark().pipe(Effect.as([])),
      submitSecret: mark,
    },
    Effect.gen(function* () {
      const service = yield* Secret.GrokBotSecretService;
      const failure = yield* service.submit(input).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "account_unavailable");
      const read = yield* service.pending({ botId: "bot-1", sessionId: "s" }).pipe(Effect.flip);
      assert.strictEqual(read.reason, "account_unavailable");
      assert.strictEqual(called, false);
    }),
  );
});

it.effect("lists pending requests with only id, session, title, description and state", () =>
  run(
    {
      accountBinding: Effect.succeed("account-1"),
      secretRequests: () =>
        Effect.succeed([
          { ...pendingRequest, description: "Used for the API" },
          { entryId: "e2", title: "Token", description: undefined, state: "responded" },
        ]),
    },
    Effect.gen(function* () {
      const result = yield* (yield* Secret.GrokBotSecretService).pending({
        botId: "bot-1",
        sessionId: "s",
      });
      assert.deepStrictEqual(result, {
        requests: [
          {
            entryId: "e1",
            sessionId: "s",
            title: "OpenAI API key",
            description: "Used for the API",
            state: "pending",
          },
          { entryId: "e2", sessionId: "s", title: "Token", state: "responded" },
        ],
      });
    }),
  ),
);

it.effect("reports dismissal unsupported without sending anything to native", () => {
  let sent = 0;
  return run(
    {
      accountBinding: Effect.succeed("account-1"),
      secretRequests: () => Effect.succeed([pendingRequest]),
      dismissWidget: () => Effect.sync(() => void (sent += 1)).pipe(Effect.as({})),
      submitSecret: () => Effect.sync(() => void (sent += 1)),
    },
    Effect.gen(function* () {
      const failure = yield* (yield* Secret.GrokBotSecretService)
        .dismiss({ botId: "bot-1", sessionId: "s", entryId: "e1" })
        .pipe(Effect.flip);
      assert.strictEqual(failure.reason, "unsupported");
      assert.strictEqual(sent, 0);
    }),
  );
});

it.effect("dismiss still reports a request that is not pending for that bot and session", () => {
  const dismiss = (requests: ReadonlyArray<GrokBotSecretRequest>) =>
    run(
      {
        accountBinding: Effect.succeed("account-1"),
        secretRequests: () => Effect.succeed(requests),
      },
      Secret.GrokBotSecretService.pipe(
        Effect.flatMap((service) =>
          service.dismiss({ botId: "bot-1", sessionId: "s", entryId: "e1" }),
        ),
        Effect.flip,
      ),
    );
  return Effect.gen(function* () {
    assert.strictEqual(
      (yield* dismiss([{ ...pendingRequest, state: "responded" }])).reason,
      "already_answered",
    );
    assert.strictEqual((yield* dismiss([])).reason, "request_not_found");
  });
});

it.effect(
  "reports an already-answered request, not a delivery failure, when the reply was lost",
  () => {
    // The first read sees the request pending; after the write, native shows it answered.
    let reads = 0;
    return run(
      {
        accountBinding: Effect.succeed("account-1"),
        secretRequests: () =>
          Effect.sync(() => {
            reads += 1;
            return [
              reads === 1 ? pendingRequest : { ...pendingRequest, state: "responded" as const },
            ];
          }),
        submitSecret: () => Effect.fail(new Runtime.NativeRuntimeError({ kind: "uncertain" })),
      },
      Effect.gen(function* () {
        const failure = yield* (yield* Secret.GrokBotSecretService).submit(input).pipe(Effect.flip);
        assert.strictEqual(failure.reason, "already_answered");
        assert.notInclude(JSON.stringify(failure), "hunter2");
      }),
    );
  },
);

it.effect("keeps a write that is still pending afterwards as a retryable delivery failure", () =>
  run(
    {
      accountBinding: Effect.succeed("account-1"),
      secretRequests: () => Effect.succeed([pendingRequest]),
      submitSecret: () => Effect.fail(new Runtime.NativeRuntimeError({ kind: "uncertain" })),
    },
    Effect.gen(function* () {
      const failure = yield* (yield* Secret.GrokBotSecretService).submit(input).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "unavailable");
    }),
  ),
);

it.effect("keeps a native refusal as refused when the request is still pending", () =>
  run(
    {
      accountBinding: Effect.succeed("account-1"),
      secretRequests: () => Effect.succeed([pendingRequest]),
      submitSecret: () => Effect.fail(new Runtime.NativeRuntimeError({ kind: "refused" })),
    },
    Effect.gen(function* () {
      const failure = yield* (yield* Secret.GrokBotSecretService).submit(input).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "refused");
    }),
  ),
);
