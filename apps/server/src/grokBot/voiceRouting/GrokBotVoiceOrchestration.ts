import {
  NodeId,
  OrchestratorMcpFailure,
  ThreadId,
  type GrokBotVoiceToolResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Toolkit, type Tool } from "effect/ai";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Invocation from "../../mcp/McpInvocationContext.ts";
import * as Access from "../../mcp/McpToolAccess.ts";
import * as Orchestrator from "../../mcp/OrchestratorMcpService.ts";
import * as Metadata from "../../mcp/ThreadMetadataMcpService.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import * as OrchestratorHandlers from "../../mcp/toolkits/orchestrator/handlers.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import * as ProjectHandlers from "../../mcp/toolkits/project/handlers.ts";

const toolkit = Toolkit.merge(OrchestratorToolkit, ProjectToolkit);
const names = [
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_thread_launch",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_wait",
  "t3_project_list",
] as const;
export const isTool = (name: string): name is (typeof names)[number] =>
  names.some((candidate) => candidate === name);

/** The actual MCP catalog schemas and descriptions, exposed as client-brokered realtime functions. */
export const tools = names.map((name) => {
  const tool = toolkit.tools[name];
  const document = Schema.toJsonSchemaDocument(tool.parametersSchema);
  return {
    type: "function",
    name,
    description: tool.description ?? "",
    parameters: { ...document.schema, $defs: document.definitions },
  };
});
const decodeRunTarget = Schema.decodeUnknownEffect(
  Schema.Struct({
    threadId: Schema.String,
    runId: Schema.String,
  }),
);
const decodeTaskTarget = Schema.decodeUnknownEffect(Schema.Struct({ taskId: Schema.String }));

export type VoiceWorkTarget =
  | { readonly taskId: string }
  | { readonly threadId: string; readonly runId: string };
interface CallIdentity {
  readonly binding: string;
  readonly botId: string;
  readonly callId: string;
}

export class GrokBotVoiceOrchestration extends Context.Service<
  GrokBotVoiceOrchestration,
  {
    readonly activate: (
      input: CallIdentity & { readonly canonicalThreadId: string },
    ) => Effect.Effect<void>;
    readonly forget: (callId: string) => Effect.Effect<void>;
    readonly wait: (
      input: CallIdentity & { readonly taskId: string; readonly access: "read" | "operate" },
    ) => Effect.Effect<{
      readonly result: typeof GrokBotVoiceToolResult.Type;
      readonly pending: boolean;
    }>;
    readonly call: (input: {
      readonly binding: string;
      readonly botId: string;
      readonly callId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly input: unknown;
      readonly access: "read" | "operate";
      readonly canonicalThreadId?: string;
    }) => Effect.Effect<{
      readonly result: typeof GrokBotVoiceToolResult.Type;
      readonly target?: VoiceWorkTarget;
    }>;
  }
>()("t3/grokBot/voiceRouting/GrokBotVoiceOrchestration") {}

const make = Effect.gen(function* () {
  const environment = yield* Environment.ServerEnvironment;
  const orchestrator = yield* Orchestrator.OrchestratorMcpService;
  const calls = new Map<
    string,
    {
      readonly identity: CallIdentity;
      readonly ready: Deferred.Deferred<void>;
      scope: Invocation.McpInvocationScope | undefined;
    }
  >();
  const scopeFor = (input: CallIdentity & { readonly access: "read" | "operate" }) =>
    Effect.gen(function* () {
      const call = calls.get(input.callId);
      if (
        call?.scope === undefined ||
        call.identity.binding !== input.binding ||
        call.identity.botId !== input.botId
      )
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "This voice call has no live delegation authority.",
        });
      yield* orchestrator.validateCallInvocation(call.scope);
      return input.access === "read"
        ? yield* orchestrator.restrictCallInvocation(call.scope, "read-only")
        : call.scope;
    });
  const ready = yield* toolkit;
  const handlerContext =
    yield* Effect.context<
      Exclude<
        Tool.HandlerServices<(typeof toolkit.tools)[(typeof names)[number]]>,
        Invocation.McpInvocationContext
      >
    >();
  return GrokBotVoiceOrchestration.of({
    activate: (input) =>
      Effect.gen(function* () {
        const prior = calls.get(input.callId);
        if (prior !== undefined) {
          yield* Deferred.await(prior.ready);
          yield* scopeFor({ ...input, access: "operate" });
          return;
        }
        const entry = {
          identity: input,
          ready: yield* Deferred.make<void>(),
          scope: undefined as Invocation.McpInvocationScope | undefined,
        };
        calls.set(input.callId, entry);
        yield* Effect.gen(function* () {
          const environmentId = yield* environment.getEnvironmentId;
          const scope = yield* orchestrator.acquireCallInvocation({
            environmentId,
            accountId: input.binding,
            botId: input.botId,
            callId: input.callId,
            threadId: ThreadId.make(input.canonicalThreadId),
            access: "approval-required",
          });
          if (calls.get(input.callId) !== entry) {
            yield* orchestrator.releaseCallInvocation(scope);
            return yield* new OrchestratorMcpFailure({
              code: "parent_not_active",
              message: "This voice call ended during parent acquisition.",
            });
          }
          entry.scope = scope;
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) && calls.get(input.callId) === entry)
                calls.delete(input.callId);
            }),
          ),
          Effect.ensuring(Deferred.succeed(entry.ready, undefined)),
        );
      }).pipe(Effect.orElseSucceed(() => undefined)),
    forget: (callId) =>
      Effect.gen(function* () {
        const call = calls.get(callId);
        calls.delete(callId);
        if (call?.scope !== undefined)
          yield* orchestrator.releaseCallInvocation(call.scope).pipe(Effect.ignore);
      }),
    wait: (input) =>
      Effect.gen(function* () {
        const scope = yield* scopeFor(input);
        const result = yield* orchestrator.waitForTask(scope, NodeId.make(input.taskId), 20_000);
        yield* scopeFor(input);
        return {
          result: {
            kind: "served",
            output: result.waitTimedOut
              ? null
              : {
                  status: "landed",
                  runStatus: result.status,
                  updates: result.summary === null ? [] : [result.summary.slice(0, 16_000)],
                },
          },
          pending: result.waitTimedOut,
        } as const;
      }).pipe(
        Effect.orElseSucceed(
          () =>
            ({
              result: { kind: "invalid_input", output: { error: "voice task unavailable" } },
              pending: false,
            }) as const,
        ),
      ),
    call: (input) =>
      Effect.gen(function* () {
        if (!isTool(input.name))
          return {
            result: { kind: "unknown_tool", output: { error: "unknown orchestration tool" } },
          } as const;
        const scope = yield* scopeFor(input);
        const params =
          typeof input.input === "object" && input.input !== null && !Array.isArray(input.input)
            ? input.input
            : {};
        const targeted = input.name === "t3_thread_read" || input.name === "t3_thread_wait";
        const argumentsValue = targeted
          ? {
              ...params,
              ...("threadId" in params ? {} : { threadId: input.canonicalThreadId }),
              ...(input.name === "t3_thread_wait" ? { timeoutMs: 20_000 } : {}),
            }
          : input.name === "delegate_task"
            ? {
                ...params,
                // The voice RPC returns a receipt; its event-driven result wait runs separately.
                mode: "async",
                ...("clientRequestId" in params ? {} : { clientRequestId: input.toolCallId }),
              }
            : params;
        const stream = yield* ready
          .handle(input.name, argumentsValue as never, input.toolCallId)
          .pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
        const last = yield* Stream.runLast(stream).pipe(
          Effect.provideService(Invocation.McpInvocationContext, scope),
        );
        if (Option.isNone(last))
          return {
            result: {
              kind: "invalid_input",
              output: { error: "orchestration returned no result" },
            },
          } as const;
        yield* scopeFor(input);
        let target: Option.Option<VoiceWorkTarget> = Option.none();
        if (!last.value.isFailure) {
          if (input.name === "delegate_task")
            target = yield* decodeTaskTarget(last.value.encodedResult).pipe(Effect.option);
          else if (input.name === "t3_thread_launch")
            target = yield* decodeRunTarget(last.value.encodedResult).pipe(Effect.option);
        }
        return {
          result: { kind: "served", output: last.value.encodedResult },
          ...(Option.isNone(target) ? {} : { target: target.value }),
        } as const;
      }).pipe(
        Effect.provide(handlerContext),
        Effect.orElseSucceed(
          () =>
            ({
              result: { kind: "invalid_input", output: { error: "orchestration tool failed" } },
            }) as const,
        ),
      ),
  });
});

export const layer = Layer.effect(GrokBotVoiceOrchestration, make);
export const layerLive = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Access.HandlersLayer.layer(OrchestratorHandlers.layer),
      Access.HandlersLayer.layer(ProjectHandlers.layer),
    ),
  ),
  Layer.provide(Orchestrator.layer),
  Layer.provide(Metadata.layer),
);
