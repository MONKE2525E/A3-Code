import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ManagedEndpointAddress from "../cloud/ManagedEndpointAddress.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  GROK_BOT_MANAGED_MCP_SERVER,
  GROK_BOT_MANAGED_SKILL_NAME,
  GROK_BOT_MANAGED_SKILL_BODY,
  GROK_BOT_MANAGED_WORKFLOW_PATH,
  GrokBotBindingError,
  GrokBotManagedBinding,
  grokBotManagedPrompt,
  type GrokBotBoundSession,
  type GrokBotManagedTurn,
} from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import {
  grokBotTurnIdentity,
  type GrokBotTurnIdentity,
} from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";
import * as ManagedState from "./GrokBotManagedStateStore.ts";
import * as NativeRuntime from "./GrokBotNativeRuntimeService.ts";

const unavailable = (reason: string) => new GrokBotBindingError({ reason });
const isBindingError = Schema.is(GrokBotBindingError);
const encodeNonceIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const make = Effect.gen(function* () {
  const native = yield* NativeRuntime.GrokBotNativeRuntimeService;
  const store = yield* ManagedState.GrokBotManagedStateStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const endpoint = yield* ManagedEndpointAddress.ManagedEndpointAddress;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettings.ServerSettingsService;
  const skillDigest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(GROK_BOT_MANAGED_SKILL_BODY),
  );
  const skillHash = Buffer.from(skillDigest).toString("hex");
  // This is only the in-process revocation handle; SQL stores hashes, never bearer tokens.
  const leases = new Map<string, Set<string>>();
  const accountIsCurrent = (binding: string) =>
    native.accountBinding.pipe(
      Effect.flatMap((current) =>
        current === binding
          ? Effect.void
          : Effect.fail(unavailable("The selected Grok Bot account or team changed.")),
      ),
      Effect.mapError(() => unavailable("The selected Grok Bot account or team changed.")),
    );
  const validateIdentity = Effect.fnUntraced(function* (identity: GrokBotTurnIdentity) {
    yield* accountIsCurrent(identity.native.binding);
    const shell = yield* projections.getThreadShell(identity.native.threadId);
    if (
      shell === null ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.providerInstanceId !== identity.native.providerInstanceId ||
      shell.modelSelection.model !== identity.native.botId ||
      (shell.activeRunId !== identity.runId &&
        !(shell.latestRunId === identity.runId && shell.status === "waiting"))
    )
      return false;
    const records = yield* projections.getThreadRecords(
      identity.native.threadId,
      ["runs", "attempts"],
      {
        runIds: [identity.runId],
      },
    );
    const run = records.runs.find((candidate) => candidate.id === identity.runId);
    const attempt = records.attempts.find((candidate) => candidate.id === identity.attemptId);
    return (
      run !== undefined &&
      attempt !== undefined &&
      ["starting", "running", "waiting"].includes(run.status) &&
      run.providerInstanceId === identity.native.providerInstanceId &&
      run.modelSelection.model === identity.native.botId &&
      run.activeAttemptId === identity.attemptId &&
      run.rootNodeId === identity.rootNodeId &&
      run.providerThreadId === identity.providerThreadId &&
      run.ordinal === identity.runOrdinal &&
      attempt.runId === run.id &&
      attempt.rootNodeId === identity.rootNodeId &&
      attempt.providerInstanceId === identity.native.providerInstanceId &&
      attempt.providerThreadId === identity.providerThreadId &&
      (attempt.providerTurnId === null || attempt.providerTurnId === identity.providerTurnId) &&
      ["pending", "running"].includes(attempt.status)
    );
  });
  const prepareTurn = Effect.fnUntraced(function* (input: {
    readonly native: GrokBotBoundSession;
    readonly turn: GrokBotManagedTurn["input"];
    readonly providerTurnId: GrokBotManagedTurn["providerTurnId"];
    readonly providerSessionId: string;
  }) {
    const turn = input.turn;
    // Reject oversized user input before issuing any run credential.
    if (grokBotManagedPrompt(turn.message.text).length > 1000000)
      return yield* unavailable("The managed prompt exceeds the native message limit.");
    if (
      turn.threadId !== input.native.threadId ||
      turn.modelSelection.instanceId !== input.native.providerInstanceId ||
      turn.modelSelection.model !== input.native.botId ||
      turn.providerThread.appThreadId !== input.native.threadId ||
      turn.providerThread.providerInstanceId !== input.native.providerInstanceId
    )
      return yield* unavailable("The turn does not belong to this native bot binding.");
    const publicEndpoint = yield* endpoint.read;
    if (publicEndpoint === null)
      return yield* unavailable(
        "Link this isolated environment to T3 Connect before starting a bot run.",
      );
    const nonceInput = yield* encodeNonceIdentity([
      input.native.binding,
      input.native.botId,
      input.native.sessionId,
      turn.threadId,
      turn.runId,
      turn.attemptId,
      turn.message.messageId,
    ]);
    const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(nonceInput));
    const messageId = `t3-${Buffer.from(hash).toString("hex")}`;
    const identity: GrokBotTurnIdentity = {
      native: input.native,
      messageId,
      sentAtMs: yield* Clock.currentTimeMillis,
      runId: turn.runId,
      attemptId: turn.attemptId,
      rootNodeId: turn.rootNodeId,
      providerThreadId: turn.providerThread.id,
      providerTurnId: input.providerTurnId,
      runOrdinal: turn.runOrdinal,
      providerTurnOrdinal: turn.providerTurnOrdinal,
    };
    if (!(yield* validateIdentity(identity)))
      return yield* unavailable("This provider no longer owns the active run attempt.");
    // The workflow is shared and installed explicitly during provider setup. Ordinary
    // turns only read it; missing skills must not trigger a giant installation prompt.
    const skill = {
      skillId: GROK_BOT_MANAGED_SKILL_NAME,
      hash: skillHash,
      changed: false,
      workflowPath: GROK_BOT_MANAGED_WORKFLOW_PATH,
    };
    if (!(yield* validateIdentity(identity)))
      return yield* unavailable("This provider no longer owns the active run attempt.");
    const saved = yield* store.prepareTurn({
      ...identity,
      ...(skill === undefined ? {} : { managedSkill: skill }),
    });
    const verifiedSkill =
      skill === undefined || saved.managedSkill === undefined
        ? undefined
        : ("workflowPath" in skill ? skill.workflowPath : undefined) ===
            saved.managedSkill.workflowPath
          ? { ...saved.managedSkill, changed: saved.managedSkill.changed || skill.changed }
          : { ...saved.managedSkill, changed: true };
    const nativePrompt = grokBotManagedPrompt(turn.message.text, verifiedSkill);
    if (nativePrompt.length > 1000000)
      return yield* unavailable("The managed prompt exceeds the native message limit.");
    const access = yield* settings.getSettings.pipe(
      Effect.map((all) => resolveProjectSettings(all, turn.appThread.projectId).settings),
      Effect.map((effective) => ({
        browser: effective.enableAgentBrowserAccess,
        device: effective.enableAgentDeviceAccess,
      })),
      Effect.orElseSucceed(() => ({ browser: false, device: false })),
    );
    const capabilities = new Set<import("../mcp/McpInvocationContext.ts").McpCapability>([
      "orchestration",
      "worktree",
      "pull-requests",
    ]);
    if (access.browser) capabilities.add("preview");
    if (access.device) capabilities.add("device");
    // Own the grant from issuance through handoff; failed or interrupted validation revokes it.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const credential = yield* registry.issue({
          threadId: input.native.threadId,
          providerInstanceId: input.native.providerInstanceId,
          remoteRun: { runId: saved.runId, attemptId: saved.attemptId },
          // The same thread preference limits both local and cloud agent browser access.
          browserToolsAvailable: access.browser,
          capabilities,
        });
        return yield* restore(
          Effect.gen(function* () {
            // Settings and credential issuance yield; the run may have been replaced in that time.
            if (!(yield* validateIdentity(saved)))
              return yield* unavailable("This provider no longer owns the active run attempt.");
          }),
        ).pipe(
          Effect.map(() => {
            const mcpEndpoint = new URL("/mcp", publicEndpoint.httpBaseUrl);
            // Native cloud discovery caches by URL. Version the managed tool contract so an
            // older catalog cannot hide the completion tool after an integration upgrade.
            mcpEndpoint.searchParams.set("t3-managed-protocol", "2");
            const handles = leases.get(input.providerSessionId) ?? new Set<string>();
            handles.add(credential.config.providerSessionId);
            leases.set(input.providerSessionId, handles);
            return {
              native: saved.native,
              input: turn,
              providerTurnId: saved.providerTurnId,
              messageId: saved.messageId,
              sentAtMs: saved.sentAtMs,
              nativePrompt,
              ...(saved.managedSkill === undefined ? {} : { managedSkill: saved.managedSkill }),
              mcpConfig: {
                mcpServers: {
                  // A saved native connector can shadow a per-turn connector with the same name.
                  [GROK_BOT_MANAGED_MCP_SERVER]: {
                    type: "http" as const,
                    url: mcpEndpoint.href,
                    headers: { Authorization: credential.config.authorizationHeader },
                    placement: "server" as const,
                  },
                },
              },
            };
          }),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? registry.revokeProviderSession(credential.config.providerSessionId)
              : Effect.void,
          ),
        );
      }),
    );
  });
  return GrokBotManagedBinding.of({
    availability: Effect.gen(function* () {
      yield* native.accountBinding;
      return (yield* endpoint.read) === null
        ? {
            ready: false,
            reason: "Link this isolated environment to T3 Connect before starting a bot run.",
          }
        : { ready: true };
    }).pipe(
      Effect.mapError(() =>
        unavailable("The native bot account or confirmed T3 Connect endpoint is unavailable."),
      ),
    ),
    resolve: (input) =>
      Effect.gen(function* () {
        yield* accountIsCurrent(input.accountBinding);
        const shell = yield* projections.getThreadShell(input.threadId);
        if (
          shell === null ||
          shell.deletedAt !== null ||
          shell.archivedAt !== null ||
          shell.providerInstanceId !== input.providerInstanceId ||
          shell.modelSelection.model !== input.botId
        )
          return yield* unavailable("The app thread does not select this native bot.");
        const context = yield* native.sessionContext({
          binding: input.accountBinding,
          botId: input.botId,
        });
        if (context.bot.viewerIsOwner !== true)
          return yield* unavailable(
            "Managed bot runs currently require verified ownership of the native main session.",
          );
        yield* accountIsCurrent(input.accountBinding);
        return yield* store.acquire({
          binding: input.accountBinding,
          botId: input.botId,
          sessionId: "",
          threadId: input.threadId,
          providerInstanceId: input.providerInstanceId,
          generation: 0,
          afterUpdatedSeq: "0",
        });
      }).pipe(
        Effect.mapError(() =>
          unavailable(
            "The native bot session is unavailable or already bound to another app thread.",
          ),
        ),
      ),
    prepareTurn: (input) =>
      prepareTurn(input).pipe(
        Effect.mapError((cause) =>
          isBindingError(cause) ? cause : unavailable("The managed turn could not be prepared."),
        ),
      ),
    accepted: ({ turn, ...receipt }) =>
      store
        .accepted({ identity: grokBotTurnIdentity(turn), ...receipt })
        .pipe(
          Effect.mapError(() =>
            unavailable("The native acceptance receipt could not be committed."),
          ),
        ),
    uncertain: ({ turn }) =>
      store
        .uncertain(grokBotTurnIdentity(turn))
        .pipe(
          Effect.mapError(() =>
            unavailable("The uncertain native delivery could not be retained."),
          ),
        ),
    existingMessage: (owned, id) =>
      Effect.gen(function* () {
        yield* accountIsCurrent(owned.binding);
        const records = yield* projections.getThreadRecords(owned.threadId, ["messages"], {
          messageIds: [id],
          messageRoles: ["user"],
        });
        return records.messages[0];
      }).pipe(Effect.mapError(() => unavailable("The existing native message could not be read."))),
    lookupTranscriptTurn: (owned, messageId) =>
      Effect.gen(function* () {
        yield* accountIsCurrent(owned.binding);
        return yield* store.lookupTranscriptTurn(owned, messageId);
      }).pipe(
        Effect.mapError(() => unavailable("The native message ownership could not be read.")),
      ),
    restoreManagedMessageIds: (owned) =>
      Effect.gen(function* () {
        yield* accountIsCurrent(owned.binding);
        return yield* store.restoreManagedMessageIds(owned);
      }).pipe(
        Effect.mapError(() =>
          unavailable("The durable native delivery identities could not be restored."),
        ),
      ),
    restoreTranscriptTurns: (owned) =>
      Effect.gen(function* () {
        yield* accountIsCurrent(owned.binding);
        return yield* store.restoreTranscriptTurns(owned);
      }).pipe(
        Effect.mapError(() =>
          unavailable("The durable native transcript ownership could not be restored."),
        ),
      ),
    restoreTurns: (owned) =>
      Effect.gen(function* () {
        const turns = yield* store.restoreTurns(owned);
        const live: GrokBotTurnIdentity[] = [];
        for (const turn of turns) if (yield* validateIdentity(turn)) live.push(turn);
        return live;
      }).pipe(
        Effect.mapError(() =>
          unavailable("The durable native run bindings could not be restored."),
        ),
      ),
    lookupCompletion: (identity) =>
      Effect.gen(function* () {
        yield* accountIsCurrent(identity.native.binding);
        return yield* store.lookupCompletion(identity);
      }).pipe(
        Effect.mapError(() => unavailable("The accepted managed answer could not be restored.")),
      ),
    inFlightWork: (identity) =>
      Effect.gen(function* () {
        const records = yield* projections.getThreadRecords(
          identity.native.threadId,
          ["subagents", "turnItems"],
          {
            turnItemRunId: identity.runId,
            turnItemTypes: ["dynamic_tool"],
            turnItemStatuses: ["running"],
          },
        );
        // Tool items are written by McpToolActivity for this run only; children hang off its root node.
        return (
          records.turnItems.some(
            (item) => item.runId === identity.runId && item.nodeId === identity.rootNodeId,
          ) ||
          records.subagents.some(
            (task) =>
              (task.runId === identity.runId || task.parentNodeId === identity.rootNodeId) &&
              ["pending", "running", "waiting"].includes(task.status),
          )
        );
      }).pipe(Effect.catchCause(() => Effect.succeed(true))),
    openCompletionWatch: (owned) =>
      Effect.gen(function* () {
        yield* accountIsCurrent(owned.binding);
        const stream = yield* store.openCompletionWatch(owned);
        // Account and committed attempt ownership are checked again when a declaration is replayed.
        return stream.pipe(
          Stream.filterEffect((declaration) => validateIdentity(declaration.identity)),
          Stream.mapError(() => unavailable("Managed completion authority could not be verified.")),
        );
      }).pipe(
        Effect.mapError(() =>
          unavailable("Managed completion declarations could not be restored."),
        ),
      ),
    // Stop is intentionally session-scoped: the native API stops the selected bot session,
    // including work started through its native client. It does not accept a delivery nonce.
    verifyInterrupt: ({ native: owned, providerThreadId, providerTurnId }) =>
      Effect.gen(function* () {
        yield* accountIsCurrent(owned.binding);
        const binding = yield* store.get(owned);
        const shell = yield* projections.getThreadShell(owned.threadId);
        if (
          binding?.threadId !== owned.threadId ||
          binding.providerInstanceId !== owned.providerInstanceId ||
          shell === null ||
          shell.deletedAt !== null ||
          shell.archivedAt !== null ||
          shell.providerInstanceId !== owned.providerInstanceId ||
          shell.modelSelection.model !== owned.botId ||
          shell.activeProviderThreadId !== providerThreadId
        )
          return yield* unavailable(
            "The selected app thread no longer owns this native bot session.",
          );
        const turns = yield* store.restoreTranscriptTurns(owned);
        const turn = turns.find(
          (candidate) =>
            candidate.providerThreadId === providerThreadId &&
            candidate.providerTurnId === providerTurnId,
        );
        if (turn === undefined || (shell.activeRunId !== null && shell.activeRunId !== turn.runId))
          return yield* unavailable("The requested interrupt belongs to a replaced app turn.");
        const context = yield* native.sessionContext({
          binding: owned.binding,
          botId: owned.botId,
        });
        if (
          context.bot.agentId !== owned.botId ||
          (context.bot.viewerIsOwner !== true && context.bot.viewerCanManage !== true) ||
          (owned.sessionId !== "" &&
            !context.sessions.some(
              (session) => session.agentId === owned.botId && session.sessionId === owned.sessionId,
            ))
        )
          return yield* unavailable(
            "The selected native bot session cannot be managed by this account.",
          );
        yield* accountIsCurrent(owned.binding);
      }).pipe(
        Effect.mapError((cause) =>
          isBindingError(cause)
            ? cause
            : unavailable("The native interrupt authority could not be verified."),
        ),
      ),
    // Cursor advancement belongs to the event sink's transaction, never the live stream.
    recordCursor: () => Effect.void,
    release: ({ native: owned, providerSessionId }) =>
      Effect.gen(function* () {
        const handles = leases.get(providerSessionId);
        const preserve = yield* Effect.gen(function* () {
          const durableTurns = yield* store.restoreTurns(owned);
          for (const turn of durableTurns) if (yield* validateIdentity(turn)) return true;
          return false;
        }).pipe(Effect.orElseSucceed(() => false));
        if (preserve) return;
        leases.delete(providerSessionId);
        for (const handle of handles ?? []) yield* registry.revokeProviderSession(handle);
      }).pipe(Effect.orElseSucceed(() => undefined)),
  });
});

export const layer = Layer.effect(GrokBotManagedBinding, make);
