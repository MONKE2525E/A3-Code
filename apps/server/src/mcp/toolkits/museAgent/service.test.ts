import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NativeAgentError,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Native from "../../../nativeAgents/NativeAgentService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as Orchestrator from "../../OrchestratorMcpService.ts";
import { toolkitRegistration } from "../../direct/toolkit.ts";
import * as Handlers from "./handlers.ts";
import * as Service from "./service.ts";
import { MuseAgentToolkit } from "./tools.ts";

const instanceId = ProviderInstanceId.make("muse-test");
const threadId = ThreadId.make("muse-agent:synthetic");
const scope = (
  access: "read-only" | "full-access" = "full-access",
): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "caller:test",
  thread: undefined,
  client: { sessionId: "oauth:test", label: "test", access },
});
const fixture = (refuseOpen = false) => {
  const opened: Parameters<Native.NativeAgentService["Service"]["open"]>[0][] = [];
  const sends: Array<{
    scope: Invocation.McpInvocationScope;
    input: Parameters<Orchestrator.OrchestratorMcpService["Service"]["sendToThread"]>[1];
  }> = [];
  const native = Layer.mock(Native.NativeAgentService)({
    status: Effect.succeed({
      installed: true,
      sessionPresent: true,
      ready: false,
      message: "Native status may contain private data",
      accountBinding: "a".repeat(64),
      provider: null,
      capabilities: ["chat"],
    }),
    openAuthorized: (reference, authorize) =>
      Effect.gen(function* () {
        yield* authorize ?? Effect.void;
        opened.push(reference);
        if (refuseOpen) return yield* new NativeAgentError({ reason: "account_changed" });
        return { threadId, providerInstanceId: instanceId };
      }),
  });
  const orchestration = Layer.mock(Orchestrator.OrchestratorMcpService)({
    sendToThread: (scope, input) =>
      Effect.sync(() => {
        sends.push({ scope, input });
        return {
          threadId,
          messageId: MessageId.make("message:sent"),
          runId: RunId.make("run:sent"),
          status: "queued" as const,
          delivery: "queued" as const,
        };
      }),
  });
  const dependencies = Layer.mergeAll(native, orchestration, liveThreadsLayer);
  return { opened, sends, dependencies, layer: Service.layer.pipe(Layer.provide(dependencies)) };
};
const input = {
  providerInstanceId: instanceId,
  sessionId: "side:test",
  message: "Synthetic message",
  clientRequestId: "stable:test",
};

it.effect("discovery does not expose account status, connect or message Muse", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentMcpService;
    expect(yield* service.discover).toEqual({ available: false, reference: null });
    expect(f.opened).toEqual([]);
    expect(f.sends).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "messages Muse through the account-bound native thread and shared checked dispatch",
  () => {
    const f = fixture();
    const caller = scope();
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentMcpService;
      expect(yield* service.send(caller, input)).toMatchObject({ threadId, delivery: "queued" });
      expect(f.opened).toEqual([
        {
          source: "muse-agent",
          agentId: "muse",
          providerInstanceId: instanceId,
          sessionId: "side:test",
        },
      ]);
      expect(f.sends).toEqual([
        {
          scope: caller,
          input: {
            threadId,
            message: input.message,
            mode: "queue",
            clientRequestId: "stable:test",
          },
        },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("never dispatches after account-bound thread resolution fails", () => {
  const f = fixture(true);
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentMcpService;
    expect(yield* Effect.flip(service.send(scope(), input))).toMatchObject({
      reason: "account_changed",
    });
    expect(f.sends).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("refuses a Muse conversation messaging itself", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentMcpService;
    const caller = {
      ...scope(),
      client: undefined,
      thread: {
        threadId,
        providerInstanceId: instanceId,
        providerSessionId: "session:test",
      },
    };
    expect(yield* Effect.flip(service.send(caller, input))).toMatchObject({
      code: "invalid_request",
    });
    expect(f.sends).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("the registered tool refuses read-only OAuth before opening or sending", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const tools = yield* toolkitRegistration(MuseAgentToolkit, Handlers.layer);
    const send = tools.find((tool) => tool.name === "muse_agent_send")!;
    expect(
      yield* send.invoke(input, "invoke:test", {
        ...scope("read-only"),
        thread: {
          threadId: ThreadId.make("thread:caller"),
          providerInstanceId: instanceId,
          providerSessionId: "session:caller",
        },
      }),
    ).toMatchObject({ isError: true, value: { code: "capability_denied" } });
    expect(f.opened).toEqual([]);
    expect(f.sends).toEqual([]);
  }).pipe(Effect.provide(f.dependencies));
});

it.effect(
  "the registered tool routes a T3 caller to Muse with the original scope and retry key",
  () => {
    const f = fixture();
    const caller = {
      ...scope(),
      client: undefined,
      thread: {
        threadId: ThreadId.make("thread:caller"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "session:caller",
      },
    };
    return Effect.gen(function* () {
      const tools = yield* toolkitRegistration(MuseAgentToolkit, Handlers.layer);
      const send = tools.find((tool) => tool.name === "muse_agent_send")!;
      expect(yield* send.invoke(input, "invoke:test", caller)).toMatchObject({
        isError: false,
        value: { threadId, delivery: "queued" },
      });
      expect(f.sends).toEqual([
        {
          scope: caller,
          input: {
            threadId,
            message: input.message,
            mode: "queue",
            clientRequestId: "stable:test",
          },
        },
      ]);
      expect(
        yield* send.invoke({ ...input, accountBinding: "forged" }, "invoke:forged", caller),
      ).toMatchObject({ isError: true });
      expect(f.sends).toHaveLength(1);
    }).pipe(Effect.provide(f.dependencies));
  },
);

it.effect("passes the live authorization check through native opening before dispatch", () => {
  const f = fixture();
  const denied = new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Caller stopped",
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentMcpService;
    expect(yield* Effect.flip(service.send(scope(), input, Effect.fail(denied)))).toBe(denied);
    expect(f.opened).toEqual([]);
    expect(f.sends).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});
