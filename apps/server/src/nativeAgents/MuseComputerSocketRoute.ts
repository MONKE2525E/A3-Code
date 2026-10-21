import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthOrchestrationOperateScope,
  MuseAgentComputerId,
  ProviderInstanceId,
  type NativeAgentError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import { authenticateMediaRequest } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Agents from "./NativeAgentService.ts";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const decodeReference = Schema.decodeUnknownOption(
  Schema.Struct({
    providerInstanceId: ProviderInstanceId,
    sessionId: MuseAgentComputerId,
    taskId: MuseAgentComputerId,
    takeoverId: MuseAgentComputerId,
  }),
);

const makeHandler = Effect.fn("MuseComputerSocketRoute.makeHandler")(
  function* (
    agents: Agents.NativeAgentService["Service"],
    sessions: SessionStore.SessionStore["Service"],
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.upgrade?.toLowerCase() !== "websocket")
      return HttpServerResponse.text("Not Found", { status: 404 });
    // A cookie or fresh standard ticket covers the complete RFB handshake and input.
    const session = yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url) || url.value.searchParams.getAll("takeoverId").length !== 1)
      return HttpServerResponse.text("Bad Request", { status: 400 });
    const reference = decodeReference({
      ...(yield* HttpRouter.params),
      takeoverId: url.value.searchParams.get("takeoverId"),
    });
    if (Option.isNone(reference)) return HttpServerResponse.text("Bad Request", { status: 400 });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const native = yield* agents.computerStream(reference.value);
        yield* Effect.addFinalizer(() => native.close);
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        delete incoming.headers["sec-websocket-extensions"];
        const socket = yield* request.upgrade;
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        const close = (code: number, reason: string) =>
          writer.write(new Socket.CloseEvent(code, reason)).pipe(Effect.asVoid);
        const write = (data: Uint8Array) =>
          Effect.suspend(() => {
            if (data.byteLength > MAX_OUTPUT_BYTES)
              return close(1009, "computer frame too large").pipe(Effect.andThen(Effect.interrupt));
            if (incoming.socket.writableLength + data.byteLength + 14 > MAX_SOCKET_BUFFER_BYTES)
              return Effect.sync(() => incoming.socket.destroy()).pipe(
                Effect.andThen(Effect.interrupt),
              );
            return writer.write(data).pipe(Effect.asVoid);
          });
        const output = Stream.runForEach(native.events, write);
        const input = Effect.forever(
          reader.pull.pipe(
            Effect.flatMap((chunks) =>
              Effect.forEach(
                chunks,
                (chunk): Effect.Effect<void, NativeAgentError | Socket.SocketError> => {
                  if (typeof chunk === "string")
                    return close(1003, "binary computer frames required").pipe(
                      Effect.andThen(Effect.interrupt),
                    );
                  if (chunk.byteLength > MAX_INPUT_BYTES)
                    return close(1009, "computer input too large").pipe(
                      Effect.andThen(Effect.interrupt),
                    );
                  return native.send(chunk);
                },
                { discard: true },
              ),
            ),
          ),
        );
        const invalidation = sessions
          .awaitInvalidation(session.sessionId)
          .pipe(Effect.andThen(close(4401, "environment session ended")));
        yield* Effect.raceFirst(output, Effect.raceFirst(input, invalidation)).pipe(
          Effect.catchTags({
            NativeAgentError: () => close(4409, "computer control changed"),
            SessionCredentialVerificationError: () =>
              close(1011, "environment session unavailable"),
          }),
        );
        return HttpServerResponse.empty();
      }),
    ).pipe(
      Effect.catchTags({
        NativeAgentError: () =>
          Effect.succeed(
            HttpServerResponse.text("Muse computer control unavailable", { status: 409 }),
          ),
        SocketError: () => Effect.succeed(HttpServerResponse.empty()),
      }),
    );
  },
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
  }),
);

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const agents = yield* Agents.NativeAgentService;
    const sessions = yield* SessionStore.SessionStore;
    yield* router.add(
      "GET",
      "/api/ai-agents/muse/:providerInstanceId/computer/:sessionId/:taskId/stream",
      makeHandler(agents, sessions),
    );
  }),
);
