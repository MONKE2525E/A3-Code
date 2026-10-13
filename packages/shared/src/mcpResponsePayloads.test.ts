import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { responsePayloads } from "./mcpResponsePayloads.ts";

it.effect.each(["application/json", "text/event-stream"])(
  "cancels a stalled %s response body on interruption",
  (contentType) =>
    Effect.gen(function* () {
      const reading = Promise.withResolvers<void>();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull: () => {
            reading.resolve();
          },
          cancel: () => {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const response = new Response(body, { headers: { "content-type": contentType } });
      const fiber = yield* Effect.forkChild(
        responsePayloads(response, String).pipe(Stream.runCollect),
      );
      yield* Effect.promise(() => reading.promise);
      assert.isTrue(body.locked);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(cancelled);
    }),
);

it.effect("keeps split SSE payloads in order and ignores comments", () =>
  Effect.gen(function* () {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode(': heartbeat\r\ndata: {"id":1,\r\ndata: "result":'));
        controller.enqueue(encoder.encode('{"text":"Monke"}}\r\n\r\ndata: {"id":2}\n\n'));
        controller.close();
      },
    });
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const values = yield* responsePayloads(response, String).pipe(Stream.runCollect);
    assert.deepStrictEqual(values, [{ id: 1, result: { text: "Monke" } }, { id: 2 }]);
  }),
);

it.effect("cancels an acknowledgement body without parsing it", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const values = yield* responsePayloads(new Response(body, { status: 202 }), String).pipe(
      Stream.runCollect,
    );
    assert.deepStrictEqual(values, []);
    assert.isTrue(cancelled);
  }),
);

it.effect("rejects an incomplete UTF-8 suffix instead of dropping it from a JSON response", () =>
  Effect.gen(function* () {
    const response = new Response(Uint8Array.of(0x7b, 0x7d, 0xe2), {
      headers: { "content-type": "application/json" },
    });
    const error = yield* responsePayloads(response, () => "invalid-response").pipe(
      Stream.runDrain,
      Effect.flip,
    );
    assert.strictEqual(error, "invalid-response");
  }),
);

it.effect("decodes a JSON response with multibyte text split between chunks", () =>
  Effect.gen(function* () {
    const value = { id: 1, result: { text: "Monke 👋" } };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const byte of new TextEncoder().encode(JSON.stringify(value)))
          controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const response = new Response(body, { headers: { "content-type": "application/json" } });
    assert.deepStrictEqual(yield* responsePayloads(response, String).pipe(Stream.runCollect), [
      value,
    ]);
  }),
);
