import type { RuntimeFrame } from "../../grokBot/GrokBotNativeRuntimeService.ts";
import type { GrokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";

/** Evaluation cadence. Verdict latency is at most one interval past each threshold. */
export const GROK_BOT_WATCHDOG_INTERVAL_MS = 5_000;
/** After attach, native live state may still be on its way. Do not judge a restored turn before it. */
export const GROK_BOT_WATCHDOG_STARTUP_GRACE_MS = 60_000;
/** Native idle plus a settled answer must hold this long before the turn completes. */
export const GROK_BOT_IDLE_COMPLETE_MS = 120_000;
/** A fresh idle observation after the answer needs only a short quiet period. */
export const GROK_BOT_FRESH_IDLE_COMPLETE_MS = 5_000;
/** Native idle with no answer must hold this long before the turn fails. */
export const GROK_BOT_IDLE_FAIL_MS = 300_000;
/** Without native live state or a final answer, sustained silence this long fails the turn. */
export const GROK_BOT_BLIND_TIMEOUT_MS = 3_600_000;
/** The official client's default when a live record names no stale window. */
const NATIVE_LIVE_STALE_MS = 90_000;

export const GROK_BOT_RECOVERY_IDLE_CODE = "native_idle_without_completion";
export const GROK_BOT_RECOVERY_TIMEOUT_CODE = "completion_inactivity_timeout";
export const GROK_BOT_RECOVERY_NATIVE_FAILED_CODE = "native_turn_failed";

export interface GrokBotWatchdogVerdict {
  readonly identity: GrokBotTurnIdentity;
  /** Success requires an owned final answer and sustained native idle or silence. */
  readonly outcome: "success" | "error";
  readonly code?: string;
}

interface Tracked {
  readonly identity: GrokBotTurnIdentity;
  lastProgressAtMs: number;
  idleSinceMs: number | undefined;
  outputSeen: boolean;
  answerAtMs: number | undefined;
  failedCode: string | undefined;
}

const millis = (value: string | number | undefined) => {
  const number = value === undefined ? 0 : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

/**
 * Decides when a managed turn that never called grok_bot_complete_turn is over.
 *
 * Pure bookkeeping: the adapter feeds it native frames, owned answer rows, and a clock, and applies
 * the verdicts through the settlement projection. A turn is busy, and its clocks reset, while native
 * reports running work, subagents, or an awaited user response, or while T3 holds a pending request.
 * Otherwise its fate depends on whether native live state is observable at all.
 */
export const makeGrokBotTurnWatchdog = (openedAtMs: number) => {
  const tracked = new Map<string, Tracked>();
  let live:
    | { readonly running: boolean; readonly staleAtMs: number; readonly observedAtMs: number }
    | undefined;

  const track = (identity: GrokBotTurnIdentity, nowMs: number) => {
    if (tracked.has(identity.messageId)) return;
    tracked.set(identity.messageId, {
      identity,
      lastProgressAtMs: nowMs,
      idleSinceMs: undefined,
      outputSeen: false,
      answerAtMs: undefined,
      failedCode: undefined,
    });
  };
  const forget = (messageId: string) => {
    tracked.delete(messageId);
  };
  const observeFrame = (frame: RuntimeFrame, _nowMs: number) => {
    switch (frame._tag) {
      case "Live": {
        const state = frame.state;
        const awaiting = state.awaiting !== undefined;
        live = {
          observedAtMs: frame.observedAtMs,
          running:
            state.isRunning === true ||
            state.hasRunningSubagents === true ||
            state.isComposingMessage === true ||
            awaiting,
          staleAtMs:
            (millis(state.updatedAtMs) || frame.observedAtMs) +
            (millis(state.staleAfterMs) || NATIVE_LIVE_STALE_MS),
        };
        return;
      }
      case "TurnFailed":
        for (const turn of tracked.values()) turn.failedCode = GROK_BOT_RECOVERY_NATIVE_FAILED_CODE;
        return;
      // Transcript traffic includes other turns, calls, and replayed history.
      // Only the projection's correlated output callback advances a turn.
      case "Rows":
        return;
      default:
        return;
    }
  };
  /** An answer row carrying this turn's own request id (position in the transcript is not ownership). Streaming text is progress, not an answer. */
  const observeOutput = (messageId: string, streaming: boolean, nowMs: number) => {
    const turn = tracked.get(messageId);
    if (turn === undefined) return;
    turn.lastProgressAtMs = Math.max(turn.lastProgressAtMs, nowMs);
    if (!streaming) {
      turn.outputSeen = true;
      turn.answerAtMs = nowMs;
    } else {
      turn.outputSeen = false;
      turn.answerAtMs = undefined;
      turn.idleSinceMs = undefined;
    }
  };
  /**
   * `held` names turns with work T3 can see in flight (managed MCP tool), which is
   * never judged even when native looks idle. `awaitingInput` holds every turn.
   */
  const evaluate = (
    nowMs: number,
    awaitingInput: boolean,
    held: ReadonlySet<string> = new Set(),
  ): GrokBotWatchdogVerdict[] => {
    const verdicts: GrokBotWatchdogVerdict[] = [];
    const nativeBusy = live !== undefined && live.running && nowMs < live.staleAtMs;
    for (const turn of tracked.values()) {
      if (awaitingInput || nativeBusy || held.has(turn.identity.messageId)) {
        turn.lastProgressAtMs = nowMs;
        turn.idleSinceMs = undefined;
        continue;
      }
      if (live === undefined) {
        if (nowMs - openedAtMs < GROK_BOT_WATCHDOG_STARTUP_GRACE_MS) continue;
        if (
          turn.outputSeen &&
          turn.failedCode === undefined &&
          nowMs - turn.lastProgressAtMs >= GROK_BOT_IDLE_COMPLETE_MS
        ) {
          verdicts.push({ identity: turn.identity, outcome: "success" });
          continue;
        }
        if (nowMs - turn.lastProgressAtMs >= GROK_BOT_BLIND_TIMEOUT_MS)
          verdicts.push({
            identity: turn.identity,
            outcome: "error",
            code: turn.failedCode ?? GROK_BOT_RECOVERY_TIMEOUT_CODE,
          });
        continue;
      }
      turn.idleSinceMs ??= nowMs;
      const idleForMs = nowMs - Math.max(turn.idleSinceMs, turn.lastProgressAtMs);
      if (turn.outputSeen && turn.failedCode === undefined) {
        const freshIdleAfterAnswer =
          !live.running &&
          nowMs < live.staleAtMs &&
          turn.answerAtMs !== undefined &&
          live.observedAtMs >= turn.answerAtMs;
        if (
          idleForMs >=
          (freshIdleAfterAnswer ? GROK_BOT_FRESH_IDLE_COMPLETE_MS : GROK_BOT_IDLE_COMPLETE_MS)
        )
          verdicts.push({ identity: turn.identity, outcome: "success" });
      } else if (idleForMs >= GROK_BOT_IDLE_FAIL_MS)
        verdicts.push({
          identity: turn.identity,
          outcome: "error",
          code: turn.failedCode ?? GROK_BOT_RECOVERY_IDLE_CODE,
        });
    }
    return verdicts;
  };
  return {
    track,
    forget,
    observeFrame,
    observeOutput,
    evaluate,
    pending: () => [...tracked.values()].map((turn) => turn.identity),
  };
};
