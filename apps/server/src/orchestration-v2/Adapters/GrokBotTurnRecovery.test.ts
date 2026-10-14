import { assert, it } from "@effect/vitest";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  GrokBotNativeRuntimeService,
  type RuntimeFrame,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import { createGrokBotAdapterV2 } from "./GrokBotAdapterV2.ts";
import {
  GrokBotBindingError,
  GrokBotManagedBinding,
  type GrokBotManagedTurn,
} from "./GrokBotManagedBinding.ts";
import {
  makeBindings,
  makeNative,
  makeTurn,
  options,
  policy,
  providerSessionId,
  selection,
  threadId,
} from "./GrokBotProvider.testkit.ts";
import { grokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";

const sessionInput = {
  threadId,
  providerSessionId,
  modelSelection: selection,
  runtimePolicy: policy,
};
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const idle: RuntimeFrame = {
  _tag: "Live",
  observedAtMs: 0,
  snapshot: true,
  state: { agentId: selection.model, isRunning: false, updatedAtMs: 0, staleAfterMs: 90_000 },
};
const echoRow = (nonce: string) => ({
  seq: "1",
  updatedSeq: "1",
  value: {
    id: "echo",
    kind: "message",
    role: "user",
    content: "do it",
    clientNonce: nonce,
    requestId: "request-1",
    timestampMs: 500,
  },
});
const answerRow = {
  seq: "2",
  updatedSeq: "2",
  value: {
    id: "answer",
    kind: "send-message",
    message: { type: "text", content: "Here is the result" },
    requestId: "request-1",
    timestampMs: 900,
  },
};
const history = (nonce: string, withAnswer: boolean): RuntimeFrame => ({
  _tag: "Rows",
  generation: 0,
  replay: true,
  deletes: [],
  entries: withAnswer ? [echoRow(nonce), answerRow] : [echoRow(nonce)],
});

/** A persisted turn the host restored after restart; native replays its history and live state. */
const openRestored = (
  turn: GrokBotManagedTurn,
  frames: readonly RuntimeFrame[],
  binding: Partial<GrokBotManagedBinding["Service"]> = {},
) =>
  Effect.gen(function* () {
    const identity = grokBotTurnIdentity(turn);
    const adapter = yield* createGrokBotAdapterV2(options).pipe(
      Effect.provideService(
        GrokBotNativeRuntimeService,
        makeNative({
          watch: () => Stream.fromIterable(frames).pipe(Stream.concat(Stream.never)),
        }),
      ),
      Effect.provideService(
        GrokBotManagedBinding,
        makeBindings(turn, {
          restoreManagedMessageIds: () => Effect.succeed([turn.messageId]),
          restoreTranscriptTurns: () => Effect.succeed([identity]),
          restoreTurns: () => Effect.succeed([identity]),
          ...binding,
        }),
      ),
    );
    const session = yield* adapter.openSession(sessionInput);
    const seen = yield* Ref.make<readonly string[]>([]);
    const terminals = yield* Ref.make<readonly { status: string; code: string | null }[]>([]);
    yield* session.events.pipe(
      Stream.runForEach((event) =>
        Ref.update(seen, (all) => [...all, event.type]).pipe(
          Effect.andThen(
            event.type === "turn.terminal"
              ? Ref.update(terminals, (all) => [
                  ...all,
                  { status: event.status, code: event.failure?.code ?? null },
                ])
              : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );
    return { seen, terminals };
  });
const advance = (ms: number) =>
  Effect.forEach(
    Array.from({ length: ms / (15 * SECOND) }),
    () => TestClock.adjust(Duration.millis(15 * SECOND)),
    { discard: true },
  );

it.effect("settles a native final reply without complete_turn or native live state", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const { terminals } = yield* openRestored(turn, [history(turn.messageId, true)]);
    yield* advance(3 * MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), [{ status: "completed", code: null }]);
    yield* advance(3 * MINUTE);
    assert.lengthOf(yield* Ref.get(terminals), 1);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("completes a restored stale turn once native is idle and its answer is delivered", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const { terminals } = yield* openRestored(turn, [idle, history(turn.messageId, true)]);
    yield* advance(2 * MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), []);
    yield* advance(MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), [{ status: "completed", code: null }]);
    yield* advance(10 * MINUTE);
    assert.lengthOf(yield* Ref.get(terminals), 1);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("fails, never succeeds, a restored turn that went idle without answering", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const { terminals } = yield* openRestored(turn, [idle, history(turn.messageId, false)]);
    yield* advance(5 * MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), []);
    yield* advance(MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), [
      { status: "failed", code: "native_idle_without_completion" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("leaves a turn alone while native keeps reporting running work", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const running: RuntimeFrame = {
      ...idle,
      state: { ...idle.state, isRunning: true, staleAfterMs: 4 * 60 * MINUTE },
    } as RuntimeFrame;
    const { terminals } = yield* openRestored(turn, [running, history(turn.messageId, true)]);
    yield* advance(3 * 60 * MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), []);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("times out an unobservable turn only after sustained total silence", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const { terminals } = yield* openRestored(turn, [history(turn.messageId, false)]);
    yield* advance(59 * MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), []);
    yield* advance(2 * MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), [
      { status: "failed", code: "completion_inactivity_timeout" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("a declaration accepted before the verdict wins and completes exactly once", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const identity = grokBotTurnIdentity(turn);
    const declared = yield* Ref.make(false);
    const { seen, terminals } = yield* openRestored(turn, [idle, history(turn.messageId, false)], {
      lookupCompletion: () =>
        Ref.get(declared).pipe(
          Effect.map((yes) =>
            yes
              ? {
                  identity,
                  source: "agent_declaration" as const,
                  finalText: "late but real",
                  declaredAtMs: 1,
                }
              : undefined,
          ),
        ),
    });
    yield* advance(4 * MINUTE);
    yield* Ref.set(declared, true);
    yield* advance(10 * MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), [{ status: "completed", code: null }]);
    assert.equal((yield* Ref.get(seen)).filter((type) => type === "message.updated").length, 1);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("does not settle a turn when the account or binding guard rejects the lookup", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const { terminals } = yield* openRestored(turn, [idle, history(turn.messageId, true)], {
      lookupCompletion: () =>
        Effect.fail(new GrokBotBindingError({ reason: "The selected account changed." })),
    });
    yield* advance(20 * MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), []);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect(
  "does not credit an answer lacking the turn's request id: foreign output fails safely",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const { requestId: _requestId, ...value } = answerRow.value;
      const foreign: RuntimeFrame = {
        _tag: "Rows",
        generation: 0,
        replay: true,
        deletes: [],
        entries: [echoRow(turn.messageId), { ...answerRow, value }],
      };
      const { terminals } = yield* openRestored(turn, [idle, foreign]);
      yield* advance(6 * MINUTE);
      assert.deepEqual(yield* Ref.get(terminals), [
        { status: "failed", code: "native_idle_without_completion" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect(
  "never settles while a managed tool or blocking delegate wait is in flight past every deadline",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const inFlight = yield* Ref.make(true);
      const { terminals } = yield* openRestored(turn, [idle, history(turn.messageId, true)], {
        inFlightWork: () => Ref.get(inFlight),
      });
      yield* advance(90 * MINUTE);
      assert.deepEqual(yield* Ref.get(terminals), []);
      // Work finishes: the clocks restart from the release, then the normal rule applies.
      yield* Ref.set(inFlight, false);
      yield* advance(3 * MINUTE);
      assert.deepEqual(yield* Ref.get(terminals), [{ status: "completed", code: null }]);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("a declaration landing as the verdict is reached is honoured once, not overwritten", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const identity = grokBotTurnIdentity(turn);
    const { terminals } = yield* openRestored(turn, [idle, history(turn.messageId, true)], {
      lookupCompletion: () =>
        Effect.succeed({
          identity,
          source: "agent_declaration" as const,
          finalText: "declared",
          declaredAtMs: 1,
        }),
    });
    yield* advance(10 * MINUTE);
    assert.deepEqual(yield* Ref.get(terminals), [{ status: "completed", code: null }]);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);
