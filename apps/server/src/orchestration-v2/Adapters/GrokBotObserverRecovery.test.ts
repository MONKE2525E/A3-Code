import { assert, it } from "@effect/vitest";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { NativeReadError, NativeSignedOutError } from "../../grokBot/GrokBotNativeService.ts";
import {
  GrokBotNativeRuntimeService,
  NativeRuntimeError,
  type RuntimeError,
  type RuntimeFrame,
  type SettlementFrame,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import { createGrokBotAdapterV2 } from "./GrokBotAdapterV2.ts";
import { GrokBotManagedBinding } from "./GrokBotManagedBinding.ts";
import { grokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";
import {
  accountBinding,
  makeBindings,
  makeNative,
  makeTurn,
  nativeSession,
  options,
  policy,
  providerSessionId,
  rows,
  selection,
  threadId,
} from "./GrokBotProvider.testkit.ts";

const input = { threadId, providerSessionId, modelSelection: selection, runtimePolicy: policy };
const fixture = Effect.fnUntraced(function* (
  restored = false,
  overrides: Partial<GrokBotNativeRuntimeService["Service"]> = {},
) {
  const turn = yield* makeTurn;
  const opened = yield* Queue.unbounded<number>();
  const watches = yield* Effect.forEach([0, 1, 2, 3], () =>
    Queue.unbounded<RuntimeFrame, RuntimeError | Cause.Done>(),
  );
  const closed = yield* Queue.unbounded<number>();
  let binding = accountBinding;
  let sends = 0;
  let calls = 0;
  const generations: number[] = [];
  const native = makeNative({
    accountBinding: Effect.sync(() => binding),
    watch: (cursor) =>
      Stream.unwrap(
        Effect.gen(function* () {
          assert.deepEqual(cursor, {
            ...nativeSession,
            generation: cursor.generation,
            afterUpdatedSeq: "0",
          });
          generations.push(cursor.generation);
          const index = calls++;
          yield* Queue.offer(opened, index);
          return Stream.fromQueue(watches[index]!).pipe(
            Stream.ensuring(Queue.offer(closed, index)),
          );
        }),
      ),
    startTurn: () =>
      Effect.sync(() => {
        sends++;
        return { delivery: "accepted" as const };
      }),
    sendStatus: () => Effect.succeed({ status: "accepted" }),
    ...overrides,
  });
  const adapter = yield* createGrokBotAdapterV2(options).pipe(
    Effect.provideService(GrokBotNativeRuntimeService, native),
    Effect.provideService(
      GrokBotManagedBinding,
      makeBindings(turn, {
        restoreTurns: () => Effect.succeed(restored ? [grokBotTurnIdentity(turn)] : []),
        availability: Effect.succeed(
          restored ? { ready: false, reason: "relay starting" } : { ready: true },
        ),
      }),
    ),
  );
  const session = yield* adapter.openSession(input);
  assert.equal(yield* Queue.take(opened), 0);
  return {
    session,
    turn,
    watches,
    opened,
    closed,
    changeAccount: () => {
      binding = "b".repeat(64);
    },
    sends: () => sends,
    calls: () => calls,
    generations,
  };
});

it.effect.each(["clean close", "transient read"] as const)(
  "replays after %s without duplicate rows or accepted delivery sends",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* fixture(true);
      const thread = yield* h.session.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: policy,
        existingProviderThread: h.turn.input.providerThread,
      });
      yield* h.session.startTurn({ ...h.turn.input, providerThread: thread });
      const messages = yield* Queue.unbounded<string>();
      yield* h.session.events.pipe(
        Stream.runForEach((event) =>
          event.type === "message.updated"
            ? Queue.offer(messages, event.message.text)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Queue.offer(h.watches[0]!, rows("1", "first"));
      assert.equal(yield* Queue.take(messages), "first");
      if (kind === "clean close") yield* Queue.end(h.watches[0]!);
      else
        yield* Queue.fail(
          h.watches[0]!,
          new NativeReadError({ stage: "response", transient: true }),
        );
      assert.equal(yield* Queue.take(h.closed), 0);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Queue.take(h.opened), 1);
      yield* Queue.offer(h.watches[1]!, rows("1", "first"));
      yield* Queue.offer(h.watches[1]!, rows("2", "second"));
      assert.equal(yield* Queue.take(messages), "second");
      assert.equal(h.sends(), 0);
      const mismatch = yield* Effect.result(
        h.session.startTurn({ ...h.turn.input, providerThread: thread, providerTurnOrdinal: 2 }),
      );
      assert.equal(mismatch._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("renews an idle watch at its advertised lifetime and closes the previous read", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    yield* Queue.offer(h.watches[0]!, {
      _tag: "Connected",
      streamId: "fixture",
      absoluteLifetimeMs: 60000,
    });
    yield* TestClock.adjust("54 seconds");
    assert.equal(yield* Queue.take(h.closed), 0);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Queue.take(h.opened), 1);
    assert.equal(h.sends(), 0);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect.each(["clean close", "transient read"] as const)(
  "bounds consecutive short watches after %s",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const result = yield* h.session.events.pipe(
        Stream.runDrain,
        Effect.result,
        Effect.forkScoped,
      );
      for (let i = 0; i < 4; i++) {
        if (kind === "clean close") yield* Queue.end(h.watches[i]!);
        else
          yield* Queue.fail(
            h.watches[i]!,
            new NativeReadError({ stage: "request", transient: true }),
          );
        assert.equal(yield* Queue.take(h.closed), i);
        if (i < 3) {
          yield* TestClock.adjust(`${i + 1} seconds`);
          assert.equal(yield* Queue.take(h.opened), i + 1);
        }
      }
      const exit = yield* Fiber.join(result);
      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure")
        assert.deepEqual(exit.failure.cause, new NativeRuntimeError({ kind: "uncertain" }));
      assert.equal(h.calls(), 4);
      assert.equal(h.sends(), 0);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect.each([
  new NativeSignedOutError({}),
  new NativeReadError({ stage: "response" }),
  new NativeReadError({ stage: "request", status: 403 }),
  new NativeRuntimeError({ kind: "response" }),
])("keeps non-transient failure fatal: %s", (error) =>
  Effect.gen(function* () {
    const h = yield* fixture();
    yield* Queue.fail(h.watches[0]!, error);
    const result = yield* h.session.events.pipe(Stream.runDrain, Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.deepEqual(result.failure.cause, error);
    assert.equal(h.calls(), 1);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("ends recovery when the immutable account binding changes", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    yield* Queue.end(h.watches[0]!);
    yield* Queue.take(h.closed);
    h.changeAccount();
    yield* TestClock.adjust("1 second");
    const result = yield* h.session.events.pipe(Stream.runDrain, Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.equal(result.failure._tag, "ProviderAdapterEventStreamError");
    assert.equal(h.calls(), 1);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("scope cancellation stops pending reattachment", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const h = yield* fixture().pipe(Effect.provideService(Scope.Scope, scope));
    yield* Queue.end(h.watches[0]!);
    yield* Queue.take(h.closed);
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust("10 seconds");
    assert.equal(h.calls(), 1);
    assert.equal(h.sends(), 0);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("projection resync failures remain fatal without reopening the read", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    yield* Queue.offer(h.watches[0]!, {
      _tag: "Rows",
      generation: 0,
      replay: false,
      deletes: [{ seq: "1", updatedSeq: "1" }],
      entries: [],
    });
    const result = yield* h.session.events.pipe(Stream.runDrain, Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(h.calls(), 1);
    assert.equal(h.sends(), 0);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect.each(["clean close", "transient read"] as const)(
  "recovers gateway %s and deduplicates settlement snapshot replay",
  (kind) =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<SettlementFrame, RuntimeError | Cause.Done>();
      const reopened = yield* Deferred.make<void>();
      const replayed = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      let opens = 0;
      const turn = yield* makeTurn;
      const settlement: SettlementFrame = {
        _tag: "Settlement",
        clientNonce: turn.messageId,
        outcome: "success",
        settledAtMs: 1234,
      };
      const h = yield* fixture(true, {
        openSettlementWatch: (owned) =>
          Effect.sync(() => {
            assert.deepEqual(owned, nativeSession);
            opens++;
            return {
              events:
                opens === 1
                  ? Stream.fromQueue(queue).pipe(
                      Stream.ensuring(Deferred.succeed(closed, undefined)),
                    )
                  : Stream.fromEffect(
                      Deferred.succeed(reopened, undefined).pipe(Effect.as(settlement)),
                    ).pipe(
                      Stream.concat(
                        Stream.fromEffect(Deferred.succeed(replayed, undefined)).pipe(Stream.drain),
                      ),
                      Stream.concat(Stream.never),
                    ),
            };
          }),
      });
      const terminals: string[] = [];
      const firstTerminal = yield* Deferred.make<void>();
      yield* h.session.events.pipe(
        Stream.runForEach((event) => {
          if (event.type !== "turn.terminal") return Effect.void;
          terminals.push(event.type);
          return Deferred.succeed(firstTerminal, undefined);
        }),
        Effect.forkScoped,
      );
      yield* Queue.offer(queue, settlement);
      yield* Deferred.await(firstTerminal);
      if (kind === "clean close") yield* Queue.end(queue);
      else yield* Queue.fail(queue, new NativeReadError({ stage: "response", transient: true }));
      yield* Deferred.await(closed);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(reopened);
      yield* Deferred.await(replayed);
      yield* TestClock.adjust("0 seconds");
      assert.equal(opens, 2);
      assert.deepEqual(terminals, ["turn.terminal"]);
      assert.equal(h.sends(), 0);
      assert.equal(h.calls(), 1);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("reconnects at the successfully projected native generation", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    yield* Queue.offer(h.watches[0]!, { _tag: "Cleared", generation: 5 });
    const row = rows("1", "first");
    if (row._tag !== "Rows") return yield* Effect.die("Expected row fixture");
    yield* Queue.offer(h.watches[0]!, { ...row, generation: 5 });
    const first = yield* h.session.events.pipe(
      Stream.filter((event) => event.type === "message.updated"),
      Stream.take(1),
      Stream.runCollect,
    );
    assert.equal(first.length, 1);
    yield* Queue.end(h.watches[0]!);
    yield* Queue.take(h.closed);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Queue.take(h.opened), 1);
    assert.deepEqual(h.generations, [0, 5]);
    yield* Queue.offer(h.watches[1]!, {
      ...row,
      generation: 5,
      entries: [
        {
          ...row.entries[0]!,
          updatedSeq: "2",
          value: {
            id: "assistant-1",
            kind: "send-message",
            message: { type: "text", content: "second" },
            isStreaming: true,
          },
        },
      ],
    });
    const second = yield* h.session.events.pipe(
      Stream.filter((event) => event.type === "message.updated"),
      Stream.take(1),
      Stream.runCollect,
    );
    assert.equal(second[0]?.type === "message.updated" ? second[0].message.text : "", "second");
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("a healthy idle attachment resets prior transient failure backoff", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    yield* Queue.fail(h.watches[0]!, new NativeReadError({ stage: "response", transient: true }));
    yield* Queue.take(h.closed);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Queue.take(h.opened), 1);
    yield* TestClock.adjust("30 seconds");
    yield* Queue.end(h.watches[1]!);
    yield* Queue.take(h.closed);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Queue.take(h.opened), 2);
    assert.equal(h.sends(), 0);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);
