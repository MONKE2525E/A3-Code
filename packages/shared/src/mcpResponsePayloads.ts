// MCP responses carry opaque JSON-RPC that callers relay verbatim.
// @effect-diagnostics preferSchemaOverJson:off
/**
 * Reads the JSON-RPC payloads of a response from an MCP streamable-HTTP
 * endpoint. Used on the ACP bridge fast path, so it imports only effect core.
 *
 * @module mcpResponsePayloads
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

function sseDataLines<E>(bytes: Stream.Stream<Uint8Array, E>): Stream.Stream<string, E> {
  return Stream.suspend(() => {
    const decoder = new TextDecoder();
    let buffered = "";
    return bytes.pipe(
      Stream.map((chunk) => {
        buffered += decoder.decode(chunk, { stream: true });
        const values: string[] = [];
        let separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
        while (separatorIndex !== -1) {
          const rawEvent = buffered.slice(0, separatorIndex);
          buffered = buffered.slice(separatorIndex).replace(/^(?:\r?\n){2}/u, "");
          const data = rawEvent
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trimStart())
            .join("\n");
          if (data.length > 0) values.push(data);
          separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
        }
        return values;
      }),
      Stream.flatMap(Stream.fromIterable),
    );
  });
}

export const discardResponseBody = (response: Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

/**
 * Every JSON-RPC payload carried by a response, in arrival order: nothing for
 * notification acknowledgements, each SSE `data:` event as it streams in, or
 * the single JSON body.
 */
export function responsePayloads<E>(
  response: Response,
  onError: (cause: unknown) => E,
): Stream.Stream<unknown, E> {
  if (response.status === 202 || response.status === 204) {
    return Stream.unwrap(discardResponseBody(response).pipe(Effect.as(Stream.empty)));
  }
  // A pending async-generator read cannot be interrupted by iterator.return().
  // The scoped reader cancels the HTTP body even while no bytes are arriving.
  const body = response.body;
  const bytes =
    body === null ? Stream.empty : Stream.fromReadableStream({ evaluate: () => body, onError });
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return sseDataLines(bytes).pipe(
      Stream.mapEffect((data) => Effect.try({ try: () => JSON.parse(data), catch: onError })),
    );
  }
  return Stream.unwrap(
    Effect.suspend(() => {
      const decoder = new TextDecoder();
      return bytes.pipe(
        Stream.map((chunk) => decoder.decode(chunk, { stream: true })),
        Stream.concat(Stream.sync(() => decoder.decode())),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
        Effect.flatMap((text) =>
          text.trim().length === 0
            ? Effect.succeed(Stream.empty)
            : Effect.try({ try: () => JSON.parse(text) as unknown, catch: onError }).pipe(
                Effect.map((payload) => Stream.fromIterable([payload])),
              ),
        ),
      );
    }),
  );
}
