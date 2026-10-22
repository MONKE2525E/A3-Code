import { ProviderDriverKind, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ManagedState from "../grokBot/GrokBotManagedStateStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpRemoteRunValidator from "./McpRemoteRunValidator.ts";

interface Observer {
  readonly observe: <A, E, R>(
    toolName: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/** Local providers already report their tools. Only managed remote callers need host observations. */
export class McpToolActivity extends Context.Reference<Observer>("t3/mcp/McpToolActivity", {
  defaultValue: () => ({ observe: (_, effect) => effect }),
}) {}

/** Assigned by registration, never read from a caller's tool parameters. */
export class RegisteredToolName extends Context.Reference<string | undefined>(
  "t3/mcp/RegisteredToolName",
  { defaultValue: () => undefined },
) {}

/** Declarations call this after their access check, before executing the handler. */
export const observe = Effect.fn("McpToolActivity.observe")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const name = yield* RegisteredToolName;
  return yield* name === undefined ? effect : (yield* McpToolActivity).observe(name, effect);
});

const driver = ProviderDriverKind.make("grok-bot");
type ToolItem = Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>;

const make = Effect.gen(function* () {
  const authority = yield* McpRemoteRunValidator.McpRemoteRunValidator;
  const managed = yield* ManagedState.GrokBotManagedStateStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

  const begin = Effect.fn("McpToolActivity.begin")(function* (toolName: string) {
    const context = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    if (Option.isNone(context) || toolName === "grok_bot_complete_turn") return;
    const scope = context.value;
    const caller = scope.thread;
    const remote = caller?.remoteRun;
    if (caller === undefined || remote === undefined || scope.client !== undefined) return;
    return yield* commands.withLock(
      caller.threadId,
      Effect.gen(function* () {
        if (!(yield* authority.validate({ ...scope, thread: caller }))) return;
        const owned = yield* managed.lookupTurn(remote);
        if (
          owned === undefined ||
          owned.state === "settled" ||
          owned.identity.native.threadId !== caller.threadId ||
          owned.identity.native.providerInstanceId !== caller.providerInstanceId
        )
          return;
        const identity = owned.identity;
        const records = yield* projections.getThreadRecords(
          caller.threadId,
          ["runs", "providerThreads"],
          { runIds: [remote.runId] },
        );
        const run = records.runs.find((candidate) => candidate.id === remote.runId);
        const providerThread = records.providerThreads.find(
          (candidate) => candidate.id === identity.providerThreadId,
        );
        if (
          run === undefined ||
          !["starting", "running", "waiting"].includes(run.status) ||
          run.activeAttemptId !== remote.attemptId ||
          run.rootNodeId !== identity.rootNodeId ||
          run.providerInstanceId !== caller.providerInstanceId ||
          providerThread?.providerSessionId == null ||
          providerThread.appThreadId !== caller.threadId ||
          providerThread.providerInstanceId !== caller.providerInstanceId
        )
          return;
        const now = yield* DateTime.now;
        const item: ToolItem = {
          id: TurnItemId.make(`mcp-call:${yield* randomUuidV4}`),
          type: "dynamic_tool",
          threadId: caller.threadId,
          runId: remote.runId,
          nodeId: identity.rootNodeId,
          providerThreadId: identity.providerThreadId,
          providerTurnId: identity.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "running",
          title: toolName,
          toolName,
          input: {},
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const source = {
          providerSessionId: providerThread.providerSessionId,
          providerInstanceId: caller.providerInstanceId,
          threadId: caller.threadId,
          runId: remote.runId,
          nodeId: identity.rootNodeId,
        };
        const stored = yield* ingestor.ingestNormalized({
          ...source,
          writeIfRunCurrent: {
            runId: remote.runId,
            activeAttemptId: remote.attemptId,
            expectedStatus: run.status,
          },
          event: { type: "turn_item.updated", driver, turnItem: item },
        });
        if (stored.length === 0) return;
        return { source, item };
      }),
    );
  });

  const finish = (
    call: NonNullable<Effect.Success<ReturnType<typeof begin>>>,
    status: ToolItem["status"],
  ) =>
    commands.withLock(
      call.item.threadId,
      Effect.gen(function* () {
        const current = yield* projections.getTurnItem({
          threadId: call.item.threadId,
          itemId: call.item.id,
        });
        if (
          current?.type !== "dynamic_tool" ||
          current.status !== "running" ||
          current.runId !== call.item.runId ||
          current.nodeId !== call.item.nodeId
        )
          return;
        const now = yield* DateTime.now;
        // The call can finish after its run settles. Close only the captured item;
        // never rebind it to the thread's next run or mutate run execution state.
        yield* ingestor.ingestNormalized({
          ...call.source,
          event: {
            type: "turn_item.updated",
            driver,
            turnItem: { ...call.item, status, completedAt: now, updatedAt: now },
          },
        });
      }),
    );

  const unavailable = () => Effect.logWarning("MCP tool activity could not be recorded.");
  return {
    observe: <A, E, R>(toolName: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        begin(toolName).pipe(Effect.catchCause(() => unavailable().pipe(Effect.as(undefined)))),
        // Do not hold the thread lock while tools delegate, wait, or dispatch commands.
        () => effect,
        (call, exit) =>
          call === undefined
            ? Effect.void
            : finish(
                call,
                Exit.isSuccess(exit)
                  ? "completed"
                  : Cause.hasInterrupts(exit.cause)
                    ? "interrupted"
                    : "failed",
              ).pipe(Effect.catchCause(unavailable)),
      ),
  } satisfies Observer;
});

export const layer = Layer.effect(McpToolActivity, make);
