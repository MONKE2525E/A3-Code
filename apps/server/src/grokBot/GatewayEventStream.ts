import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class GatewayFrameError extends Schema.TaggedError<GatewayFrameError>()(
  "GrokBotGatewayFrameError",
  {},
) {}
const Event = Schema.Struct({ channel: Schema.String, payload: Schema.Unknown });
const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(Event));

// The official gateway emits JSON {channel,payload} in standard SSE data fields.
export function decodeEvents<E, R>(source: Stream.Stream<Uint8Array, E, R>) {
  return Stream.suspend(() => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let data: string[] = [];
    let size = 0;
    let skipLF = false;
    return source.pipe(
      Stream.mapAccumEffect(
        () => undefined,
        (_, chunk) =>
          Effect.gen(function* () {
            const text = yield* Effect.try({
              try: () => decoder.decode(chunk, { stream: true }),
              catch: () => new GatewayFrameError({}),
            });
            pending += text;
            if (skipLF && pending.length > 0) {
              if (pending.startsWith("\n")) pending = pending.slice(1);
              skipLF = false;
            }
            if (pending.length + size > 2 * 1024 * 1024) return yield* new GatewayFrameError({});
            const events: (typeof Event.Type)[] = [];
            let start = 0;
            for (let i = 0; i < pending.length; i++) {
              const char = pending[i];
              if (char !== "\r" && char !== "\n") continue;
              if (char === "\r" && i === pending.length - 1) skipLF = true;
              const line = pending.slice(start, i);
              if (char === "\r" && pending[i + 1] === "\n") i++;
              start = i + 1;
              if (line === "") {
                if (data.length > 0)
                  events.push(
                    yield* decodeEvent(data.join("\n")).pipe(
                      Effect.mapError(() => new GatewayFrameError({})),
                    ),
                  );
                data = [];
                size = 0;
              } else if (line === "data" || line.startsWith("data:")) {
                const value = line === "data" ? "" : line.slice(5).replace(/^ /, "");
                data.push(value);
                size += value.length;
              }
            }
            pending = pending.slice(start);
            return [undefined, events] as const;
          }),
      ),
    );
  });
}
