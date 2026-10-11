import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Connect from "./ConnectJsonStream.ts";

const end = (value: object = {}) => {
  const frame = Connect.encodeMessage(value);
  frame[0] = 2;
  return frame;
};
const bytes = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
it.effect("decodes split Connect envelopes and requires the terminal response", () =>
  Effect.gen(function* () {
    const wire = bytes(
      Connect.encodeMessage({ rows: { text: "🐒" } }),
      Connect.encodeMessage({ heartbeat: {} }),
      end(),
    );
    const chunks = Array.from(wire, (_, i) => wire.slice(i, i + 1));
    const frames = yield* Connect.decodeMessages(Stream.fromIterable(chunks)).pipe(
      Stream.runCollect,
    );
    assert.deepStrictEqual(frames, [{ rows: { text: "🐒" } }, { heartbeat: {} }]);
  }),
);
it.effect("rejects compressed, oversized, truncated, terminal-error and trailing envelopes", () =>
  Effect.gen(function* () {
    const oversized = new Uint8Array(5);
    new DataView(oversized.buffer).setUint32(1, 2097153);
    const compressed = Connect.encodeMessage({});
    compressed[0] = 1;
    const cases = [
      oversized,
      compressed,
      Connect.encodeMessage({}),
      Connect.encodeMessage({}).slice(0, 4),
      end({ error: { message: "private credential" } }),
      bytes(end(), Connect.encodeMessage({})),
    ];
    for (const wire of cases) {
      const error = yield* Connect.decodeMessages(Stream.make(wire)).pipe(
        Stream.runCollect,
        Effect.flip,
      );
      assert.strictEqual(error._tag, "GrokBotConnectFrameError");
      assert.strictEqual(JSON.stringify(error).includes("private"), false);
    }
  }),
);
