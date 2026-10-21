import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as MuseTools from "../../museAgent/MuseAgentDirectTools.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import * as McpToolActivity from "../McpToolActivity.ts";
import { idleThreadProjection, liveThreadShell } from "../McpToolAccess.testkit.ts";
import * as NativeTools from "./NativeAgentDirectTools.ts";
import { toolkitRegistration } from "./toolkit.ts";

const threadId = ThreadId.make("thread:direct-test");
const providerInstanceId = ProviderInstanceId.make("muse-agent");
const runId = RunId.make("run:mcp-test");
const attemptId = RunAttemptId.make("attempt:direct-test");
const scope = (): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment:direct-test"),
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  requestNamespace: "direct:test",
  client: undefined,
  thread: {
    threadId,
    providerInstanceId,
    providerSessionId: "session:direct-test",
    remoteRun: { runId, attemptId },
  },
});
const fixture = (wait?: Effect.Effect<void>) => {
  let calls = 0;
  let currentAttemptId = attemptId;
  let valid = true;
  const observed: string[] = [];
  const shell = {
    ...liveThreadShell(threadId),
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "native" },
  };
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(shell),
    getProjectThreadRecords: () =>
      Effect.succeed({
        ...idleThreadProjection(shell),
        runs: [
          {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection: shell.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:direct-test"),
            rootNodeId: NodeId.make("node:direct-test"),
            activeAttemptId: currentAttemptId,
            status: "running" as const,
            requestedAt: shell.createdAt,
            startedAt: shell.createdAt,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
      }),
  });
  const shared = {
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  };
  const toolkit = Toolkit.make(
    Tool.make("probe", {
      ...shared,
      description: "Read invocation authority.",
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.Struct({
        threadId: ThreadId,
        runId: RunId,
        attemptId: RunAttemptId,
        requestNamespace: Schema.String,
        text: Schema.String,
      }),
    }),
    Tool.make("fails", { ...shared, success: Schema.String }),
    Tool.make("invalid_result", { ...shared, success: Schema.Number.check(Schema.isFinite()) }),
  );
  const handlers = McpToolAccess.toLayer(toolkit, {
    probe: McpToolAccess.actsAsCaller(({ text }) =>
      Effect.gen(function* () {
        calls++;
        yield* wait ?? Effect.void;
        const caller = yield* McpInvocationContext.McpInvocationContext;
        return {
          threadId: caller.thread!.threadId,
          ...caller.thread!.remoteRun!,
          requestNamespace: caller.requestNamespace,
          text,
        };
      }),
    ),
    fails: McpToolAccess.actsAsCaller(() =>
      Effect.fail(
        new OrchestratorMcpFailure({ code: "capability_denied", message: "Test refusal." }),
      ),
    ),
    invalid_result: McpToolAccess.reads(() => Effect.succeed(Number.NaN)),
  });
  const nativeLayer = NativeTools.layer(toolkitRegistration(toolkit, handlers)).pipe(
    Layer.provide(threads),
    Layer.provide(
      Layer.succeed(McpToolActivity.McpToolActivity, {
        observe: (name, effect) =>
          Effect.sync(() => observed.push(name)).pipe(Effect.andThen(effect)),
      }),
    ),
  );
  return {
    layer: nativeLayer,
    museLayer: MuseTools.layer.pipe(Layer.provideMerge(nativeLayer)),
    get calls() {
      return calls;
    },
    observed,
    invalidate: () => {
      valid = false;
    },
    retry: () => {
      currentAttemptId = RunAttemptId.make("attempt:retry");
    },
    options: {
      scope: scope(),
      connectionId: "connection:one",
      validate: () => Effect.sync(() => valid),
    },
  };
};
const request = (id = "invoke:one", params = '{"text":"hello"}', command = "probe") => ({
  invoke_id: id,
  command_id: command,
  params_json: params,
});
const open = (options: NativeTools.DirectToolSessionOptions) =>
  Effect.gen(function* () {
    const service = yield* NativeTools.NativeAgentDirectTools;
    const session = yield* service.open(options);
    yield* session.acceptRegistration(options.connectionId, { accepted_device_commands: 3 });
    return session;
  });

it.effect("dispatches checked tools with captured caller authority and registered activity", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const session = yield* open(f.options);
    const catalog = yield* session.catalog;
    expect(catalog.probe?.required.params_json.type).toBe(1);
    expect(catalog.probe?.required.params_json.description).toContain('"text"');
    const result = yield* session.invoke("connection:one", request());
    expect(result).toMatchObject({
      ok: true,
      result: { threadId, runId, attemptId, requestNamespace: "direct:test", text: "hello" },
    });
    expect(f.observed).toEqual(["probe"]);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.effect("never accepts caller, connection or attempt authority from the device", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const session = yield* open(f.options);
    expect((yield* Effect.flip(session.invoke("connection:two", request()))).code).toBe(
      "connection_mismatch",
    );
    expect(
      (yield* Effect.flip(session.invoke("connection:one", { ...request(), scope: scope() }))).code,
    ).toBe("invalid_request");
    const result = yield* session.invoke(
      "connection:one",
      request("inject", '{"text":"hello","providerSessionId":"forged","threadId":"forged"}'),
    );
    expect(result.ok).toBe(false);
    expect(f.calls).toBe(0);
    expect(f.observed).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.effect(
  "the checked handler rejects a replaced attempt even when host validation says live",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const session = yield* open(f.options);
      f.retry();
      const result = yield* session.invoke("connection:one", request());
      expect(result).toMatchObject({ ok: false, result: { code: "parent_not_active" } });
      expect(f.calls).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  },
);

it.effect("revoked authority refuses even a cached replay", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const session = yield* open(f.options);
    yield* session.invoke("connection:one", request());
    f.invalidate();
    expect((yield* Effect.flip(session.invoke("connection:one", request()))).code).toBe(
      "stale_authority",
    );
    expect(f.calls).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.effect("copies trusted authority and refuses unbound or external client scopes", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* NativeTools.NativeAgentDirectTools;
    const session = yield* open(f.options);
    Object.assign(f.options.scope.thread, {
      remoteRun: { runId: RunId.make("run:forged"), attemptId },
    });
    expect((yield* session.invoke("connection:one", request())).ok).toBe(true);
    expect(
      (yield* Effect.flip(
        service.open({
          ...f.options,
          scope: {
            ...scope(),
            thread: { threadId, providerInstanceId, providerSessionId: "session:unbound" },
          },
        }),
      )).code,
    ).toBe("invalid_scope");
    expect(
      (yield* Effect.flip(
        service.open({
          ...f.options,
          scope: {
            ...scope(),
            client: { sessionId: "external", label: "test", access: "full-access" },
          },
        }),
      )).code,
    ).toBe("invalid_scope");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.effect("deduplicates simultaneous delivery and rejects changed parameters or deadlines", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const f = fixture(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    yield* Effect.gen(function* () {
      const session = yield* open(f.options);
      const one = yield* Effect.forkChild(session.invoke("connection:one", request()));
      yield* Deferred.await(started);
      const two = yield* Effect.forkChild(session.invoke("connection:one", request()));
      expect(
        (yield* Effect.flip(
          session.invoke("connection:one", request("invoke:one", '{"text":"changed"}')),
        )).code,
      ).toBe("invoke_id_collision");
      expect(
        (yield* Effect.flip(session.invoke("connection:one", { ...request(), timeout_ms: 500 })))
          .code,
      ).toBe("invoke_id_collision");
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(one)).toEqual(yield* Fiber.join(two));
      expect(f.calls).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  }),
);

it.effect("keeps rejected command IDs explicit and requires complete registration", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* NativeTools.NativeAgentDirectTools;
    const session = yield* service.open(f.options);
    expect((yield* Effect.flip(session.invoke("connection:one", request()))).code).toBe(
      "registration_failed",
    );
    const accepted = yield* session.acceptRegistration("connection:one", {
      accepted_device_commands: 2,
      rejected_ids: ["fails"],
    });
    expect(accepted.rejected).toEqual(["fails"]);
    expect(yield* session.catalog).not.toHaveProperty("fails");
    expect(
      (yield* Effect.flip(session.invoke("connection:one", request("rejected", "{}", "fails"))))
        .code,
    ).toBe("command_rejected");
    expect(
      (yield* Effect.flip(
        session.acceptRegistration("connection:one", { accepted_device_commands: 3 }),
      )).code,
    ).toBe("registration_failed");
    expect(
      (yield* Effect.flip(
        session.acceptRegistration("connection:one", {
          accepted_device_commands: 2,
          rejected_ids: ["unknown"],
        }),
      )).code,
    ).toBe("registration_failed");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.effect("reserves replay receipts atomically when the scheduler yields between effects", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const session = yield* open(f.options);
    const replies = yield* Effect.all(
      Array.from({ length: 16 }, () => session.invoke("connection:one", request())),
      { concurrency: "unbounded" },
    );
    expect(replies.every((reply) => reply.ok)).toBe(true);
    expect(f.calls).toBe(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(f.layer),
    Effect.provideService(Scheduler.MaxOpsBeforeYield, 16),
  );
});

it.effect.each([
  { name: "array", params: "[]", code: "invalid_params" },
  { name: "null", params: "null", code: "invalid_params" },
  { name: "syntax", params: "broken", code: "invalid_params" },
  {
    name: "characters",
    params: '{"text":"' + "x".repeat(NativeTools.DIRECT_TOOL_LIMITS.paramsBytes) + '"}',
    code: "invalid_request",
  },
  { name: "utf8 bytes", params: '{"text":"' + "🌎".repeat(70000) + '"}', code: "invalid_params" },
  {
    name: "depth",
    params: '{"nested":' + "[".repeat(1000) + "0" + "]".repeat(1000) + "}",
    code: "invalid_params",
  },
  {
    name: "nodes",
    params: JSON.stringify({ values: Array.from({ length: 17000 }, () => 0) }),
    code: "invalid_params",
  },
])("bounds parameter objects by $name", ({ params, code }) => {
  const f = fixture();
  return Effect.gen(function* () {
    const session = yield* open(f.options);
    expect(
      (yield* Effect.flip(session.invoke("connection:one", request("bounded", params)))).code,
    ).toBe(code);
    expect(f.calls).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.effect("preserves handler refusals and validates handler result schemas", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const session = yield* open(f.options);
    expect(
      yield* session.invoke("connection:one", request("failure", "{}", "fails")),
    ).toMatchObject({ ok: false, result: { code: "capability_denied" } });
    expect(
      (yield* session.invoke("connection:one", request("invalid", "{}", "invalid_result"))).ok,
    ).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.effect("revocation interrupts owned dispatch and prevents subsequent use", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const f = fixture(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)));
    yield* Effect.gen(function* () {
      const session = yield* open(f.options);
      const one = yield* Effect.forkChild(session.invoke("connection:one", request()));
      yield* Deferred.await(started);
      yield* session.revoke;
      expect((yield* Fiber.join(one)).ok).toBe(false);
      expect((yield* Effect.flip(session.invoke("connection:one", request()))).code).toBe(
        "session_closed",
      );
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  }),
);

it.effect("Muse unwraps string fields and pins the reply to the invoking connection", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* MuseTools.MuseAgentDirectTools;
    const session = yield* service.open(f.options);
    yield* session.acceptRegistration("connection:one", { accepted_device_commands: 3 });
    const reply = yield* session.invoke("connection:one", {
      ...request(),
      params_json: JSON.stringify({ params_json: '{"text":"Muse"}' }),
    });
    expect(reply.method).toBe("client.invoke.result");
    expect(reply.options.expectedConnectionId).toBe("connection:one");
    expect(JSON.parse(reply.params.payload_json!)).toMatchObject({ threadId, text: "Muse" });
    expect(
      (yield* Effect.flip(
        session.invoke("connection:one", {
          ...request("forged"),
          params_json: JSON.stringify({ params_json: "{}", scope: "forged" }),
        }),
      )).code,
    ).toBe("invalid_params");
  }).pipe(Effect.scoped, Effect.provide(f.museLayer));
});

it.effect("bounds the lifetime replay cache without evicting mutation receipts", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const session = yield* open(f.options);
    yield* Effect.forEach(
      Array.from({ length: NativeTools.DIRECT_TOOL_LIMITS.invocations }, (_, index) => index),
      (index) => session.invoke("connection:one", request(`invoke:${index}`)),
      { discard: true },
    );
    expect((yield* Effect.flip(session.invoke("connection:one", request("overflow")))).code).toBe(
      "capacity_exceeded",
    );
    expect((yield* session.invoke("connection:one", request("invoke:0"))).ok).toBe(true);
    expect(f.calls).toBe(NativeTools.DIRECT_TOOL_LIMITS.invocations);
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.effect("bounds concurrent session lifetimes", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* NativeTools.NativeAgentDirectTools;
    const results = yield* Effect.all(
      Array.from({ length: NativeTools.DIRECT_TOOL_LIMITS.sessions + 1 }, () =>
        service
          .open(f.options)
          .pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => "opened" })),
      ),
      { concurrency: "unbounded" },
    );
    expect(results.filter((result) => result === "opened")).toHaveLength(
      NativeTools.DIRECT_TOOL_LIMITS.sessions,
    );
    expect(results.filter((result) => result === "capacity_exceeded")).toHaveLength(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(f.layer),
    Effect.provideService(Scheduler.MaxOpsBeforeYield, 16),
  );
});

it.effect("bounds execution deadlines and caches timed-out calls", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const f = fixture(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)));
    yield* Effect.gen(function* () {
      const session = yield* open(f.options);
      const one = yield* Effect.forkChild(
        session.invoke("connection:one", { ...request(), timeout_ms: 100 }),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(100);
      expect(yield* Fiber.join(one)).toMatchObject({
        ok: false,
        error: { code: "deadline_exceeded" },
      });
      expect((yield* session.invoke("connection:one", { ...request(), timeout_ms: 100 })).ok).toBe(
        false,
      );
      expect(f.calls).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  }),
);

it.effect("bounds encoded results without retrying the handler", () => {
  let calls = 0;
  const toolkit = Toolkit.make(Tool.make("large", { success: Schema.String }));
  const handlers = McpToolAccess.toLayer(toolkit, {
    large: McpToolAccess.reads(() =>
      Effect.sync(() => {
        calls++;
        return "x".repeat(NativeTools.DIRECT_TOOL_LIMITS.resultBytes + 1);
      }),
    ),
  });
  const layer = NativeTools.layer(toolkitRegistration(toolkit, handlers));
  return Effect.gen(function* () {
    const service = yield* NativeTools.NativeAgentDirectTools;
    const session = yield* service.open({
      scope: scope(),
      connectionId: "connection:one",
      validate: () => Effect.succeed(true),
    });
    yield* session.acceptRegistration("connection:one", { accepted_device_commands: 1 });
    const result = yield* session.invoke("connection:one", request("large", "{}", "large"));
    expect(result).toMatchObject({ ok: false, error: { code: "result_too_large" } });
    expect(yield* session.invoke("connection:one", request("large", "{}", "large"))).toEqual(
      result,
    );
    expect(calls).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(layer));
});
