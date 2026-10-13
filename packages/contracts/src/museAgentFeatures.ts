import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Text = Schema.String.check(Schema.isMaxLength(8192));
const Content = Schema.String.check(Schema.isMaxLength(131072));

export const MuseAgentFeature = Schema.Literals([
  "inventory",
  "memory",
  "tasks",
  "connectors",
  "skills",
  "sessions",
  "profile",
  "computer",
  "dictation",
]);
export type MuseAgentFeature = typeof MuseAgentFeature.Type;

/** Documented means implemented from native client evidence, not verified on the user's account. */
export const MuseAgentFeatureInventory = Schema.Struct({
  accountAvailability: Schema.Literal("unverified"),
  features: Schema.Array(
    Schema.Struct({
      feature: MuseAgentFeature,
      operations: Schema.Array(
        Schema.Literals([
          "search",
          "read",
          "list",
          "runs",
          "delete",
          "rename",
          "archive",
          "unarchive",
          "status",
          "read_document",
          "save_document",
          "themes",
          "set_theme",
          "transcribe",
          "history_page",
        ]),
      ),
      support: Schema.Literals(["documented", "unavailable"]),
      unavailableReason: Schema.optionalKey(Schema.Literal("native_protocol_unverified")),
    }),
  ),
});
export type MuseAgentFeatureInventory = typeof MuseAgentFeatureInventory.Type;

export const MuseAgentProfileDocumentKind = Schema.Literals(["identity", "soul", "memory"]);
export const MuseAgentProfileDocument = Schema.Struct({
  document: MuseAgentProfileDocumentKind,
  content: Schema.String.check(Schema.isMaxLength(1048576)),
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type MuseAgentProfileDocument = typeof MuseAgentProfileDocument.Type;

const ThemeColors = Schema.Struct({
  userText: Text,
  userBubble: Text,
  agentText: Text,
  agentBubble: Text,
  background: Text,
});
export const MuseAgentThemes = Schema.Struct({
  selectedThemeId: Schema.NullOr(Id),
  order: Schema.Array(Id),
  options: Schema.Record(Id, Schema.Struct({ light: ThemeColors, dark: ThemeColors })),
});
export type MuseAgentThemes = typeof MuseAgentThemes.Type;

export const MuseAgentMemory = Schema.Struct({
  uri: Id,
  title: Text,
  summary: Schema.optionalKey(Content),
  contentMarkdown: Schema.optionalKey(Content),
  score: Schema.optionalKey(Schema.Number),
});
export type MuseAgentMemory = typeof MuseAgentMemory.Type;

export const MuseAgentTask = Schema.Struct({
  id: Id,
  title: Schema.optionalKey(Text),
  scheduleKey: Text,
  timezone: Schema.optionalKey(Text),
  nextRunAtUtc: Schema.optionalKey(Schema.Number),
  isHeartbeat: Schema.optionalKey(Schema.Boolean),
});
export type MuseAgentTask = typeof MuseAgentTask.Type;

export const MuseAgentTaskRun = Schema.Struct({
  runId: Id,
  jobId: Id,
  status: Schema.optionalKey(Text),
});
export type MuseAgentTaskRun = typeof MuseAgentTaskRun.Type;

export const MuseAgentConnector = Schema.Struct({
  id: Id,
  name: Text,
  description: Text,
  state: Schema.Literals(["connected", "disconnected", "coming_soon", "unknown"]),
  supportsMultipleAccounts: Schema.optionalKey(Schema.Boolean),
  isCustom: Schema.optionalKey(Schema.Boolean),
});
export type MuseAgentConnector = typeof MuseAgentConnector.Type;

export const MuseAgentConnectorAuthorization = Schema.Struct({ authorizationUrl: Text });
export type MuseAgentConnectorAuthorization = typeof MuseAgentConnectorAuthorization.Type;
export const MuseAgentConnectorConnectInfo = Schema.Struct({
  connectorId: Id,
  action: Schema.Union([
    Schema.Struct({ type: Schema.Literal("oauth"), authorizationUrl: Text }),
    Schema.Struct({
      type: Schema.Literals([
        "api_key",
        "consent_only",
        "messenger",
        "whatsapp",
        "foa_auth",
        "none",
      ]),
    }),
  ]),
});
export type MuseAgentConnectorConnectInfo = typeof MuseAgentConnectorConnectInfo.Type;
export const MuseAgentConnectorAccounts = Schema.Struct({
  supported: Schema.Boolean,
  accounts: Schema.Array(
    Schema.Struct({
      accountId: Id,
      displayName: Schema.optionalKey(Text),
      isDefault: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type MuseAgentConnectorAccounts = typeof MuseAgentConnectorAccounts.Type;

export const MuseAgentSkill = Schema.Struct({
  name: Id,
  title: Schema.optionalKey(Text),
  description: Text,
  category: Text,
  source: Schema.optionalKey(Text),
  requiresAuth: Schema.optionalKey(Schema.Boolean),
  official: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  userDisabled: Schema.optionalKey(Schema.Boolean),
  eligible: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Text),
  statusReason: Schema.optionalKey(Text),
  blockedByAllowlist: Schema.optionalKey(Schema.Boolean),
  managedBy: Schema.optionalKey(Text),
  authProvider: Schema.optionalKey(Text),
  connectorSlug: Schema.optionalKey(Text),
});
export type MuseAgentSkill = typeof MuseAgentSkill.Type;

export const MuseAgentFeatureSession = Schema.Struct({
  sessionId: Id,
  status: Text,
  isPrimary: Schema.Boolean,
  isThread: Schema.Boolean,
  title: Schema.optionalKey(Text),
  snippet: Schema.optionalKey(Text),
  archived: Schema.optionalKey(Schema.Boolean),
  pinned: Schema.optionalKey(Schema.Boolean),
  canSendMessages: Schema.optionalKey(Schema.Boolean),
  canSendActions: Schema.optionalKey(Schema.Boolean),
  readOnlyReason: Schema.optionalKey(Text),
});
export type MuseAgentFeatureSession = typeof MuseAgentFeatureSession.Type;

export const MuseAgentComputerTask = Schema.Struct({
  taskId: Id,
  sessionId: Schema.optionalKey(Id),
  title: Text,
  readOnly: Schema.Boolean,
  status: Schema.optionalKey(Text),
  displayStatus: Schema.optionalKey(Text),
  previewAvailable: Schema.Boolean,
  queuePosition: Schema.optionalKey(Schema.Int),
  controlOwner: Schema.optionalKey(Schema.Literals(["agent", "user"])),
  ownerKind: Schema.optionalKey(Schema.Literals(["user", "main_agent", "cron"])),
});
export type MuseAgentComputerTask = typeof MuseAgentComputerTask.Type;

export const MuseAgentComputerStatus = Schema.Struct({
  available: Schema.Boolean,
  tasks: Schema.Array(MuseAgentComputerTask),
});
export type MuseAgentComputerStatus = typeof MuseAgentComputerStatus.Type;
