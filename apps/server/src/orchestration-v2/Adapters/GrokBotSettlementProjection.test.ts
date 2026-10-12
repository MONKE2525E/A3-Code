import { assert, it } from "@effect/vitest";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  grokBotTurnIdentity,
  makeGrokBotSettlementProjection,
} from "./GrokBotSettlementProjection.ts";
import { makeTurn, nativeSession } from "./GrokBotProvider.testkit.ts";

it.effect(
  "publishes the declared final answer before T3 completion and deduplicates native settlement",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const identity = grokBotTurnIdentity(turn);
      const projection = makeGrokBotSettlementProjection(nativeSession);
      yield* projection.register(identity);
      const declaration = {
        identity,
        source: "agent_declaration" as const,
        finalText: "The final T3 answer",
        declaredAtMs: 2000,
      };
      const events = yield* projection.projectCompletion(declaration);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["message.updated", "turn_item.updated", "provider_turn.updated", "turn.terminal"],
      );
      const message = events[0];
      const item = events[1];
      const terminal = events[3];
      if (message?.type !== "message.updated" || terminal?.type !== "turn.terminal")
        return yield* Effect.die("missing ordered T3 final answer");
      assert.equal(message.message.text, declaration.finalText);
      assert.equal(message.message.runId, identity.runId);
      assert.equal(message.message.nodeId, identity.rootNodeId);
      assert.isFalse(message.message.streaming);
      if (item?.type !== "turn_item.updated" || item.turnItem.type !== "assistant_message")
        return yield* Effect.die("missing visible managed final answer");
      assert.equal(item.turnItem.messageId, message.message.id);
      assert.equal(item.turnItem.text, declaration.finalText);
      assert.equal(item.turnItem.runId, identity.runId);
      assert.equal(item.turnItem.providerTurnId, identity.providerTurnId);
      assert.equal(item.turnItem.status, "completed");
      assert.isFalse(item.turnItem.streaming);
      assert.equal(terminal.status, "completed");
      assert.deepStrictEqual(yield* projection.projectCompletion(declaration), []);
      assert.deepStrictEqual(
        yield* projection.project({
          _tag: "Settlement",
          clientNonce: identity.messageId,
          outcome: "success",
          settledAtMs: 3000,
        }),
        [],
      );
      const reopened = makeGrokBotSettlementProjection(nativeSession);
      yield* reopened.register(identity);
      const replay = yield* reopened.projectCompletion(declaration);
      assert.deepStrictEqual(replay, events);
    }),
);

it.effect("rejects declaration ownership substitutions before publishing a final answer", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const identity = grokBotTurnIdentity(turn);
    const projection = makeGrokBotSettlementProjection(nativeSession);
    yield* projection.register(identity);
    const declaration = {
      identity: { ...identity, attemptId: RunAttemptId.make("foreign-attempt") },
      source: "agent_declaration" as const,
      finalText: "Foreign answer",
      declaredAtMs: 2000,
    };
    assert.equal(
      (yield* projection.projectCompletion(declaration).pipe(Effect.flip))._tag,
      "GrokBotBindingError",
    );
  }),
);

it.effect.each(["success", "error", "cancelled"] as const)(
  "settles only the exact registered native nonce for $0",
  (outcome) =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const projection = makeGrokBotSettlementProjection(nativeSession);
      yield* projection.register(grokBotTurnIdentity(turn));
      assert.deepEqual(
        yield* projection.project({
          _tag: "Settlement",
          clientNonce: "another-turn",
          outcome,
          settledAtMs: 2000,
        }),
        [],
      );
      const events = yield* projection.project({
        _tag: "Settlement",
        clientNonce: turn.messageId,
        outcome,
        settledAtMs: 2000,
        errorCode: "native_error",
        errorRetryable: false,
      });
      assert.equal(events.length, 2);
      const update = events[0];
      const terminal = events[1];
      if (update?.type !== "provider_turn.updated" || terminal?.type !== "turn.terminal")
        return yield* Effect.die("missing exact turn settlement");
      assert.equal(update.providerTurn.nodeId, turn.input.rootNodeId);
      assert.equal(update.providerTurn.runAttemptId, turn.input.attemptId);
      assert.equal(update.providerTurn.providerThreadId, turn.input.providerThread.id);
      assert.isNull(update.providerTurn.nativeTurnRef);
      assert.equal(terminal.providerTurnId, turn.providerTurnId);
      assert.equal(terminal.runOrdinal, turn.input.runOrdinal);
      assert.equal(
        terminal.status,
        outcome === "success" ? "completed" : outcome === "error" ? "failed" : "cancelled",
      );
      assert.deepEqual(
        yield* projection.project({
          _tag: "Settlement",
          clientNonce: turn.messageId,
          outcome,
          settledAtMs: 2000,
        }),
        [],
      );
    }),
);

it.effect("rejects cross-account correlation and nonce reuse by another attempt", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const identity = grokBotTurnIdentity(turn);
    const projection = makeGrokBotSettlementProjection(nativeSession);
    assert.equal(
      (yield* projection
        .register({ ...identity, native: { ...nativeSession, binding: "b".repeat(64) } })
        .pipe(Effect.flip))._tag,
      "GrokBotBindingError",
    );
    yield* projection.register(identity);
    assert.equal(
      (yield* projection
        .register({
          ...identity,
          runId: RunId.make("other-run"),
          attemptId: RunAttemptId.make("other-attempt"),
        })
        .pipe(Effect.flip))._tag,
      "GrokBotBindingError",
    );
  }),
);

it.effect("restores exact nonce identity without replaying the historical prompt", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const identity = grokBotTurnIdentity(turn);
    const reopened = makeGrokBotSettlementProjection(nativeSession);
    yield* reopened.register(identity);
    const events = yield* reopened.project({
      _tag: "Settlement",
      clientNonce: identity.messageId,
      outcome: "success",
      settledAtMs: 2000,
    });
    assert.equal(events.length, 2);
    assert.isFalse("mcpConfig" in identity);
    assert.isFalse("input" in identity);
  }),
);

it.effect.each(["success", "error", "cancelled"] as const)(
  "retains an accepted answer when native settlement wins, preserving native %s",
  (outcome) =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const identity = grokBotTurnIdentity(turn);
      const declaration = {
        identity,
        source: "agent_declaration" as const,
        finalText: "Accepted final",
        declaredAtMs: 1000,
      };
      const projection = makeGrokBotSettlementProjection(nativeSession, () =>
        Effect.succeed(declaration),
      );
      yield* projection.register(identity);
      const events = yield* projection.project({
        _tag: "Settlement",
        clientNonce: identity.messageId,
        outcome,
        settledAtMs: 2000,
      });
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["message.updated", "turn_item.updated", "provider_turn.updated", "turn.terminal"],
      );
      const message = events[0];
      const terminal = events[3];
      if (message?.type !== "message.updated" || terminal?.type !== "turn.terminal")
        return yield* Effect.die("Missing ordered final answer");
      assert.equal(message.message.text, declaration.finalText);
      assert.equal(
        terminal.status,
        outcome === "success" ? "completed" : outcome === "error" ? "failed" : "cancelled",
      );
      assert.deepStrictEqual(yield* projection.projectCompletion(declaration), []);
    }),
);

it.effect("recovery fails a never-completed turn once and refuses a later declaration", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const identity = grokBotTurnIdentity(turn);
    const projection = makeGrokBotSettlementProjection(nativeSession);
    yield* projection.register(identity);
    const events = yield* projection.recover({
      identity,
      outcome: "error",
      code: "completion_inactivity_timeout",
      settledAtMs: 5000,
    });
    const terminal = events.find((event) => event.type === "turn.terminal");
    if (terminal?.type !== "turn.terminal" || terminal.status !== "failed")
      return yield* Effect.die("missing failed recovery terminal");
    assert.equal(terminal.failure?.code, "completion_inactivity_timeout");
    assert.equal(
      terminal.failure?.message,
      "The Grok Bot showed no activity and never finished this T3 turn.",
    );
    assert.isTrue(projection.isSettled(identity.messageId));
    assert.deepEqual(
      yield* projection.recover({ identity, outcome: "success", settledAtMs: 6000 }),
      [],
    );
    assert.deepEqual(
      yield* projection.projectCompletion({
        identity,
        source: "agent_declaration",
        finalText: "too late",
        declaredAtMs: 7000,
      }),
      [],
    );
  }),
);

it.effect("recovery completes with the declared answer when a declaration exists", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const identity = grokBotTurnIdentity(turn);
    const projection = makeGrokBotSettlementProjection(nativeSession, () =>
      Effect.succeed({
        identity,
        source: "agent_declaration" as const,
        finalText: "declared answer",
        declaredAtMs: 4000,
      }),
    );
    yield* projection.register(identity);
    const events = yield* projection.recover({
      identity,
      outcome: "error",
      code: "native_idle_without_completion",
      settledAtMs: 5000,
    });
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["message.updated", "turn_item.updated", "provider_turn.updated", "turn.terminal"],
    );
    const terminal = events[3];
    assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
  }),
);

it.effect("recovery of an unregistered or other-run nonce does nothing", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const identity = grokBotTurnIdentity(turn);
    const projection = makeGrokBotSettlementProjection(nativeSession);
    assert.deepEqual(
      yield* projection.recover({ identity, outcome: "success", settledAtMs: 1 }),
      [],
    );
  }),
);
