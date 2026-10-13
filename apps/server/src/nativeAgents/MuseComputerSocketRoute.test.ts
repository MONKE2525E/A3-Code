import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  NativeAgentError,
  ProviderInstanceId,
  museAgentComputerStreamPath,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Agents from "./NativeAgentService.ts";
import { routeLayer } from "./MuseComputerSocketRoute.ts";

const reference = {
  providerInstanceId: ProviderInstanceId.make("muse-agent-socket"),
  sessionId: "worker:synthetic",
  taskId: "task:synthetic",
  takeoverId: "owned-takeover",
};
const resource = `${museAgentComputerStreamPath(reference)}?takeoverId=owned-takeover&wsTicket=synthetic-one-use-ticket`;
const fixture = Effect.gen(function* () {
  const output = yield* Queue.make<Uint8Array, NativeAgentError>();
  const sent = yield* Deferred.make<void>();
  const revoked = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const requests: string[] = [];
  const inputs: Uint8Array[] = [];
  const opens: Array<typeof reference> = [];
  let closeCount = 0;
  let currentTakeoverId = reference.takeoverId;
  const close = Effect.sync(() => {
    if (closeCount === 0) {
      closeCount++;
      Deferred.doneUnsafe(closed, Effect.void);
    }
  });
  const agents = Layer.mock(Agents.NativeAgentService)({
    computerStream: (input) =>
      Effect.suspend(() => {
        if (input.takeoverId !== currentTakeoverId)
          return Effect.fail(new NativeAgentError({ reason: "provider_unavailable" }));
        opens.push(input);
        return Effect.succeed({
          events: Stream.fromQueue(output),
          send: (bytes: Uint8Array) =>
            Effect.sync(() => {
              inputs.push(bytes);
              Deferred.doneUnsafe(sent, Effect.void);
            }),
          close,
        });
      }),
  });
  const auth = (scopes: ReadonlyArray<AuthEnvironmentScope>, missing = false) =>
    Layer.mock(Auth.EnvironmentAuth)({
      authenticateWebSocketUpgrade: (request) => {
        requests.push(request.originalUrl);
        return missing
          ? Effect.fail(new Auth.ServerAuthMissingCredentialError({}))
          : Effect.succeed({
              sessionId: AuthSessionId.make("synthetic-computer-session"),
              subject: "synthetic",
              method: "bearer-access-token" as const,
              scopes,
            });
      },
    });
  const sessions = Layer.mock(SessionStore.SessionStore)({
    cookieName: "synthetic-cookie",
    legacyCookieName: undefined,
    awaitInvalidation: () => Deferred.await(revoked),
  });
  const services = (scopes: ReadonlyArray<AuthEnvironmentScope>, missing = false) =>
    routeLayer.pipe(
      Layer.provide(agents),
      Layer.provide(sessions),
      Layer.provideMerge(auth(scopes, missing)),
      Layer.provideMerge(NodeServices.layer),
    );
  return {
    output,
    sent,
    revoked,
    closed,
    requests,
    inputs,
    opens,
    services,
    auth,
    replaceLease: () => {
      currentTakeoverId = "foreign-replacement";
    },
    closeCount: () => closeCount,
  };
});

it.effect.each([
  { scopes: [], missing: true, status: 401 },
  { scopes: [AuthOrchestrationReadScope], missing: false, status: 403 },
])(
  "requires operate authentication before any native handshake ($status)",
  ({ scopes, missing, status }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const app = HttpRouter.toWebHandler(f.services(scopes, missing), { disableLogger: true });
      try {
        const response = yield* Effect.promise(() =>
          app.handler(
            new Request(`http://synthetic.invalid${resource}`, {
              headers: { upgrade: "websocket" },
            }),
          ),
        );
        expect(response.status).toBe(status);
        expect(f.opens).toEqual([]);
        expect(f.inputs).toEqual([]);
        expect(f.requests).toEqual([`http://synthetic.invalid${resource}`]);
      } finally {
        yield* Effect.promise(() => app.dispose());
      }
    }).pipe(Effect.scoped),
);

it.effect.each([
  { kind: "disconnect", expectedCode: 1000 },
  { kind: "revoked", expectedCode: 4401 },
  { kind: "ownership", expectedCode: 4409 },
  { kind: "text", expectedCode: 1003 },
  { kind: "large-input", expectedCode: 1009 },
  { kind: "large-output", expectedCode: 1009 },
])("relays scoped binary frames and closes owned resources for $kind", ({ kind, expectedCode }) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const services = yield* Layer.build(
      HttpRouter.serve(f.services([AuthOrchestrationOperateScope]), {
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(f.auth([AuthOrchestrationOperateScope])),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const first = Promise.withResolvers<Uint8Array>();
    const ended = Promise.withResolvers<number>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(origin + resource)),
      (socket) => Effect.sync(() => socket.close()),
    );
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) first.resolve(new Uint8Array(event.data));
      else first.reject(new Error("binary frame expected"));
    });
    socket.addEventListener("close", (event) => ended.resolve(event.code));
    socket.addEventListener("error", () =>
      first.reject(
        new Error(
          `computer socket failed: ${JSON.stringify({ opens: f.opens, requests: f.requests })}`,
        ),
      ),
    );
    const frame = new Uint8Array([82, 70, 66]);
    yield* Queue.offer(f.output, frame);
    expect(yield* Effect.promise(() => first.promise)).toEqual(frame);
    if (kind === "text") socket.send("not binary RFB");
    else if (kind === "large-input") socket.send(new Uint8Array(256 * 1024 + 1));
    else if (kind === "large-output")
      yield* Queue.offer(f.output, new Uint8Array(4 * 1024 * 1024 + 1));
    else {
      const input = new Uint8Array([1, 2, 3]);
      socket.send(input);
      yield* Deferred.await(f.sent);
      expect(f.inputs).toEqual([input]);
      if (kind === "disconnect") socket.close(1000);
      else if (kind === "revoked") yield* Deferred.succeed(f.revoked, undefined);
      else yield* Queue.fail(f.output, new NativeAgentError({ reason: "account_changed" }));
    }
    expect(yield* Effect.promise(() => ended.promise)).toBe(expectedCode);
    yield* Deferred.await(f.closed);
    expect(f.closeCount()).toBe(1);
    expect(f.opens).toEqual([reference]);
    expect(f.requests).toEqual([resource]);
    if (kind === "text" || kind === "large-input" || kind === "large-output")
      expect(f.inputs).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "refuses a replaced lease and malformed lease reference before any native handshake",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.replaceLease();
      const app = HttpRouter.toWebHandler(f.services([AuthOrchestrationOperateScope]), {
        disableLogger: true,
      });
      try {
        const request = (path: string) =>
          new Request(`http://synthetic.invalid${path}`, { headers: { upgrade: "websocket" } });
        expect((yield* Effect.promise(() => app.handler(request(resource)))).status).toBe(409);
        for (const path of [
          resource.replace("takeoverId=owned-takeover&", ""),
          resource.replace("owned-takeover", "foreign%2Flease"),
          resource + "&takeoverId=duplicate",
        ])
          expect((yield* Effect.promise(() => app.handler(request(path)))).status).toBe(400);
        expect(f.opens).toEqual([]);
        expect(f.inputs).toEqual([]);
        expect(f.closeCount()).toBe(0);
      } finally {
        yield* Effect.promise(() => app.dispose());
      }
    }).pipe(Effect.scoped),
);
