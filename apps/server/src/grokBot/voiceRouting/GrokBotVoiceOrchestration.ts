import {
  NodeId,
  RuntimeRequestId,
  OrchestratorMcpFailure,
  ThreadId,
  type GrokBotVoiceToolResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
const isOrchestratorFailure = Schema.is(OrchestratorMcpFailure);
const names = [
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_thread_launch",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_wait",
  "t3_thread_send",
  "t3_thread_update",
  "t3_thread_interrupt",
  "t3_workflow_stop",
  "schedule_task",
  "list_scheduled_tasks",
  "update_scheduled_task",
  "delete_scheduled_task",
  "t3_project_list",
] as const;
const postChatSchema = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120_000)),
});
const respondApprovalSchema = Schema.Struct({
  taskId: Schema.String,
  requestId: Schema.String,
  decision: Schema.Literals(["accept", "decline"]),
  userConfirmed: Schema.Boolean,
});
const decodePostChat = Schema.decodeUnknownEffect(postChatSchema);
const decodeRespondApproval = Schema.decodeUnknownEffect(respondApprovalSchema);
export const isTool = (
  name: string,
): name is (typeof names)[number] | "t3_post_call_message" | "t3_respond_call_approval" =>
  names.some((candidate) => candidate === name) ||
  name === "t3_post_call_message" ||
  name === "t3_respond_call_approval";

/** The actual MCP catalog schemas and descriptions, exposed as client-brokered realtime functions. */
export const tools = [
  ...names.map((name) => {
    const tool = toolkit.tools[name];
    const document = Schema.toJsonSchemaDocument(tool.parametersSchema);
    return {
      type: "function",
      name,
      description: tool.description ?? "",
      parameters: { ...document.schema, $defs: document.definitions },
    };
  }),
  ...[
    {
      name: "t3_post_call_message",
      description:
        "Post text directly into this bot's T3 chat when the caller asks for a written message. Does not start another agent turn. Do not send a user request to the bot itself with t3_thread_send.",
      schema: postChatSchema,
    },
    {
      name: "t3_respond_call_approval",
      description:
        "Approve or decline one pending request from a child delegated by this call, only after the caller explicitly tells you to. Use taskId and requestId from the approval notice. userConfirmed must reflect the caller's actual instruction. Never infer consent or approve all future requests.",
      schema: respondApprovalSchema,
    },
  ].map(({ name, description, schema }) => {
    const document = Schema.toJsonSchemaDocument(schema);
    return {
      type: "function",
      name,
      description,
      parameters: { ...document.schema, $defs: document.definitions },
    };
  }),
];
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
      input: CallIdentity & {
        readonly taskId: string;
        readonly access: "read" | "operate";
        readonly seenApprovalIds?: readonly string[];
      },
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
  const activationFailures = new Map<string, OrchestratorMcpFailure>();
  const scopeFor = (input: CallIdentity & { readonly access: "read" | "operate" }) =>
    Effect.gen(function* () {
      const call = calls.get(input.callId);
      if (
        call?.scope === undefined ||
        call.identity.binding !== input.binding ||
        call.identity.botId !== input.botId
      )
        return yield* (
          activationFailures.get(input.callId) ??
            new OrchestratorMcpFailure({
              code: "parent_not_active",
              message: "This voice call has no live delegation authority.",
            })
        );
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
            // The service clamps this to the canonical bot thread's configured mode.
            access: "full-access",
          });
          if (calls.get(input.callId) !== entry) {
            yield* orchestrator.releaseCallInvocation(scope);
            return yield* new OrchestratorMcpFailure({
              code: "parent_not_active",
              message: "This voice call ended during parent acquisition.",
            });
          }
          entry.scope = scope;
          activationFailures.delete(input.callId);
        }).pipe(
          Effect.uninterruptible,
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (exit._tag === "Failure") {
                if (calls.get(input.callId) === entry) calls.delete(input.callId);
                if (entry.scope !== undefined)
                  yield* orchestrator.releaseCallInvocation(entry.scope).pipe(Effect.ignore);
              }
              yield* Deferred.succeed(entry.ready, undefined);
            }),
          ),
        );
      }).pipe(
        Effect.catchCause((cause) => {
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          activationFailures.set(
            input.callId,
            isOrchestratorFailure(error)
              ? error
              : new OrchestratorMcpFailure({
                  code: "parent_not_active",
                  message:
                    "T3 could not acquire this call's orchestration authority. Check that this bot's conversation is available, then reconnect the call.",
                }),
          );
          return Effect.logWarning("grok-bot.voice.authority-unavailable");
        }),
      ),
    forget: (callId) =>
      Effect.gen(function* () {
        const call = calls.get(callId);
        calls.delete(callId);
        activationFailures.delete(callId);
        if (call?.scope !== undefined)
          yield* orchestrator.releaseCallInvocation(call.scope).pipe(Effect.ignore);
      }),
    wait: (input) =>
      Effect.gen(function* () {
        const scope = yield* scopeFor(input);
        const result = yield* orchestrator.waitForTask(
          scope,
          NodeId.make(input.taskId),
          20_000,
          input.seenApprovalIds,
        );
        yield* scopeFor(input);
        const approvals =
          input.seenApprovalIds === undefined
            ? []
            : (result.pendingApprovals?.filter(
                (request) => !input.seenApprovalIds!.includes(request.requestId),
              ) ?? []);
        return {
          result: {
            kind: "served",
            output:
              approvals.length > 0
                ? {
                    status: "approval_required",
                    title: result.title,
                    taskId: input.taskId,
                    approvals,
                  }
                : result.waitTimedOut
                  ? null
                  : {
                      status: "landed",
                      title: result.title,
                      runStatus: result.status,
                      ...(result.status === "failed"
                        ? {
                            error:
                              "A delegated task from this call failed. Open its T3 thread for the error. That task has not been completed.",
                          }
                        : {}),
                      updates: result.summary === null ? [] : [result.summary.slice(0, 16_000)],
                    },
          },
          pending: result.waitTimedOut || approvals.length > 0,
        } as const;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            result: {
              kind: "invalid_input" as const,
              output: {
                code: error.code,
                retryable: error.code === "orchestration_error",
                error: "T3 could not check this task's result. Its status is unknown.",
              },
            },
            pending: false,
          }),
        ),
        Effect.catchCause(() =>
          Effect.succeed({
            result: {
              kind: "invalid_input",
              output: {
                code: "task_watch_failed",
                error:
                  "T3 could not check the delegated task. Tell the caller that its status is unknown; do not claim it finished.",
              },
            },
            pending: false,
          } as const),
        ),
      ),
    call: (input) =>
      Effect.gen(function* () {
        if (!isTool(input.name))
          return {
            result: { kind: "unknown_tool", output: { error: "unknown orchestration tool" } },
          } as const;
        const scope = yield* scopeFor(input);
        if (input.name === "t3_post_call_message") {
          const params = yield* decodePostChat(input.input);
          const result = yield* orchestrator.postCallChat(scope, {
            ...params,
            clientRequestId: input.toolCallId,
          });
          return {
            result: { kind: "served", output: { ...result, spoken: "Sent in chat." } },
          } as const;
        }
        if (input.name === "t3_respond_call_approval") {
          const params = yield* decodeRespondApproval(input.input);
          const result = yield* orchestrator.respondToCallApproval(scope, {
            ...params,
            taskId: NodeId.make(params.taskId),
            requestId: RuntimeRequestId.make(params.requestId),
            clientRequestId: input.toolCallId,
          });
          return {
            result: {
              kind: "served",
              output: {
                ...result,
                spoken:
                  params.decision === "accept"
                    ? "Approved that request."
                    : "Declined that request.",
              },
            },
          } as const;
        }
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
          else if (input.name === "t3_thread_launch" || input.name === "t3_thread_send")
            target = yield* decodeRunTarget(last.value.encodedResult).pipe(Effect.option);
          else if (input.name === "t3_thread_wait") {
            const waited = last.value.encodedResult;
            if (
              typeof waited === "object" &&
              waited !== null &&
              "timedOut" in waited &&
              waited.timedOut === true
            )
              target = yield* decodeRunTarget(waited).pipe(Effect.option);
          }
        }
        return {
          result: {
            kind: last.value.isFailure ? "invalid_input" : "served",
            output: last.value.encodedResult,
          },
          ...(Option.isNone(target) ? {} : { target: target.value }),
        } as const;
      }).pipe(
        Effect.provide(handlerContext),
        Effect.catch((error) =>
          Effect.succeed({
            result: {
              kind: "invalid_input",
              output: {
                tool: input.name,
                code: isOrchestratorFailure(error) ? error.code : "invalid_arguments",
                error: isOrchestratorFailure(error)
                  ? error.code === "parent_not_active"
                    ? error.message.slice(0, 500)
                    : `T3 rejected ${input.name} (${error.code}): ${error.message.slice(0, 500)}`
                  : `T3 could not run ${input.name}. Check its arguments against the tool's schema and try again.`,
              },
            },
          } as const),
        ),
        Effect.catchCause(() =>
          Effect.succeed({
            result: {
              kind: "invalid_input",
              output: {
                tool: input.name,
                code: "orchestration_unavailable",
                error: `T3 could not execute ${input.name}. Tell the caller it failed; do not claim success or repeat a write automatically.`,
              },
            },
          } as const),
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
