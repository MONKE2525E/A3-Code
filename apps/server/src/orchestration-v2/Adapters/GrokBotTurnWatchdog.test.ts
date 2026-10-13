import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { RuntimeFrame } from "../../grokBot/GrokBotNativeRuntimeService.ts";
import { grokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";
import {
  GROK_BOT_BLIND_TIMEOUT_MS,
  GROK_BOT_IDLE_COMPLETE_MS,
  GROK_BOT_FRESH_IDLE_COMPLETE_MS,
  GROK_BOT_IDLE_FAIL_MS,
  GROK_BOT_RECOVERY_IDLE_CODE,
  GROK_BOT_RECOVERY_NATIVE_FAILED_CODE,
  GROK_BOT_RECOVERY_TIMEOUT_CODE,
  GROK_BOT_WATCHDOG_STARTUP_GRACE_MS,
  makeGrokBotTurnWatchdog,
} from "./GrokBotTurnWatchdog.ts";
import { makeTurn, selection } from "./GrokBotProvider.testkit.ts";

const live = (
  nowMs: number,
  state: Partial<Extract<RuntimeFrame, { _tag: "Live" }>["state"]> = {},
): RuntimeFrame => ({
  _tag: "Live",
  observedAtMs: nowMs,
  snapshot: false,
  state: { agentId: selection.model, updatedAtMs: nowMs, staleAfterMs: 90_000, ...state },
});
const MINUTE = 60_000;

const setup = Effect.gen(function* () {
  const identity = grokBotTurnIdentity(yield* makeTurn);
  const watchdog = makeGrokBotTurnWatchdog(0);
  watchdog.track(identity, 0);
  return { identity, watchdog };
});

it.effect("completes a turn only after native idle and an answer hold together", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    watchdog.observeFrame(live(0, { isRunning: false }), 0);
    watchdog.observeOutput(identity.messageId, false, 10_000);
    assert.deepEqual(watchdog.evaluate(10_000, false), []);
    assert.deepEqual(watchdog.evaluate(10_000 + GROK_BOT_IDLE_COMPLETE_MS - 1, false), []);
    assert.deepEqual(
      watchdog.evaluate(10_000 + GROK_BOT_IDLE_COMPLETE_MS, false).map((v) => v.outcome),
      ["success"],
    );
  }),
);

it.effect("quickly completes an owned answer once fresh native idle arrives after it", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    watchdog.observeOutput(identity.messageId, false, 10_000);
    watchdog.observeFrame(live(11_000, { isRunning: false }), 11_000);
    assert.deepEqual(watchdog.evaluate(11_000, false), []);
    assert.deepEqual(watchdog.evaluate(11_000 + GROK_BOT_FRESH_IDLE_COMPLETE_MS - 1, false), []);
    assert.deepEqual(
      watchdog.evaluate(11_000 + GROK_BOT_FRESH_IDLE_COMPLETE_MS, false).map((v) => v.outcome),
      ["success"],
    );
  }),
);

it.effect("fresh idle never finishes while tools, children or user input remain pending", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    watchdog.observeOutput(identity.messageId, false, 10_000);
    watchdog.observeFrame(live(11_000, { isRunning: false }), 11_000);
    const held = new Set([identity.messageId]);
    assert.deepEqual(watchdog.evaluate(20_000, false, held), []);
    assert.deepEqual(watchdog.evaluate(21_000, true), []);
    assert.deepEqual(watchdog.evaluate(22_000, false), []);
    assert.deepEqual(
      watchdog.evaluate(22_000 + GROK_BOT_FRESH_IDLE_COMPLETE_MS, false).map((v) => v.outcome),
      ["success"],
    );
  }),
);

it.effect("never reports success for a turn without an answer", () =>
  Effect.gen(function* () {
    const { watchdog } = yield* setup;
    watchdog.observeFrame(live(0, { isRunning: false }), 0);
    // The idle clock starts at the first evaluation that sees native idle.
    assert.deepEqual(watchdog.evaluate(0, false), []);
    assert.deepEqual(watchdog.evaluate(GROK_BOT_IDLE_FAIL_MS - 1, false), []);
    const [verdict] = watchdog.evaluate(GROK_BOT_IDLE_FAIL_MS, false);
    assert.equal(verdict?.outcome, "error");
    assert.equal(verdict?.code, GROK_BOT_RECOVERY_IDLE_CODE);
  }),
);

it.effect("keeps a turn alive while native reports running work, subagents, or awaited input", () =>
  Effect.gen(function* () {
    for (const state of [
      { isRunning: true },
      { isRunning: false, hasRunningSubagents: true },
      { isRunning: false, awaiting: { reason: "user_response" } },
    ]) {
      const { identity, watchdog } = yield* setup;
      watchdog.observeOutput(identity.messageId, false, 0);
      // Fresh for ten hours: a long-running tool or subagent is valid work.
      watchdog.observeFrame(live(0, { ...state, staleAfterMs: 36_000_000 }), 0);
      for (let at = 0; at <= 10 * 60 * MINUTE; at += 15 * MINUTE)
        assert.deepEqual(watchdog.evaluate(at, false), []);
    }
  }),
);

it.effect("treats expired native running state as idle, as the native client does", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    watchdog.observeOutput(identity.messageId, false, 0);
    watchdog.observeFrame(live(0, { isRunning: true }), 0);
    assert.deepEqual(watchdog.evaluate(89_000, false), []);
    // Stale at 90s, idle clock starts at the first evaluation that sees it.
    assert.deepEqual(watchdog.evaluate(91_000, false), []);
    assert.equal(
      watchdog.evaluate(91_000 + GROK_BOT_IDLE_COMPLETE_MS, false)[0]?.outcome,
      "success",
    );
  }),
);

it.effect("pauses every clock while T3 holds a pending user request", () =>
  Effect.gen(function* () {
    const { watchdog } = yield* setup;
    watchdog.observeFrame(live(0, { isRunning: false }), 0);
    assert.deepEqual(watchdog.evaluate(GROK_BOT_IDLE_FAIL_MS * 5, true), []);
    // The wait itself counts as progress, so the idle clock restarts when the request clears.
    assert.deepEqual(watchdog.evaluate(GROK_BOT_IDLE_FAIL_MS * 5 + 1, false), []);
  }),
);

it.effect("resets on owned streaming text but not on replayed history", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    watchdog.observeFrame(live(0, { isRunning: false }), 0);
    watchdog.observeOutput(identity.messageId, true, 4 * MINUTE);
    assert.deepEqual(watchdog.evaluate(GROK_BOT_IDLE_FAIL_MS, false), []);
    // Replayed rows written long ago do not push the clock forward.
    watchdog.observeFrame(
      {
        _tag: "Rows",
        generation: 0,
        replay: true,
        deletes: [],
        entries: [{ seq: "1", updatedSeq: "1", value: { timestampMs: 1000 } }],
      },
      GROK_BOT_IDLE_FAIL_MS,
    );
    assert.equal(watchdog.evaluate(2 * GROK_BOT_IDLE_FAIL_MS, false)[0]?.outcome, "error");
  }),
);

it.effect(
  "infers completion from an owned final answer and quiet when native live state is unavailable",
  () =>
    Effect.gen(function* () {
      const { identity, watchdog } = yield* setup;
      watchdog.observeOutput(identity.messageId, false, 0);
      assert.deepEqual(watchdog.evaluate(GROK_BOT_WATCHDOG_STARTUP_GRACE_MS - 1, false), []);
      assert.deepEqual(watchdog.evaluate(GROK_BOT_IDLE_COMPLETE_MS - 1, false), []);
      assert.equal(watchdog.evaluate(GROK_BOT_IDLE_COMPLETE_MS, false)[0]?.outcome, "success");
    }),
);

it.effect("times out an unobservable turn without any final answer", () =>
  Effect.gen(function* () {
    const { watchdog } = yield* setup;
    assert.deepEqual(watchdog.evaluate(GROK_BOT_BLIND_TIMEOUT_MS - 1, false), []);
    assert.equal(
      watchdog.evaluate(GROK_BOT_BLIND_TIMEOUT_MS, false)[0]?.code,
      GROK_BOT_RECOVERY_TIMEOUT_CODE,
    );
  }),
);

it.effect("unrelated live transcript updates cannot keep a finished turn thinking forever", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    watchdog.observeOutput(identity.messageId, false, 1000);
    for (const nowMs of [30_000, 60_000, 90_000, 120_000])
      watchdog.observeFrame(
        {
          _tag: "Rows",
          generation: 0,
          replay: false,
          deletes: [],
          entries: [{ seq: "2", updatedSeq: String(nowMs), value: { timestampMs: nowMs } }],
        },
        nowMs,
      );
    assert.equal(watchdog.evaluate(1000 + GROK_BOT_IDLE_COMPLETE_MS, false)[0]?.outcome, "success");
  }),
);

it.effect("streaming after a settled answer must finish before completion can be inferred", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    watchdog.observeOutput(identity.messageId, false, 1000);
    watchdog.observeOutput(identity.messageId, true, 2000);
    assert.deepEqual(watchdog.evaluate(2000 + GROK_BOT_IDLE_COMPLETE_MS, false), []);
  }),
);

it.effect("reports a native turn failure with its own code", () =>
  Effect.gen(function* () {
    const { watchdog } = yield* setup;
    watchdog.observeFrame(live(0, { isRunning: false }), 0);
    watchdog.observeFrame({ _tag: "TurnFailed" }, 1);
    watchdog.evaluate(1, false);
    assert.equal(
      watchdog.evaluate(GROK_BOT_IDLE_FAIL_MS + 1, false)[0]?.code,
      GROK_BOT_RECOVERY_NATIVE_FAILED_CODE,
    );
  }),
);

it.effect("stops judging a forgotten turn", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    watchdog.observeFrame(live(0, { isRunning: false }), 0);
    watchdog.forget(identity.messageId);
    assert.deepEqual(watchdog.evaluate(GROK_BOT_BLIND_TIMEOUT_MS, false), []);
  }),
);

it.effect("a held turn is never judged and restarts its clocks when released", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    const held = new Set([identity.messageId]);
    watchdog.observeFrame(live(0, { isRunning: false }), 0);
    watchdog.observeOutput(identity.messageId, false, 1_000);
    assert.deepEqual(watchdog.evaluate(10 * 60 * MINUTE, false, held), []);
    assert.deepEqual(watchdog.evaluate(10 * 60 * MINUTE + 1, false), []);
    assert.deepEqual(
      watchdog
        .evaluate(10 * 60 * MINUTE + 1 + GROK_BOT_IDLE_COMPLETE_MS, false)
        .map((v) => v.outcome),
      ["success"],
    );
  }),
);

it.effect("a held unobservable turn is not timed out", () =>
  Effect.gen(function* () {
    const { identity, watchdog } = yield* setup;
    const held = new Set([identity.messageId]);
    assert.deepEqual(watchdog.evaluate(3 * GROK_BOT_BLIND_TIMEOUT_MS, false, held), []);
  }),
);
