import { assert, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as NodeVM from "node:vm";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Verify the native Playwright profile is removed after its context closes.
import * as NodeFSP from "node:fs/promises";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { chromium, type BrowserContext, type Route, type Page } from "playwright-core";
import * as Transport from "./MuseAgentTransport.ts";
import * as Source from "./MuseAgentSessionSource.ts";
import * as Integration from "../preview/IntegrationBrowser.ts";
import * as Features from "./MuseAgentFeatureService.ts";
import * as NodeCryptoPlatform from "@effect/platform-node/NodeCrypto";

vi.mock("playwright-core", () => ({
  chromium: { launchPersistentContext: vi.fn(), executablePath: () => process.execPath },
}));
const decodeStreamMetadata = Schema.decodeUnknownEffect(
  Schema.Struct({ authority: Schema.String, id: Schema.String, connectionId: Schema.String }),
);
const decodeStreamPayload = Schema.decodeUnknownEffect(Schema.Struct({ base64: Schema.String }));

const fixture = (privateSession = false) => {
  const calls: { method: string; input: unknown }[] = [];
  let performRegistration: () => Promise<unknown> = async () => ({
    accepted: 1,
    connectionId: "generation-1",
  });
  let computerPreview: unknown = { base64: btoa("synthetic-preview"), contentType: "image/png" };
  let performUnregistration: () => Promise<unknown> = async () => undefined;
  const exposed = new Map<string, (raw: unknown) => unknown>();
  let handleRoute: ((route: Route) => Promise<void>) | undefined;
  let sourceFingerprint = "synthetic-fingerprint";
  let pageAuthority: string | null = "synthetic-authority";
  let disconnectObserved = false;
  let recoveryFails = false;
  let requestFailure: unknown;
  const bridge = {
    authority: () => pageAuthority,
    observeDisconnect: async (input: unknown) => {
      calls.push({ method: "observeDisconnect", input });
      if (recoveryFails) throw new Error("local_recovery_failed");
      if (disconnectObserved) return;
      disconnectObserved = true;
      await exposed.get("__t3MuseEvent")!({
        authority: "synthetic-authority",
        event: "transport.disconnected",
        payload: {},
      });
    },
    ...Object.fromEntries(
      [
        "request",
        "watch",
        "unwatch",
        "connectionId",
        "register",
        "unregister",
        "readComputerPreview",
        "openComputerStream",
        "sendComputerStream",
        "closeComputerStream",
      ].map((method) => [
        method,
        async (input: unknown) => {
          calls.push({ method, input });
          if (method === "register") return performRegistration();
          if (method === "request") {
            if (requestFailure) throw requestFailure;
            return { nativeResult: true };
          }
          if (method === "connectionId") return "generation-1";
          if (method === "readComputerPreview") return computerPreview;
          if (method === "unregister") return performUnregistration();
          return undefined;
        },
      ]),
    ),
  };
  const evaluate = async (fn: (input: unknown) => unknown, input?: unknown) => {
    assert.strictEqual(typeof fn, "function");
    const value: unknown = NodeVM.runInNewContext(`(${fn.toString()})(input)`, {
      __t3Muse: bridge,
      input,
    });
    return value;
  };
  let pageClosed = false;
  const page = {
    close: async () => {
      pageClosed = true;
    },
    route: async (_pattern: string, handler: (route: Route) => Promise<void>) => {
      handleRoute = handler;
    },
    exposeFunction: async (name: string, fn: (raw: unknown) => unknown) => {
      exposed.set(name, fn);
    },
    addInitScript: async () => {},
    goto: async () => {},
    waitForFunction: async (fn: (input: unknown) => unknown) => {
      assert.strictEqual(await evaluate(fn), true);
    },
    evaluate,
  };
  let profilePath: string | undefined;
  let closed = false;
  const context = {
    addCookies: async () => {},
    newPage: async () => page,
    close: async () => {
      closed = true;
    },
  };
  vi.mocked(chromium.launchPersistentContext).mockImplementation(async (path) => {
    profilePath = path;
    return context as unknown as BrowserContext;
  });
  const source = Source.MuseAgentSessionSource.of({
    inspect: Effect.succeed({ installed: true, sessionPresent: true }),
    read: Effect.sync(() => ({
      ...(privateSession ? { source: "t3-browser" as const } : {}),
      profilePath: "/synthetic/profile",
      cookies: [],
      fingerprint: sourceFingerprint,
    })),
  });
  const layer = Transport.makeMuseAgentTransportLayer({ executablePath: process.execPath }).pipe(
    Layer.provide(Layer.succeed(Source.MuseAgentSessionSource, source)),
    Layer.provide(
      Layer.mock(Integration.IntegrationBrowser)({
        museTransportPage: Effect.succeed(page as unknown as Page),
      }),
    ),
  );
  return {
    layer,
    calls,
    setAuthority: (value: string | null) => {
      pageAuthority = value;
    },
    failRequest: (failure: unknown) => {
      requestFailure = failure;
    },
    failRecovery: () => {
      recoveryFails = true;
    },
    setFingerprint: (value: string) => {
      sourceFingerprint = value;
    },
    nativeEvent: (raw: unknown) => exposed.get("__t3MuseEvent")!(raw),
    computerEvent: (raw: unknown) => exposed.get("__t3MuseComputerStreamEvent")!(raw),
    routeEvent: (route: Route) => handleRoute!(route),
    profilePath: () => profilePath,
    closed: () => closed,
    pageClosed: () => pageClosed,
    setRegistration: (callback: () => Promise<unknown>) => {
      performRegistration = callback;
    },
    setComputerPreview: (value: unknown) => {
      computerPreview = value;
    },
    setUnregistration: (callback: () => Promise<unknown>) => {
      performUnregistration = callback;
    },
  };
};

const registration: Transport.MuseAgentToolRegistration = {
  clientId: "t3-turn",
  connectionId: "generation-1",
  nativeSessionId: "primary",
  commands: { "t3.probe": {} },
  invoke: () =>
    Effect.succeed({
      method: "client.invoke.result",
      params: { invoke_id: "synthetic-invoke", ok: true },
      options: { expectedConnectionId: "generation-1" },
    }),
};

it.effect(
  "preserves safe native error codes across the page boundary for feature classification",
  () => {
    const f = fixture();
    f.failRequest(
      Object.assign(new Error("private native detail"), {
        code: "method_not_found",
        httpStatus: 501,
      }),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* Transport.MuseAgentTransport;
        const binding = yield* transport.connect;
        const cause = yield* transport.request(binding, "connectors.accounts", {}).pipe(
          Effect.match({
            onFailure: (error) => error.cause,
            onSuccess: () => "unexpected_success",
          }),
        );
        assert.deepStrictEqual(cause, { code: "method_not_found", httpStatus: 501 });
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "reports an unsupported native feature through the real transport and feature service",
  () => {
    const f = fixture();
    f.failRequest(
      Object.assign(new Error("private native detail"), {
        code: "method_not_found",
        httpStatus: 501,
      }),
    );
    return Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      const binding = yield* transport.connect;
      const features = yield* Features.MuseAgentFeatureService;
      const error = yield* features.tasks(binding).pipe(Effect.flip);
      assert.strictEqual(error.code, "unavailable");
      assert.strictEqual(
        error.message,
        "This Muse feature is unavailable in the verified native protocol or on this account.",
      );
    }).pipe(
      Effect.provide(
        Features.layer.pipe(Layer.provideMerge(f.layer), Layer.provide(NodeCryptoPlatform.layer)),
      ),
    );
  },
);

it.effect("does not return arbitrary native error strings or invalid HTTP statuses", () => {
  const f = fixture();
  f.failRequest({
    code: "private payload with spaces",
    httpStatus: 900,
    status: 900,
    message: "private native detail",
    token: "private",
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      const binding = yield* transport.connect;
      const result = yield* transport.request(binding, "tasks.list", {}).pipe(
        Effect.match({
          onFailure: (error) => ({ cause: error.cause, message: error.message }),
          onSuccess: () => "unexpected_success",
        }),
      );
      assert.deepStrictEqual(result, {
        cause: {},
        message: "The authenticated Muse connection is unavailable.",
      });
    }),
  ).pipe(Effect.provide(f.layer));
});

it.effect(
  "keeps the warm browser alive and delegates a transient readiness gap to bridge recovery",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* Transport.MuseAgentTransport;
        const binding = yield* transport.connect;
        const watch = yield* transport.watch(binding, "primary");
        const watcher = yield* watch.events.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        f.setAuthority(null);
        assert.strictEqual((yield* transport.connect.pipe(Effect.flip)).kind, "disconnected");
        assert.strictEqual(f.closed(), false);
        assert.strictEqual(
          yield* transport.request(binding, "sessions.list", {}).pipe(
            Effect.match({
              onSuccess: () => "unexpected_success",
              onFailure: (error) => error.kind,
            }),
          ),
          "disconnected",
        );
        assert.strictEqual(f.calls.filter((call) => call.method === "request").length, 0);
        f.setAuthority("synthetic-authority");
        assert.strictEqual(yield* transport.connect, binding);
        yield* Effect.promise(async () =>
          f.nativeEvent({
            authority: "synthetic-authority",
            event: "message.user",
            payload: {},
          }),
        );
        assert.deepStrictEqual(
          (yield* Fiber.join(watcher)).map((event) => event.event),
          ["transport.disconnected", "message.user"],
        );
        assert.deepStrictEqual(
          f.calls.filter((call) => call.method === "observeDisconnect").map((call) => call.input),
          [{ authority: "synthetic-authority" }, { authority: "synthetic-authority" }],
        );
        assert.strictEqual(f.calls.filter((call) => call.method === "watch").length, 1);
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "fails existing watchers when ready native authority changes instead of adopting another account",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* Transport.MuseAgentTransport;
        const binding = yield* transport.connect;
        const watch = yield* transport.watch(binding, "primary");
        const watcher = yield* watch.events.pipe(Stream.runCollect, Effect.forkScoped);
        f.setAuthority("foreign-authority");
        assert.strictEqual((yield* transport.connect.pipe(Effect.flip)).kind, "account_changed");
        assert.strictEqual((yield* Fiber.join(watcher).pipe(Effect.flip)).kind, "account_changed");
        assert.strictEqual(f.closed(), true);
        assert.strictEqual(f.calls.filter((call) => call.method === "request").length, 0);
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect("retires an observer when the bridge cannot fence its local recovery signal", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      const binding = yield* transport.connect;
      const watch = yield* transport.watch(binding, "primary");
      const watcher = yield* watch.events.pipe(Stream.runCollect, Effect.forkScoped);
      f.setAuthority(null);
      f.failRecovery();
      assert.strictEqual((yield* transport.connect.pipe(Effect.flip)).kind, "disconnected");
      assert.strictEqual((yield* Fiber.join(watcher).pipe(Effect.flip)).kind, "disconnected");
      assert.strictEqual(f.closed(), true);
    }),
  ).pipe(Effect.provide(f.layer));
});

it.effect(
  "retires old source-bound observers with a disconnected error when copied cookies change",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* Transport.MuseAgentTransport;
        const binding = yield* transport.connect;
        const watch = yield* transport.watch(binding, "primary");
        const watcher = yield* watch.events.pipe(Stream.runCollect, Effect.forkScoped);
        f.setFingerprint("changed-source");
        yield* transport.connect;
        assert.strictEqual((yield* Fiber.join(watcher).pipe(Effect.flip)).kind, "disconnected");
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect("decodes a bounded native computer preview without exposing native URLs", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      const binding = yield* transport.connect;
      const result = yield* transport.readComputerPreview(binding, {
        taskId: "task-1",
        sha256: "a".repeat(64),
      });
      assert.deepStrictEqual(result, {
        bytes: Buffer.from("synthetic-preview"),
        contentType: "image/png",
      });
      assert.deepStrictEqual(f.calls.at(-1), {
        method: "readComputerPreview",
        input: { authority: "synthetic-authority", taskId: "task-1", sha256: "a".repeat(64) },
      });
      f.setComputerPreview({ base64: btoa("html"), contentType: "text/html" });
      assert.strictEqual(
        (yield* transport
          .readComputerPreview(binding, { taskId: "task-1", sha256: "a".repeat(64) })
          .pipe(Effect.flip)).kind,
        "protocol",
      );
    }),
  ).pipe(Effect.provide(f.layer));
});

it.effect("carries scoped computer stream frames and rejects stale callback bindings", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      const binding = yield* transport.connect;
      const native = yield* transport.openComputerStream(binding, {
        sessionId: "worker",
        taskId: "task",
        takeoverId: "takeover",
      });
      const opened = f.calls.find((call) => call.method === "openComputerStream");
      const metadata = yield* decodeStreamMetadata(opened!.input);
      f.computerEvent({ ...metadata, authority: "foreign", type: "data", base64: "CQkJ" });
      f.computerEvent({ ...metadata, type: "data", base64: "UkZC" });
      assert.deepStrictEqual(yield* native.events.pipe(Stream.take(1), Stream.runCollect), [
        Buffer.from("RFB"),
      ]);
      assert.deepStrictEqual(f.calls.at(-1), { method: "closeComputerStream", input: metadata });
    }),
  ).pipe(Effect.provide(f.layer));
});
it.effect("bounds outgoing computer bytes and sends only the selected native stream", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      const binding = yield* transport.connect;
      const native = yield* transport.openComputerStream(binding, {
        sessionId: "worker",
        taskId: "task",
        takeoverId: "takeover",
      });
      yield* native.send(new Uint8Array([1, 2, 3]));
      const sent = f.calls.find((call) => call.method === "sendComputerStream");
      const payload = yield* decodeStreamPayload(sent?.input);
      assert.strictEqual(payload.base64, "AQID");
      assert.strictEqual(
        (yield* native.send(new Uint8Array(256 * 1024 + 1)).pipe(Effect.flip)).kind,
        "protocol",
      );
      assert.strictEqual(f.calls.filter((call) => call.method === "sendComputerStream").length, 1);
    }),
  ).pipe(Effect.provide(f.layer));
});

it.effect(
  "revokes local tools before bounded cleanup when native removal never acknowledges",
  () => {
    const f = fixture();
    let reached: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.setUnregistration(() => {
      reached();
      return new Promise(() => {});
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* Transport.MuseAgentTransport;
        const binding = yield* transport.connect;
        yield* transport.registerTools(binding, registration);
        const cleanup = yield* transport
          .unregisterTools(binding, "t3-turn")
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => entered);
        // The stalled old registration no longer prevents admission of the next turn.
        assert.deepStrictEqual(
          yield* transport.registerTools(binding, { ...registration, clientId: "next-turn" }),
          { accepted: 1, connectionId: "generation-1" },
        );
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(cleanup);
        assert.deepStrictEqual(
          f.calls.filter((call) => call.method === "unregister"),
          [
            {
              method: "unregister",
              input: {
                authority: "synthetic-authority",
                clientId: "t3-turn",
                connectionId: "generation-1",
              },
            },
          ],
        );
        f.setUnregistration(async () => undefined);
        yield* transport.unregisterTools(binding, "next-turn");
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "bounds cleanup after an invalid capability receipt instead of retaining the failed registration",
  () => {
    const f = fixture();
    let reached: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.setRegistration(async () => ({ accepted: "invalid", connectionId: "generation-1" }));
    f.setUnregistration(() => {
      reached();
      return new Promise(() => {});
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* Transport.MuseAgentTransport;
        const binding = yield* transport.connect;
        const failed = yield* transport
          .registerTools(binding, registration)
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => entered);
        yield* TestClock.adjust("2 seconds");
        assert.strictEqual((yield* Fiber.join(failed).pipe(Effect.flip)).kind, "protocol");
        f.setRegistration(async () => ({ accepted: 1, connectionId: "generation-1" }));
        assert.deepStrictEqual(
          yield* transport.registerTools(binding, { ...registration, clientId: "next-turn" }),
          { accepted: 1, connectionId: "generation-1" },
        );
        assert.deepStrictEqual(
          f.calls.map((call) => call.method),
          ["register", "unregister", "register"],
        );
        f.setUnregistration(async () => undefined);
        yield* transport.unregisterTools(binding, "next-turn");
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect("waits without CSP eval and invokes the native page request to return its result", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const transport = yield* Transport.MuseAgentTransport;
    const binding = yield* transport.connect;
    assert.deepStrictEqual(yield* transport.request(binding, "sessions.list", {}), {
      nativeResult: true,
    });
    assert.strictEqual(yield* transport.connectionId(binding), "generation-1");
    const request = f.calls.find((call) => call.method === "request");
    assert.deepStrictEqual(request?.input, {
      authority: "synthetic-authority",
      method: "sessions.list",
      params: {},
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect("closes only the owned persistent context and removes its temporary profile", () => {
  const f = fixture();
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      yield* transport.connect;
      assert.notStrictEqual(f.profilePath(), "/synthetic/profile");
      yield* Effect.promise(() => NodeFSP.access(f.profilePath()!));
      assert.strictEqual(f.closed(), false);
    }).pipe(Effect.provide(f.layer));
    assert.strictEqual(f.closed(), true);
    assert.strictEqual(
      yield* Effect.promise(() =>
        NodeFSP.access(f.profilePath()!).then(
          () => true,
          () => false,
        ),
      ),
      false,
    );
  });
});

it.effect(
  "aborts a failed route fetch once and suppresses disposal without losing owned cleanup",
  () => {
    const f = fixture(),
      handled: string[] = [];
    // This test boundary substitutes the external Playwright route, including its
    // consumed/disposed failure behavior; the transport and its real profile scope run unchanged.
    const route = {
      request: () => ({ resourceType: () => "script" }),
      fetch: async () => {
        handled.push("fetch");
        throw new Error("Network request failed");
      },
      abort: async (code: string) => {
        handled.push(`abort:${code}`);
        throw new Error("Route is already handled!");
      },
      continue: async () => {
        handled.push("continue");
      },
      fulfill: async () => {
        handled.push("fulfill");
      },
    } as unknown as Route;
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const transport = yield* Transport.MuseAgentTransport;
        yield* transport.connect;
        yield* Effect.promise(() => f.routeEvent(route));
      }).pipe(Effect.provide(f.layer));
      assert.deepStrictEqual(handled, ["fetch", "abort:failed"]);
      assert.strictEqual(f.closed(), true);
      assert.strictEqual(
        yield* Effect.promise(() =>
          NodeFSP.access(f.profilePath()!).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
    });
  },
);

it.effect("does not continue a consumed route when fulfillment or page disposal fails", () => {
  const f = fixture(),
    handled: string[] = [];
  const route = {
    request: () => ({ resourceType: () => "document" }),
    fetch: async () => {
      handled.push("fetch");
      return {
        headers: () => ({ "content-type": "text/html" }),
        body: async () => Buffer.from("<!doctype html><title>Synthetic</title>"),
      };
    },
    fulfill: async () => {
      handled.push("fulfill");
      throw new Error("Target page, context or browser has been closed");
    },
    continue: async () => {
      handled.push("continue");
      throw new Error("Route is already handled!");
    },
    abort: async () => {
      handled.push("abort");
    },
  } as unknown as Route;
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      yield* transport.connect;
      yield* Effect.promise(() => f.routeEvent(route));
    }).pipe(Effect.provide(f.layer));
    assert.deepStrictEqual(handled, ["fetch", "fulfill"]);
    assert.strictEqual(f.closed(), true);
    assert.strictEqual(
      yield* Effect.promise(() =>
        NodeFSP.access(f.profilePath()!).then(
          () => true,
          () => false,
        ),
      ),
      false,
    );
  });
});

it.effect("contains continuation disposal for unrelated resources without retrying them", () => {
  const f = fixture(),
    handled: string[] = [];
  const route = {
    request: () => ({ resourceType: () => "image" }),
    continue: async () => {
      handled.push("continue");
      throw new Error("Target closed");
    },
    fetch: async () => {
      handled.push("fetch");
    },
    fulfill: async () => {
      handled.push("fulfill");
    },
    abort: async () => {
      handled.push("abort");
    },
  } as unknown as Route;
  return Effect.gen(function* () {
    const transport = yield* Transport.MuseAgentTransport;
    yield* transport.connect;
    yield* Effect.promise(() => f.routeEvent(route));
    assert.deepStrictEqual(handled, ["continue"]);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "shares the canonical native subscription between observer and managed turn until both close",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      const binding = yield* transport.connect;
      const [observer, turn] = yield* Effect.all(
        [transport.watch(binding, "primary"), transport.watch(binding, "primary")],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(f.calls.filter((call) => call.method === "watch").length, 1);
      yield* observer.close;
      yield* observer.close;
      assert.strictEqual(f.calls.filter((call) => call.method === "unwatch").length, 0);
      yield* turn.close;
      assert.strictEqual(f.calls.filter((call) => call.method === "unwatch").length, 1);
      const replacement = yield* transport.watch(binding, "other-session");
      assert.strictEqual(f.calls.filter((call) => call.method === "watch").length, 2);
      yield* replacement.close;
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("hands the page subscription to another session and ends the old readers cleanly", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const transport = yield* Transport.MuseAgentTransport;
    const binding = yield* transport.connect;
    const [observer, turn] = yield* Effect.all(
      [transport.watch(binding, "primary"), transport.watch(binding, "primary")],
      { concurrency: "unbounded" },
    );
    const replacement = yield* transport.watch(binding, "other-session");
    assert.strictEqual(f.calls.filter((call) => call.method === "watch").length, 2);
    const ended = yield* Effect.all(
      [observer.events.pipe(Stream.runCollect), turn.events.pipe(Stream.runCollect)],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(
      ended.map((events) => events.map((event) => event.event)),
      [["transport.session_superseded"], ["transport.session_superseded"]],
    );
    yield* observer.close;
    yield* turn.close;
    assert.strictEqual(f.calls.filter((call) => call.method === "unwatch").length, 0);
    yield* replacement.close;
    assert.strictEqual(f.calls.filter((call) => call.method === "unwatch").length, 1);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "removes page registration after response validation fails and permits a later clean registration",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      const binding = yield* transport.connect;
      f.setRegistration(async () => ({ accepted: "invalid", connectionId: "generation-1" }));
      assert.strictEqual(
        (yield* Effect.flip(transport.registerTools(binding, registration))).kind,
        "protocol",
      );
      const removals = f.calls.filter((call) => call.method === "unregister");
      assert.strictEqual(removals.length, 1);
      assert.deepStrictEqual(removals[0]?.input, {
        authority: "synthetic-authority",
        clientId: "t3-turn",
        connectionId: "generation-1",
      });
      f.setRegistration(async () => ({ accepted: 1, connectionId: "generation-1" }));
      assert.strictEqual((yield* transport.registerTools(binding, registration)).accepted, 1);
      yield* transport.unregisterTools(binding, "t3-turn");
      assert.strictEqual(f.calls.filter((call) => call.method === "unregister").length, 2);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "interruption revokes partially installed page callbacks before the host slot can be reused",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* Transport.MuseAgentTransport;
        const binding = yield* transport.connect;
        const entering = yield* Deferred.make<void>();
        let begin: (() => void) | undefined;
        const entered = new Promise<void>((resolve) => {
          begin = resolve;
        });
        let complete: ((value: unknown) => void) | undefined;
        f.setRegistration(() => {
          begin!();
          return new Promise((resolve) => {
            complete = resolve;
          });
        });
        yield* Effect.promise(() => entered).pipe(
          Effect.andThen(Deferred.succeed(entering, undefined)),
          Effect.forkScoped,
        );
        const registering = yield* transport
          .registerTools(binding, registration)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entering);
        yield* Fiber.interrupt(registering);
        assert.strictEqual(f.calls.filter((call) => call.method === "unregister").length, 1);
        complete!({ accepted: 1, connectionId: "generation-1" });
        f.setRegistration(async () => ({ accepted: 1, connectionId: "generation-1" }));
        assert.strictEqual((yield* transport.registerTools(binding, registration)).accepted, 1);
        yield* transport.unregisterTools(binding, "t3-turn");
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect("uses the signed-in T3 browser and retires only its transport page", () => {
  const f = fixture(true);
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* Transport.MuseAgentTransport;
        yield* transport.connect;
        assert.equal(f.profilePath(), undefined);
      }).pipe(Effect.provide(f.layer)),
    );
    assert.equal(f.closed(), false);
    assert.equal(f.pageClosed(), true);
  });
});

it.effect("preserves the native status field without leaking error details", () => {
  const f = fixture();
  f.failRequest(Object.assign(new Error("synthetic-private-detail"), { status: 403 }));
  return Effect.gen(function* () {
    const transport = yield* Transport.MuseAgentTransport;
    const binding = yield* transport.connect;
    const cause = yield* transport.request(binding, "connectors.get", {}).pipe(
      Effect.match({
        onFailure: (error) => error.cause,
        onSuccess: () => null,
      }),
    );
    assert.deepStrictEqual(cause, { status: 403 });
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("reduces the native missing-endpoint rejection to a fixed safe classifier", () => {
  const f = fixture();
  f.failRequest(
    Object.assign(new Error("matched route missing from endpoint ACL"), {
      kind: "jarvis_rejection",
    }),
  );
  return Effect.gen(function* () {
    const transport = yield* Transport.MuseAgentTransport;
    const binding = yield* transport.connect;
    const cause = yield* transport.request(binding, "connectors.connect", {}).pipe(
      Effect.match({
        onFailure: (error) => error.cause,
        onSuccess: () => null,
      }),
    );
    assert.deepStrictEqual(cause, { missingEndpointAcl: true });
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("keeps an owned turn's subscription alive when another conversation is opened", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const transport = yield* Transport.MuseAgentTransport;
    const binding = yield* transport.connect;
    const owner = yield* transport.watch(binding, "primary");
    yield* transport.registerTools(binding, registration);
    assert.equal((yield* Effect.flip(transport.watch(binding, "side-chat"))).kind, "protocol");
    assert.equal(f.calls.filter((call) => call.method === "watch").length, 1);
    yield* Effect.promise(() =>
      Promise.resolve(
        f.nativeEvent({
          authority: "synthetic-authority",
          event: "message.assistant",
          payload: {
            session_id: "primary",
            message_id: "owned-answer",
            display_text: "Still running",
          },
        }),
      ),
    );
    yield* transport.unregisterTools(binding, registration.clientId);
    const replacement = yield* transport.watch(binding, "side-chat");
    const ended = yield* owner.events.pipe(Stream.runCollect);
    assert.deepEqual(
      ended.map((event) => event.event),
      ["message.assistant", "transport.session_superseded"],
    );
    yield* replacement.close;
  }).pipe(Effect.provide(f.layer));
});
it.effect("rejects stale turn registration after its subscription was handed off", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const transport = yield* Transport.MuseAgentTransport;
    const binding = yield* transport.connect;
    const old = yield* transport.watch(binding, "primary");
    const replacement = yield* transport.watch(binding, "side-chat");
    assert.equal(
      (yield* Effect.flip(transport.registerTools(binding, registration))).kind,
      "protocol",
    );
    assert.equal(f.calls.filter((call) => call.method === "register").length, 0);
    yield* old.close;
    yield* replacement.close;
  }).pipe(Effect.provide(f.layer));
});
it.effect("serializes a pending turn registration against subscription takeover", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* Transport.MuseAgentTransport;
      const binding = yield* transport.connect;
      const owner = yield* transport.watch(binding, "primary");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<unknown>();
      f.setRegistration(() => {
        entered.resolve();
        return release.promise;
      });
      const registering = yield* transport
        .registerTools(binding, registration)
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      const takeover = yield* transport
        .watch(binding, "side-chat")
        .pipe(Effect.flip, Effect.forkScoped);
      release.resolve({ accepted: 1, connectionId: "generation-1" });
      assert.equal((yield* Fiber.join(registering)).accepted, 1);
      assert.equal((yield* Fiber.join(takeover)).kind, "protocol");
      assert.equal(f.calls.filter((call) => call.method === "watch").length, 1);
      yield* transport.unregisterTools(binding, registration.clientId);
      yield* owner.close;
    }),
  ).pipe(Effect.provide(f.layer));
});
