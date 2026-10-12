import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

export class ConnectFrameError extends Schema.TaggedError<ConnectFrameError>()(
  "GrokBotConnectFrameError",
  {},
) {}

// Connect's public wire protocol: flags byte, big-endian uint32 size, JSON payload.
// No compression is requested; reject compressed, oversized, truncated, or unterminated responses.
export function encodeMessage(value: object): Uint8Array {
  const body = new TextEncoder().encode(encodeJson(value));
  const result = new Uint8Array(body.length + 5);
  new DataView(result.buffer).setUint32(1, body.length);
  result.set(body, 5);
  return result;
}

export function decodeMessages<E, R>(source: Stream.Stream<Uint8Array, E, R>) {
  return Stream.suspend(() => {
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let ended = false;
    const frames = source.pipe(
      Stream.mapAccumEffect(
        () => undefined,
        (_, chunk) =>
          Effect.try({
            try: () => {
              if (ended && chunk.length > 0) throw new ConnectFrameError({});
              const bytes = new Uint8Array(pending.length + chunk.length);
              bytes.set(pending);
              bytes.set(chunk, pending.length);
              let offset = 0;
              const values: unknown[] = [];
              while (bytes.length - offset >= 5) {
                const flags = bytes[offset];
                const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(
                  0,
                );
                if ((flags !== 0 && flags !== 2) || size > 2 * 1024 * 1024 || ended)
                  throw new ConnectFrameError({});
                if (bytes.length - offset - 5 < size) break;
                const value: unknown = decodeJson(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    bytes.subarray(offset + 5, offset + 5 + size),
                  ),
                );
                offset += 5 + size;
                if (flags === 2) {
                  if (typeof value !== "object" || value === null || "error" in value)
                    throw new ConnectFrameError({});
                  ended = true;
                } else values.push(value);
              }
              pending = bytes.slice(offset);
              if (pending.length > 2 * 1024 * 1024 + 5 || (ended && pending.length > 0))
                throw new ConnectFrameError({});
              return [undefined, values] as const;
            },
            catch: () => new ConnectFrameError({}),
          }),
      ),
    );
    return frames.pipe(
      Stream.concat(
        Stream.fromEffect(
          Effect.suspend(() =>
            ended && pending.length === 0 ? Effect.void : Effect.fail(new ConnectFrameError({})),
          ),
        ).pipe(Stream.drain),
      ),
    );
  });
}
