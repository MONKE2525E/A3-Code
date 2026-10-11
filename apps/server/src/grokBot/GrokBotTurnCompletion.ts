import {
  GrokBotCompletionError,
  type GrokBotCompleteTurnInput,
  type GrokBotCompleteTurnResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpRemoteRunValidator from "../mcp/McpRemoteRunValidator.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as GrokBotManagedStateStore from "./GrokBotManagedStateStore.ts";
import {
  GROK_BOT_MANAGED_SKILL_BODY,
  GROK_BOT_MANAGED_WORKFLOW_PATH,
} from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";

const isCompletionError = Schema.is(GrokBotCompletionError);
const isStateConflict = Schema.is(GrokBotManagedStateStore.ManagedStateConflict);

/** A cloud bot declares its own T3 final answer; native temporal execution remains unobserved. */
export class GrokBotTurnCompletion extends Context.Service<
  GrokBotTurnCompletion,
  {
    readonly complete: (
      input: typeof GrokBotCompleteTurnInput.Type,
    ) => Effect.Effect<
      typeof GrokBotCompleteTurnResult.Type,
      GrokBotCompletionError,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("t3/grokBot/GrokBotTurnCompletion") {}

const make = Effect.gen(function* () {
  const store = yield* GrokBotManagedStateStore.GrokBotManagedStateStore;
  const authority = yield* McpRemoteRunValidator.McpRemoteRunValidator;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const crypto = yield* Crypto.Crypto;
  const hash = Buffer.from(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(GROK_BOT_MANAGED_SKILL_BODY)),
  ).toString("hex");
  return GrokBotTurnCompletion.of({
    complete: Effect.fn("GrokBotTurnCompletion.complete")(function* (input) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = scope.thread;
      const remote = caller?.remoteRun;
      if (
        caller === undefined ||
        remote === undefined ||
        scope.client !== undefined ||
        !scope.capabilities.has("orchestration")
      )
        return yield* new GrokBotCompletionError({ reason: "authority_changed" });
      return yield* commands.withLock(
        caller.threadId,
        Effect.gen(function* () {
          if (!(yield* authority.validate({ ...scope, thread: caller })))
            return yield* new GrokBotCompletionError({ reason: "authority_changed" });
          const owned = yield* store.lookupTurn(remote);
          if (owned === undefined || owned.state === "settled")
            return yield* new GrokBotCompletionError({ reason: "authority_changed" });
          // Authority comes exclusively from the grant. No target ids are accepted from the bot.
          yield* store.declareCompletion({
            identity: owned.identity,
            finalText: input.finalText,
            declaredAtMs: yield* Clock.currentTimeMillis,
            ...(input.managedSkillHash === hash &&
            owned.identity.managedSkill?.hash === hash &&
            owned.identity.managedSkill.workflowPath === GROK_BOT_MANAGED_WORKFLOW_PATH
              ? { managedSkillHash: hash }
              : {}),
          });
          return {
            declarationAccepted: true as const,
            source: "agent_declaration" as const,
            runId: owned.identity.runId,
            attemptId: owned.identity.attemptId,
            nativeWorkflowStatus: "unknown" as const,
          };
        }).pipe(
          Effect.mapError((error) =>
            isCompletionError(error)
              ? error
              : new GrokBotCompletionError({
                  reason: isStateConflict(error) ? "conflicting_declaration" : "storage_failed",
                }),
          ),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(GrokBotTurnCompletion, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
