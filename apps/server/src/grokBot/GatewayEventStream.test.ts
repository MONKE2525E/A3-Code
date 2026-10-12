import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Gateway from "./GatewayEventStream.ts";
import * as Settlement from "./GatewaySettlement.ts";

it.effect(
  "decodes split SSE CRLF/data lines and ignores comments without exposing unrelated payloads",
  () =>
    Effect.gen(function* () {
      const text =
        ': heartbeat\r\ndata: {"channel":"agents",\r\ndata: "payload":{"agents":[{"id":"bot-1","lastTurnSettlement":{"clientNonce":"n1","outcome":"success","settledAtMs":10},"name":"private"}]}}\r\n\r\ndata: {"channel":"agent-upserted","payload":{"agent":{"id":"other","lastTurnSettlement":{"clientNonce":"foreign","outcome":"success","settledAtMs":20}}}}\n\n';
      const bytes = new TextEncoder().encode(text);
      const chunks = Array.from(bytes, (_, i) => bytes.slice(i, i + 1));
      const frames = yield* Gateway.decodeEvents(Stream.fromIterable(chunks)).pipe(
        Stream.runCollect,
      );
      const values = yield* Effect.forEach(frames, (frame) => Settlement.fromEvent("bot-1", frame));
      assert.deepStrictEqual(values.flat(), [
        { clientNonce: "n1", outcome: "success", settledAtMs: 10 },
      ]);
      assert.strictEqual(JSON.stringify(values).includes("private"), false);
    }),
);
it.effect("rejects malformed/oversized events and incomplete settlement identities", () =>
  Effect.gen(function* () {
    for (const text of ["data: invalid\n\n", "data: " + "x".repeat(2097153)]) {
      const error = yield* Gateway.decodeEvents(Stream.make(new TextEncoder().encode(text))).pipe(
        Stream.runCollect,
        Effect.flip,
      );
      assert.strictEqual(error._tag, "GrokBotGatewayFrameError");
    }
    const error = yield* Settlement.fromRoster("bot-1", [
      { id: "bot-1", lastTurnSettlement: { outcome: "success", settledAtMs: 10 } },
    ]).pipe(Effect.flip);
    assert.strictEqual(error._tag, "GrokBotSettlementDecodeError");
    assert.deepStrictEqual(
      yield* Settlement.fromRoster("bot-1", [{ id: "bot-1", isRunning: false }]),
      [],
    );
  }),
);
it.effect("dispatches CR-only SSE terminators across chunk boundaries", () =>
  Effect.gen(function* () {
    const frames = yield* Gateway.decodeEvents(
      Stream.fromIterable(
        Array.from(
          new TextEncoder().encode('data: {"channel":"heartbeat","payload":{}}\r\r'),
          (byte) => Uint8Array.of(byte),
        ),
      ),
    ).pipe(Stream.runCollect);
    assert.deepStrictEqual(frames, [{ channel: "heartbeat", payload: {} }]);
  }),
);
