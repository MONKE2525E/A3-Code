import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProvider } from "./server.ts";
import { MuseAgentProfile, MuseAgentStatus } from "./museAgent.ts";
import * as Features from "./museAgentFeatures.ts";
import * as Computer from "./museAgentComputer.ts";
import * as Dictation from "./museAgentDictation.ts";
import { RunId, ThreadId } from "./baseSchemas.ts";

export const NativeAgentPendingDelivery = Schema.Struct({
  deliveryKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  status: Schema.Literals(["intent", "accepted"]),
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  releasable: Schema.Boolean,
  blockedReason: Schema.NullOr(
    Schema.Literals(["legacy_context", "run_active", "context_changed"]),
  ),
});
export type NativeAgentPendingDelivery = typeof NativeAgentPendingDelivery.Type;

const featureReference = { providerInstanceId: ProviderInstanceId };
export const MuseCredentialRequest = Schema.Struct({
  requestId: Schema.String,
  sessionId: Schema.String,
  title: Schema.String,
  pageUrl: Schema.String,
  capture: Schema.Literals(["sign_in", "verification_code"]),
  usernameLabel: Schema.String,
  passwordLabel: Schema.String,
  codeLabel: Schema.String,
});
const featureRead = <O extends string>(operation: O) =>
  Schema.Struct({ ...featureReference, operation: Schema.Literal(operation) });
const NativeAgentHistoryCursor = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const NativeAgentHistoryPage = Schema.Struct({
  nextBeforeSeq: Schema.NullOr(NativeAgentHistoryCursor),
  hasMore: Schema.Boolean,
  importedMessages: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const NativeAgentFeatureReadInput = Schema.Union([
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("credential_requests"),
    sessionId: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    ),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("history_page"),
    threadId: ThreadId,
  }),
  featureRead("dictation"),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("computer_task"),
    sessionId: Computer.MuseAgentComputerId,
    taskId: Computer.MuseAgentComputerId,
  }),
  featureRead("inventory"),
  featureRead("tasks"),
  featureRead("connectors"),
  featureRead("skills"),
  featureRead("computer"),
  featureRead("profile_themes"),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("pending_deliveries"),
    sessionId: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    ),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literals(["connector_info", "connector_accounts"]),
    connectorId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("profile_document"),
    document: Features.MuseAgentProfileDocumentKind,
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("memory_search"),
    query: Schema.String.check(Schema.isMaxLength(8192)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("memory_read"),
    uri: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("task_runs"),
    jobId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("sessions"),
    view: Schema.optionalKey(Schema.Literals(["active", "archived"])),
  }),
]);
export const NativeAgentFeatureReadResult = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("credential_requests"),
    data: Schema.Struct({
      sessionId: Schema.String,
      requests: Schema.Array(MuseCredentialRequest),
    }),
  }),
  Schema.Struct({
    operation: Schema.Literal("history_page"),
    data: NativeAgentHistoryPage,
  }),
  Schema.Struct({
    operation: Schema.Literal("dictation"),
    data: Dictation.MuseAgentDictationStatus,
  }),
  Schema.Struct({
    operation: Schema.Literal("computer_task"),
    data: Computer.MuseAgentComputerTaskDetail,
  }),
  Schema.Struct({
    operation: Schema.Literal("pending_deliveries"),
    data: Schema.Struct({
      sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
      deliveries: Schema.Array(NativeAgentPendingDelivery).check(Schema.isMaxLength(100)),
    }),
  }),
  Schema.Struct({
    operation: Schema.Literal("connector_info"),
    data: Features.MuseAgentConnectorConnectInfo,
  }),
  Schema.Struct({
    operation: Schema.Literal("connector_accounts"),
    data: Features.MuseAgentConnectorAccounts,
  }),
  Schema.Struct({
    operation: Schema.Literal("profile_document"),
    data: Features.MuseAgentProfileDocument,
  }),
  Schema.Struct({ operation: Schema.Literal("profile_themes"), data: Features.MuseAgentThemes }),
  Schema.Struct({
    operation: Schema.Literal("inventory"),
    data: Features.MuseAgentFeatureInventory,
  }),
  Schema.Struct({ operation: Schema.Literal("tasks"), data: Schema.Array(Features.MuseAgentTask) }),
  Schema.Struct({
    operation: Schema.Literal("task_runs"),
    data: Schema.Array(Features.MuseAgentTaskRun),
  }),
  Schema.Struct({
    operation: Schema.Literal("connectors"),
    data: Schema.Array(Features.MuseAgentConnector),
  }),
  Schema.Struct({
    operation: Schema.Literal("skills"),
    data: Schema.Array(Features.MuseAgentSkill),
  }),
  Schema.Struct({
    operation: Schema.Literal("sessions"),
    data: Schema.Array(Features.MuseAgentFeatureSession),
  }),
  Schema.Struct({ operation: Schema.Literal("computer"), data: Features.MuseAgentComputerStatus }),
  Schema.Struct({
    operation: Schema.Literal("memory_search"),
    data: Schema.Array(Features.MuseAgentMemory),
  }),
  Schema.Struct({ operation: Schema.Literal("memory_read"), data: Features.MuseAgentMemory }),
]);
export const NativeAgentFeatureUpdateInput = Schema.Union([
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("credential_submit"),
    sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    username: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
    password: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
    verificationCode: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("connector_auth"),
    connectorId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    authType: Schema.Literals(["api_key", "consent_only"]),
    key: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536))),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("history_page"),
    threadId: ThreadId,
    beforeSeq: NativeAgentHistoryCursor,
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("computer_action"),
    sessionId: Computer.MuseAgentComputerId,
    taskId: Computer.MuseAgentComputerId,
    command: Computer.MuseAgentComputerAction,
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("delivery_release"),
    sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    deliveryKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("connector_link"),
    connectorId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("connector_scope_link"),
    connectorId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    method: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    accountId: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    ),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("connector_disconnect"),
    connectorId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("connector_unlink"),
    connectorId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    accountId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("profile_save"),
    document: Features.MuseAgentProfileDocumentKind,
    content: Schema.String.check(Schema.isMaxLength(1048576)),
    expectedRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("profile_set_theme"),
    themeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("task_delete"),
    jobId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("session_rename"),
    sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  }),
  Schema.Struct({
    ...featureReference,
    operation: Schema.Literal("session_archive"),
    sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    archived: Schema.Boolean,
  }),
]);
export const NativeAgentFeatureUpdateResult = Schema.Struct({
  updated: Schema.Literal(true),
  historyPage: Schema.optionalKey(NativeAgentHistoryPage),
  computerState: Schema.optionalKey(Computer.MuseAgentComputerState),
  title: Schema.optionalKey(Schema.String),
  titleSyncPending: Schema.optionalKey(Schema.Literal(true)),
  authorizationUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
});

export const NativeAgentCapability = Schema.Literals([
  "chat",
  "tools",
  "profile",
  "sessions",
  "attachments",
  "memory",
  "routines",
  "connectors",
  "voice",
  "dictation",
  "computer",
]);

export const MuseAgentConnectionStatus = Schema.Struct({
  ...MuseAgentStatus.fields,
  provider: Schema.NullOr(ServerProvider),
  capabilities: Schema.Array(NativeAgentCapability),
});

export const MuseAgentReadProfileInput = Schema.Struct({
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});

/** Fetch avatar variants through the selected environment's authenticated HTTP client. */
export const MuseAgentClientProfile = Schema.Struct({
  ...MuseAgentProfile.fields,
  avatarRevision: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  avatarImageUrl: Schema.optionalKey(Schema.String),
  avatarVideoUrls: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export class NativeAgentError extends Schema.TaggedError<NativeAgentError>()("NativeAgentError", {
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  reason: Schema.Literals([
    "provider_not_ready",
    "account_changed",
    "provider_unavailable",
    "settings_failed",
    "thread_active",
    "thread_deleted",
    "thread_changed",
    "scratch_unavailable",
    "storage_failed",
  ]),
}) {
  override get message(): string {
    if (this.detail) return this.detail;
    switch (this.reason) {
      case "provider_not_ready":
        return "The native agent is not ready. Check its connection in Settings.";
      case "account_changed":
        return "The native account changed. Restore its account or connect it as a new provider.";
      case "provider_unavailable":
        return "This native agent provider is unavailable in the selected environment.";
      case "settings_failed":
        return "The native agent connection could not be saved. Try again.";
      case "thread_active":
        return "This agent's previous conversation is still running. Wait for it to finish.";
      case "thread_deleted":
        return "This agent's persistent T3 conversation was deleted.";
      case "thread_changed":
        return "This conversation uses a different provider or agent. Restore its original selection.";
      case "scratch_unavailable":
        return "Project storage is unavailable in this environment.";
      case "storage_failed":
        return "The native agent conversation could not be opened. Try again.";
    }
  }
}
