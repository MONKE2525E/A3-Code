import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import { Tool, Toolkit } from "effect/ai";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpRemoteRunValidator from "../mcp/McpRemoteRunValidator.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as NativeTools from "../mcp/direct/NativeAgentDirectTools.ts";
import { toolkitRegistration } from "../mcp/direct/toolkit.ts";
import * as Broker from "./MuseAgentDirectToolsBroker.ts";
import * as MuseTools from "./MuseAgentDirectTools.ts";
import * as Port from "./MuseAgentDirectToolsPort.ts";

const threadId = ThreadId.make("thread:broker-test");
const providerInstanceId = ProviderInstanceId.make("muse-agent-broker-test");
const runId = RunId.make("run:broker-test");
const attemptId = RunAttemptId.make("attempt:broker-test");
const makeFixture = (wait = Effect.void) =>
  Effect.gen(function* () {
    let currentRunId = runId;
    let currentAttemptId = attemptId;
    let currentAccount = "account:test";
    let currentNativeSession = "native-session:test";
    let callbacksClosed = 0;
    let calls = 0;
    let validationCalls = 0;
    let lastToken = "";
    let invocation: Parameters<Port.MuseDirectToolTurnOptions["register"]>[1] | undefined;
    let capturedCatalog: Readonly<Record<string, NativeTools.DirectToolDefinition>> | undefined;
    const registry = yield* McpSessionRegistry.__testing.make().pipe(
      Effect.provideService(HttpServer.HttpServer, {
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:broker-test")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provideService(McpRemoteRunValidator.McpRemoteRunValidator, {
        validate: (scope) =>
          Effect.sync(() => {
            validationCalls++;
            return (
              scope.thread.threadId === threadId &&
              scope.thread.providerInstanceId === providerInstanceId &&
              scope.thread.remoteRun?.runId === currentRunId &&
              scope.thread.remoteRun.attemptId === currentAttemptId
            );
          }),
      }),
      Effect.provide(NodeServices.layer),
    );
    const registryLayer = Layer.succeed(McpSessionRegistry.McpSessionRegistry, {
      ...registry,
      issue: (request) =>
        registry.issue(request).pipe(
          Effect.tap((credential) =>
            Effect.sync(() => {
              lastToken = credential.config.authorizationHeader.slice("Bearer ".length);
            }),
          ),
        ),
    });
    const toolkit = Toolkit.make(
      Tool.make("read_authority", {
        parameters: Schema.Struct({}),
        success: Schema.Struct({
          threadId: ThreadId,
          providerInstanceId: ProviderInstanceId,
          runId: RunId,
          attemptId: RunAttemptId,
        }),
        dependencies: [McpInvocationContext.McpInvocationContext],
      }),
    );
    const handlers = McpToolAccess.toLayer(toolkit, {
      read_authority: McpToolAccess.reads(() =>
        Effect.gen(function* () {
          calls++;
          yield* wait;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          return { ...scope.thread!, ...scope.thread!.remoteRun! };
        }),
      ),
    });
    const toolsLayer = MuseTools.layer.pipe(
      Layer.provide(NativeTools.layer(toolkitRegistration(toolkit, handlers))),
    );
    const layer = Broker.installLayer.pipe(
      Layer.provideMerge(Port.layer),
      Layer.provide(toolsLayer),
      Layer.provide(registryLayer),
    );
    const options: Port.MuseDirectToolTurnOptions = {
      browserToolsAvailable: true,
      capabilities: new Set(["orchestration", "worktree", "pull-requests", "preview"]),
      threadId,
      providerInstanceId,
      remoteRun: { runId, attemptId },
      accountBinding: "account:test",
      nativeSessionId: "native-session:test",
      isCurrent: Effect.sync(
        () => currentAccount === "account:test" && currentNativeSession === "native-session:test",
      ),
      register: (commands, invoke) =>
        Effect.sync(() => {
          capturedCatalog = commands;
          invocation = invoke;
          return {
            accepted: Object.keys(commands).length,
            close: Effect.sync(() => {
              callbacksClosed++;
            }),
          };
        }),
    };
    const input = (invokeId = "invoke:broker-test"): Port.MuseDirectToolInvocation => ({
      accountBinding: "account:test",
      nativeSessionId: "native-session:test",
      connectionId: "connection:one",
      commandId: "read_authority",
      payload: {
        invoke_id: invokeId,
        command_id: "read_authority",
        params_json: '{"params_json":"{}"}',
      },
    });
    return {
      layer,
      options,
      input,
      invoke: (request = input()) => invocation!(request),
      resolve: () => registry.resolve(lastToken),
      get calls() {
        return calls;
      },
      get validationCalls() {
        return validationCalls;
      },
      get callbacksClosed() {
        return callbacksClosed;
      },
      get capturedCatalog() {
        return capturedCatalog;
      },
      retry: () => {
        currentAttemptId = RunAttemptId.make("attempt:broker-retry");
      },
      nextRun: () => {
        currentRunId = RunId.make("run:broker-next");
      },
      switchAccount: () => {
        currentAccount = "account:changed";
      },
      switchSession: () => {
        currentNativeSession = "session:changed";
      },
    };
  });

it.effect("the early port fails explicitly before installation and refuses replacement", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      expect((yield* Effect.flip(port.start(f.options))).code).toBe("not_installed");
      const installed = yield* port.install(() =>
        Effect.succeed({ revoke: Effect.void, close: Effect.void }),
      );
      expect(
        (yield* Effect.flip(
          port.install(() => Effect.succeed({ revoke: Effect.void, close: Effect.void })),
        )).code,
      ).toBe("already_installed");
      yield* installed.uninstall;
      expect((yield* Effect.flip(port.start(f.options))).code).toBe("not_installed");
    }).pipe(Effect.provide(Port.layer));
  }).pipe(Effect.scoped),
);

it.effect.each([false, true])(
  "forwards explicit browser authority to the registry: %s",
  (browser) =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* Effect.gen(function* () {
        const port = yield* Port.MuseAgentDirectToolsPort;
        const turn = yield* port.start({
          ...f.options,
          browserToolsAvailable: browser,
          capabilities: new Set(browser ? ["preview"] : []),
        });
        const scope = yield* f.resolve();
        expect(scope?.capabilities.has("preview")).toBe(browser);
        expect(scope?.capabilities.has("device")).toBe(false);
        expect((yield* f.invoke()).params.ok).toBe(true);
        yield* turn.close;
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.scoped),
);

it.effect("issues registry authority privately and revokes it with native callbacks on close", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      const turn = yield* port.start(f.options);
      expect((yield* f.resolve())?.thread.remoteRun).toEqual({ runId, attemptId });
      expect(JSON.stringify(f.capturedCatalog)).not.toMatch(
        /Bearer|authorizationHeader|providerSessionId/,
      );
      const reply = yield* f.invoke();
      expect(JSON.parse(reply.params.payload_json!)).toEqual({
        threadId,
        providerInstanceId,
        runId,
        attemptId,
      });
      expect(reply.options.expectedConnectionId).toBe("connection:one");
      expect(f.validationCalls).toBeGreaterThan(3);
      yield* turn.close;
      yield* turn.close;
      expect(yield* f.resolve()).toBeUndefined();
      expect(f.callbacksClosed).toBe(1);
      expect((yield* Effect.flip(f.invoke())).code).toBe("session_closed");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect("revokes host credentials and dispatch without starting native callback removal", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      const turn = yield* port.start(f.options);
      yield* turn.revoke;
      yield* turn.revoke;
      expect(yield* f.resolve()).toBeUndefined();
      expect((yield* Effect.flip(f.invoke())).code).toBe("session_closed");
      expect(f.callbacksClosed).toBe(0);
      yield* turn.close;
      expect(f.callbacksClosed).toBe(1);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect.each(["retry", "nextRun", "switchAccount", "switchSession"] as const)(
  "refuses stale authority after $0 even for replayed reads",
  (change) =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* Effect.gen(function* () {
        const port = yield* Port.MuseAgentDirectToolsPort;
        yield* port.start(f.options);
        yield* f.invoke();
        f[change]();
        expect((yield* Effect.flip(f.invoke())).code).toBe("stale_authority");
        expect(f.calls).toBe(1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.scoped),
);

it.effect("pins trusted metadata once and rejects cross-account/session/command contexts", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      yield* port.start(f.options);
      for (const changed of [{ accountBinding: "forged" }, { nativeSessionId: "forged" }]) {
        expect((yield* Effect.flip(f.invoke({ ...f.input(), ...changed }))).code).toBe(
          "stale_authority",
        );
      }
      expect((yield* Effect.flip(f.invoke({ ...f.input(), commandId: "forged" }))).code).toBe(
        "invalid_request",
      );
      yield* f.invoke();
      expect(
        (yield* Effect.flip(f.invoke({ ...f.input("other"), connectionId: "connection:two" })))
          .code,
      ).toBe("connection_mismatch");
      expect(f.calls).toBe(1);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect("refuses partial registration and cleans up its credential and callbacks", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      const register = f.options.register;
      expect(
        (yield* Effect.flip(
          port.start({
            ...f.options,
            register: (commands, invoke) =>
              register(commands, invoke).pipe(Effect.map((result) => ({ ...result, accepted: 0 }))),
          }),
        )).code,
      ).toBe("registration_failed");
      expect(yield* f.resolve()).toBeUndefined();
      expect(f.callbacksClosed).toBe(1);
      expect((yield* Effect.flip(f.invoke())).code).toBe("session_closed");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect("uses a trusted registration connection before the first invocation", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      const register = f.options.register;
      yield* port.start({
        ...f.options,
        register: (commands, invoke) =>
          register(commands, invoke).pipe(
            Effect.map((result) => ({ ...result, connectionId: "connection:registered" })),
          ),
      });
      expect((yield* Effect.flip(f.invoke())).code).toBe("connection_mismatch");
      expect(
        (yield* f.invoke({ ...f.input(), connectionId: "connection:registered" })).params.ok,
      ).toBe(true);
      expect(f.calls).toBe(1);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect("failed registration leaves no usable registry credential", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      expect(
        (yield* Effect.flip(
          port.start({
            ...f.options,
            register: () =>
              Effect.fail(
                new NativeTools.NativeAgentDirectToolsError({ code: "registration_failed" }),
              ),
          }),
        )).code,
      ).toBe("registration_failed");
      expect(yield* f.resolve()).toBeUndefined();
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect("turn close cancels a pending callback before removing the native registration", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const f = yield* makeFixture(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      const turn = yield* port.start(f.options);
      const work = yield* Effect.forkChild(f.invoke());
      yield* Deferred.await(started);
      yield* turn.close;
      expect((yield* Fiber.join(work)).params.ok).toBe(false);
      expect(yield* f.resolve()).toBeUndefined();
      expect(f.callbacksClosed).toBe(1);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect("captures host authority before asynchronous turn startup", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      const options = {
        ...f.options,
        connectionId: "connection:one",
        isCurrent: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(true),
        ),
      };
      const opening = yield* Effect.forkChild(port.start(options));
      yield* Deferred.await(started);
      Object.assign(options.remoteRun, { runId: RunId.make("run:mutated-host") });
      Object.assign(options, {
        threadId: ThreadId.make("thread:mutated-host"),
        connectionId: "connection:mutated-host",
        nativeSessionId: "session:mutated-host",
        accountBinding: "account:mutated-host",
      });
      yield* Deferred.succeed(release, undefined);
      const turn = yield* Fiber.join(opening);
      expect(JSON.parse((yield* f.invoke()).params.payload_json!)).toMatchObject({
        threadId,
        runId,
        attemptId,
      });
      yield* turn.close;
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect("installer unload closes turns owned by an external adapter lifetime", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    const lifetime = yield* Effect.scope;
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      yield* port.start(f.options).pipe(Effect.provideService(Scope.Scope, lifetime));
      yield* f.invoke();
    }).pipe(Effect.scoped, Effect.provide(f.layer));
    expect(yield* f.resolve()).toBeUndefined();
    expect(f.callbacksClosed).toBe(1);
    expect((yield* Effect.flip(f.invoke())).code).toBe("session_closed");
  }).pipe(Effect.scoped),
);

it.effect("bounds concurrent startup before issuing registry credentials", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let checks = 0;
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      const options = {
        ...f.options,
        isCurrent: Effect.gen(function* () {
          checks++;
          if (checks >= NativeTools.DIRECT_TOOL_LIMITS.sessions)
            yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return true;
        }),
      };
      const opening = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: NativeTools.DIRECT_TOOL_LIMITS.sessions + 1 }, () =>
            port
              .start(options)
              .pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => "opened" })),
          ),
          { concurrency: "unbounded" },
        ),
      );
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Fiber.join(opening);
      expect(results.filter((result) => result === "opened")).toHaveLength(
        NativeTools.DIRECT_TOOL_LIMITS.sessions,
      );
      expect(results.filter((result) => result === "capacity_exceeded")).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped, Effect.provideService(Scheduler.MaxOpsBeforeYield, 16)),
);

it.effect("a late registration cannot reopen a turn whose owner already closed", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const lifetime = yield* Scope.make();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      const opening = yield* Effect.forkChild(
        port
          .start({
            ...f.options,
            register: (commands, invoke) =>
              f.options.register(commands, invoke).pipe(
                Effect.tap(() => Deferred.succeed(started, undefined)),
                Effect.tap(() => Deferred.await(release)),
              ),
          })
          .pipe(Effect.provideService(Scope.Scope, lifetime)),
      );
      yield* Deferred.await(started);
      expect((yield* Effect.flip(f.invoke())).code).toBe("session_closed");
      yield* Scope.close(lifetime, Exit.void);
      expect(yield* f.resolve()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.await(opening);
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.callbacksClosed).toBe(1);
      expect((yield* Effect.flip(f.invoke())).code).toBe("session_closed");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);

it.effect("revokes the registry credential before waiting for native callback removal", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    const removing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const port = yield* Port.MuseAgentDirectToolsPort;
      const turn = yield* port.start({
        ...f.options,
        register: (commands, invoke) =>
          f.options.register(commands, invoke).pipe(
            Effect.map((registration) => ({
              ...registration,
              close: registration.close.pipe(
                Effect.andThen(Deferred.succeed(removing, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
            })),
          ),
      });
      const closing = yield* Effect.forkChild(turn.close);
      yield* Deferred.await(removing);
      const duringRemoval = yield* f.resolve();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      expect(duringRemoval).toBeUndefined();
      expect(f.callbacksClosed).toBe(1);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.scoped),
);
