import * as Schema from "effect/Schema";
import { GrokBotId, GrokBotStatus } from "./grokBot.ts";
import { ServerProvider } from "./server.ts";
import { ProjectId, RunAttemptId, RunId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const GrokBotOpenThreadInput = Schema.Struct({
  botId: GrokBotId,
  /** Accepted for older clients; bot conversations always use No project. */
  projectId: Schema.optionalKey(ProjectId),
});

export const GrokBotOpenThreadResult = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
});

export const GrokBotCompleteTurnInput = Schema.Struct({
  finalText: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000000)),
  /** Acknowledge the exact expected protocol only after reading the native workflow skill. */
  managedSkillHash: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
/** Acceptance of an explicit T3 turn declaration says nothing about the native workflow. */
export const GrokBotCompleteTurnResult = Schema.Struct({
  declarationAccepted: Schema.Literal(true),
  source: Schema.Literal("agent_declaration"),
  runId: RunId,
  attemptId: RunAttemptId,
  nativeWorkflowStatus: Schema.Literal("unknown"),
});

export class GrokBotCompletionError extends Schema.TaggedError<GrokBotCompletionError>()(
  "GrokBotCompletionError",
  { reason: Schema.Literals(["authority_changed", "conflicting_declaration", "storage_failed"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "authority_changed":
        return "Only the native bot that owns this active T3 run attempt can declare its completion.";
      case "conflicting_declaration":
        return "This T3 turn already has a different final answer or has settled.";
      case "storage_failed":
        return "The T3 completion declaration could not be saved. Retry the same final answer.";
    }
  }
}

export class GrokBotThreadError extends Schema.TaggedError<GrokBotThreadError>()(
  "GrokBotThreadError",
  {
    reason: Schema.Literals([
      "provider_not_ready",
      "account_changed",
      "project_required",
      "project_unavailable",
      "scratch_unavailable",
      "thread_active",
      "thread_deleted",
      "thread_changed",
      "storage_failed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider_not_ready":
        return "The native Grok Bot provider is not ready. Check its status in Settings.";
      case "account_changed":
        return "The selected Grok Bot account changed. Open the bot again after restoring its account.";
      case "project_required":
        return "Choose a project to open this bot in this environment.";
      case "project_unavailable":
        return "The selected project is unavailable. Choose an existing project to open this bot.";
      case "scratch_unavailable":
        return "Grok Bot conversations require No project storage, which is unavailable in this environment.";
      case "thread_active":
        return "This bot is still running in its previous project. Open it again after its work finishes.";
      case "thread_deleted":
        return "This bot's persistent conversation was deleted.";
      case "thread_changed":
        return "This bot's persistent conversation now uses a different provider or model. Restore its bot selection to continue.";
      case "storage_failed":
        return "The Grok Bot thread could not be opened. Try again.";
    }
  }
}

export const GrokBotOrchestratorStatusInput = Schema.Struct({
  botId: Schema.optionalKey(GrokBotId),
});

/** Omitted action inspects. Setup explicitly changes local provider settings. */
export const GrokBotOrchestratorInput = Schema.Struct({
  ...GrokBotOrchestratorStatusInput.fields,
  action: Schema.optionalKey(Schema.Literals(["status", "setup", "send_setup_prompt"])),
});

export const GrokBotSetupStatus = Schema.Struct({
  phase: Schema.Literals([
    "needs_setup",
    "needs_primary",
    "needs_prerequisite",
    "sending",
    "awaiting_authorization",
    "verifying",
    "complete",
    "stalled",
    "failed",
  ]),
  complete: Schema.Boolean,
  primaryBot: Schema.NullOr(Schema.Struct({ id: GrokBotId, name: Schema.String })),
  mcpUrl: Schema.NullOr(Schema.String),
  terminalCommand: Schema.NullOr(Schema.String),
  authorizationUrl: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  updatedAtMs: Schema.Number,
});
export type GrokBotSetupStatus = typeof GrokBotSetupStatus.Type;

export const GrokBotSetupVerificationInput = Schema.Struct({
  nonce: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128)),
  managedSkillHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export const GrokBotOrchestratorConfig = Schema.Struct({
  bridge: GrokBotStatus,
  botIds: Schema.Array(GrokBotId),
  provider: Schema.NullOr(ServerProvider),
  state: Schema.Literals([
    "not_configured",
    "ready",
    "blocked",
    "account_changed",
    "native_account_unavailable",
  ]),
  authentication: Schema.Literal("native_account"),
  directDelegationSupported: Schema.Literal(true),
  publicEndpointReadiness: Schema.Struct({
    ready: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
  }),
  instructions: Schema.String,
  setupStatus: Schema.optionalKey(GrokBotSetupStatus),
  /** Shared native workflow installation, shown once during provider setup or repair. */
  skillSetup: Schema.optionalKey(
    Schema.Struct({
      prompt: Schema.String,
      workflowPath: Schema.String,
    }),
  ),
});

export class GrokBotOrchestratorError extends Schema.TaggedError<GrokBotOrchestratorError>()(
  "GrokBotOrchestratorError",
  {
    reason: Schema.Literals([
      "native_account_unavailable",
      "account_changed",
      "provider_unavailable",
      "settings_failed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "native_account_unavailable":
        return "Sign in to the native Grok Bot app before setting up its T3 provider.";
      case "account_changed":
        return "This Grok Bot provider belongs to a different account or team. Restore that selection or remove the old provider in Settings before setting up another.";
      case "provider_unavailable":
        return "The native Grok Bot provider is unavailable in this environment.";
      case "settings_failed":
        return "The Grok Bot provider settings could not be saved or loaded.";
    }
  }
}
