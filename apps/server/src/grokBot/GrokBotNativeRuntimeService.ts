import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as GatewaySettlement from "./GatewaySettlement.ts";
import * as Native from "./GrokBotNativeService.ts";
import { secretRequestsIn, type GrokBotSecretRequest } from "./GrokBotSecretRequest.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const SessionId = Schema.String.check(Schema.isMaxLength(1024));
const Sequence = Schema.String.check(Schema.isPattern(/^\d{1,20}$/));
const OptionalString = Schema.optionalKey(Schema.String);
const Millis = Schema.Union([Schema.String, Schema.Number]);
const McpServer = Schema.Struct({
  type: Schema.Literal("http"),
  url: Schema.String.check(Schema.isMaxLength(8192)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  placement: Schema.optionalKey(Schema.Literals(["server", "client"])),
  enabledTools: Schema.optionalKey(Schema.Array(Schema.String)),
});
export const McpConfig = Schema.Struct({ mcpServers: Schema.Record(Schema.String, McpServer) });
const encodeMcpConfig = Schema.encodeEffect(Schema.fromJsonString(McpConfig));
const encodeYamlScalar = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const TurnInput = Schema.Struct({
  binding: Id,
  botId: Id,
  sessionId: SessionId,
  messageId: Id,
  sentAtMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000000)),
  mcpConfig: Schema.optionalKey(McpConfig),
  taskId: Schema.optionalKey(Id),
  attachmentPaths: Schema.optionalKey(Schema.Array(Id)),
  attachmentNames: Schema.optionalKey(Schema.Array(Id)),
});
const SendResult = Schema.Struct({
  delivery: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  workflowId: OptionalString,
});
const StatusResult = Schema.Struct({
  status: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  echoEntryId: OptionalString,
  rejectionCode: OptionalString,
  acceptedAtMs: Schema.optionalKey(Millis),
});
const SessionContext = Schema.Struct({
  agentId: Id,
  name: OptionalString,
  harness: OptionalString,
  viewerSessionId: OptionalString,
  viewerIsOwner: Schema.optionalKey(Schema.Boolean),
  viewerCanManage: Schema.optionalKey(Schema.Boolean),
});
const Session = Schema.Struct({
  agentId: Id,
  sessionId: SessionId,
  kind: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
});
const Task = Schema.Struct({
  id: Id,
  state: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  doneAtMs: Schema.optionalKey(Millis),
});
const Plugin = Schema.Struct({
  pluginId: Sequence,
  name: Schema.String,
  mcpConfigJson: OptionalString,
});
const PluginList = Schema.Struct({ plugins: Schema.optionalKey(Schema.Array(Plugin)) });
const Skill = Schema.Struct({
  id: Id,
  name: Id,
  description: OptionalString,
  body: Schema.String,
  source: OptionalString,
});
const SkillList = Schema.Struct({ skills: Schema.optionalKey(Schema.Array(Skill)) });
const SkillInput = Schema.Struct({
  binding: Id,
  botId: Id,
  name: Id,
  description: Schema.String.check(Schema.isMaxLength(8192)),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000000)),
});
const ApprovalOwner = Schema.Struct({
  binding: Id,
  botId: Id,
  sessionId: SessionId,
  requestId: Id,
});
const AutoReviewApprovalInput = Schema.Struct({
  ...ApprovalOwner.fields,
  resolution: Schema.Literals(["APPROVED", "DENIED", "ALWAYS"]),
  approvalPlatform: Id,
  approvedCommand: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65536))),
});
const LocalToolPermissionInput = Schema.Struct({
  ...ApprovalOwner.fields,
  entryId: Id,
  resolution: Schema.Literals(["ALLOW_ONCE", "DENY", "ALWAYS", "NEVER"]),
});
const ConnectorGrantInput = Schema.Struct({
  ...ApprovalOwner.fields,
  entryId: Schema.optionalKey(Id),
  resolution: Schema.Literals(["ALLOWED", "SKIPPED", "ALWAYS_THIS_BOT", "ALWAYS_ALL_TEAM_BOTS"]),
});
// Shipped RespondGrokBotWidget takes one string; the projection serializes selected values.
const WidgetOwner = Schema.Struct({
  binding: Id,
  botId: Id,
  sessionId: SessionId,
});
const WidgetResponseInput = Schema.Struct({
  ...WidgetOwner.fields,
  entryId: Id,
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536)),
});
const WidgetDismissInput = Schema.Struct({
  ...WidgetOwner.fields,
  entryId: Id,
});
const ApprovalResult = Schema.Struct({
  dispatched: Schema.optionalKey(Schema.Boolean),
  workflowId: OptionalString,
  refusal: Schema.optionalKey(
    Schema.Struct({ failureCode: OptionalString, message: OptionalString }),
  ),
});
// Widget mutations answer with `accepted` (protobuf RespondGrokBotWidgetResponse), not `dispatched`.
const WidgetResult = Schema.Struct({
  accepted: Schema.optionalKey(Schema.Boolean),
  refusal: Schema.optionalKey(
    Schema.Struct({ failureCode: OptionalString, message: OptionalString }),
  ),
});
const TranscriptTail = Schema.Struct({
  entries: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ body: OptionalString, bodyOmitted: Schema.optionalKey(Schema.Boolean) }),
    ),
  ),
});
const SecretSubmitMeta = Schema.Struct({ ...WidgetOwner.fields, entryId: Id });
const SECRET_MAX_LENGTH = 65536;
// SubmitGrokBotSecretResponse has the same accepted/refusal shape as widget mutations.
const RecreateResult = Schema.Struct({
  started: Schema.optionalKey(Schema.Boolean),
  reason: OptionalString,
  operationId: OptionalString,
});
const UpgradeSchedule = Schema.Struct({
  timezone: OptionalString,
  localTime: OptionalString,
  recurring: Schema.optionalKey(Schema.Boolean),
  targetImageTag: OptionalString,
  // int64 travels as a string in Connect JSON.
  nextFireAtMs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  state: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  lastCompletedImageTag: OptionalString,
  failureReason: OptionalString,
});
const Cursor = Schema.Struct({
  binding: Id,
  botId: Id,
  sessionId: SessionId,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  afterUpdatedSeq: Sequence,
});
const Row = Schema.Struct({
  seq: Sequence,
  updatedSeq: Sequence,
  entryId: OptionalString,
  entryKind: OptionalString,
  body: OptionalString,
  blobHash: OptionalString,
  bodyOmitted: Schema.optionalKey(Schema.Boolean),
});
const Rows = Schema.Struct({
  agentId: Id,
  sessionId: OptionalString,
  // Protobuf JSON omits numeric zero, including a main transcript's first generation.
  generation: Schema.optionalKey(Schema.Number),
  entries: Schema.optionalKey(Schema.Array(Row)),
  deletes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        seq: Sequence,
        updatedSeq: Sequence,
        entryId: OptionalString,
      }),
    ),
  ),
  replay: Schema.optionalKey(Schema.Boolean),
});
const Live = Schema.Struct({
  agentId: Id,
  sessionId: OptionalString,
  surfaceTaskId: OptionalString,
  isRunning: Schema.optionalKey(Schema.Boolean),
  isComposingMessage: Schema.optionalKey(Schema.Boolean),
  hasRunningSubagents: Schema.optionalKey(Schema.Boolean),
  isRetrying: Schema.optionalKey(Schema.Boolean),
  updatedAtMs: Schema.optionalKey(Millis),
  staleAfterMs: Schema.optionalKey(Millis),
  activity: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.String,
      tool: OptionalString,
      target: OptionalString,
      callId: OptionalString,
    }),
  ),
  awaiting: Schema.optionalKey(
    Schema.Struct({ reason: OptionalString, sinceMs: Schema.optionalKey(Millis) }),
  ),
});
const Frame = Schema.Struct({
  connected: Schema.optionalKey(
    Schema.Struct({ streamId: OptionalString, absoluteLifetimeMs: Schema.optionalKey(Millis) }),
  ),
  heartbeat: Schema.optionalKey(Schema.Struct({ serverTimeMs: Schema.optionalKey(Millis) })),
  rows: Schema.optionalKey(Rows),
  cleared: Schema.optionalKey(
    Schema.Struct({
      agentId: Id,
      sessionId: OptionalString,
      newGeneration: Schema.optionalKey(Schema.Number),
    }),
  ),
  cursorTooOld: Schema.optionalKey(
    Schema.Struct({
      agentId: Id,
      sessionId: OptionalString,
      generation: Schema.optionalKey(Schema.Number),
    }),
  ),
  agentState: Schema.optionalKey(
    Schema.Struct({
      live: Schema.optionalKey(Schema.Array(Live)),
      snapshot: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  turnFailed: Schema.optionalKey(
    Schema.Struct({
      agentId: Id,
      sessionId: OptionalString,
      turnId: OptionalString,
      code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    }),
  ),
  agentStateChanged: Schema.optionalKey(
    Schema.Struct({ agentId: Id, families: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
});

export class NativeRuntimeError extends Schema.TaggedError<NativeRuntimeError>()(
  "GrokBotNativeRuntimeError",
  {
    kind: Schema.Literals([
      "invalid_input",
      "response",
      "refused",
      "uncertain",
      "plugin_conflict",
      "skill_conflict",
    ]),
  },
) {
  override get message() {
    return "The Grok Bot runtime operation could not be confirmed.";
  }
}
export type RuntimeError =
  | NativeRuntimeError
  | Native.NativeReadError
  | Native.NativeSignedOutError;
export type Turn = typeof TurnInput.Type;
export type AutoReviewApprovalInput = typeof AutoReviewApprovalInput.Type;
export type LocalToolPermissionInput = typeof LocalToolPermissionInput.Type;
export type ConnectorGrantInput = typeof ConnectorGrantInput.Type;
/** The value stays Redacted so it cannot reach a log, span, or error; only the native request body unwraps it. */
export type SecretSubmitInput = typeof WidgetOwner.Type & {
  readonly entryId: string;
  readonly value: Redacted.Redacted<string>;
};
export type ComputerRecreateInput = {
  readonly binding: string;
  readonly preserveData: boolean;
};
export type ComputerResetInput = { readonly binding: string };
export type ComputerRecreateResult = {
  readonly started: boolean;
  readonly reason?: string;
  readonly operationId?: string;
};
export type ComputerUpgradeSchedule = typeof UpgradeSchedule.Type;
export type WidgetResponseInput = typeof WidgetResponseInput.Type;
export type WidgetDismissInput = typeof WidgetDismissInput.Type;
export type TranscriptCursor = typeof Cursor.Type;
export type PluginLease = {
  readonly binding: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly appliedConfig: Redacted.Redacted<string>;
  readonly originalConfig?: Redacted.Redacted<string>;
  readonly created: boolean;
};
export type SettlementFrame = typeof GatewaySettlement.Settlement.Type & {
  readonly _tag: "Settlement";
};
export type RuntimeFrame =
  | SettlementFrame
  | {
      readonly _tag: "Connected";
      readonly streamId: string;
      readonly absoluteLifetimeMs?: string | number;
    }
  | { readonly _tag: "Heartbeat" }
  | {
      readonly _tag: "Rows";
      readonly generation: number;
      readonly entries: readonly (typeof Row.Type & { readonly value?: unknown })[];
      readonly deletes: readonly {
        readonly seq: string;
        readonly updatedSeq: string;
        readonly entryId?: string;
      }[];
      readonly replay: boolean;
    }
  | { readonly _tag: "Cleared"; readonly generation: number }
  | { readonly _tag: "CursorTooOld"; readonly generation: number }
  | {
      readonly _tag: "Live";
      readonly state: typeof Live.Type;
      readonly observedAtMs: number;
      readonly snapshot: boolean;
    }
  | { readonly _tag: "TurnFailed"; readonly turnId?: string; readonly code?: string | number }
  | { readonly _tag: "StateChanged"; readonly families: readonly string[] }
  | { readonly _tag: "Other" };

export class GrokBotNativeRuntimeService extends Context.Service<
  GrokBotNativeRuntimeService,
  {
    readonly receiveAttachments: Native.GrokBotNativeService["Service"]["receiveAttachments"];
    readonly uploadAttachments: Native.GrokBotNativeService["Service"]["uploadAttachments"];
    readonly accountBinding: Native.GrokBotNativeService["Service"]["accountBinding"];
    readonly usageLimits: Native.GrokBotNativeService["Service"]["usageLimits"];
    readonly accountInfo: Native.GrokBotNativeService["Service"]["accountInfo"];
    readonly roster: (
      binding: string,
    ) => Effect.Effect<readonly (typeof SessionContext.Type)[], RuntimeError>;
    readonly sessionContext: (input: Pick<Turn, "binding" | "botId">) => Effect.Effect<
      {
        readonly bot: typeof SessionContext.Type;
        readonly sessions: readonly (typeof Session.Type)[];
      },
      RuntimeError
    >;
    readonly tasks: (
      input: Pick<Turn, "binding" | "botId" | "sessionId">,
    ) => Effect.Effect<readonly (typeof Task.Type)[], RuntimeError>;
    readonly startTurn: (
      input: Turn,
    ) => Effect.Effect<
      { readonly delivery: "accepted" | "duplicate"; readonly workflowId?: string },
      RuntimeError
    >;
    readonly sendStatus: (
      input: Pick<Turn, "binding" | "botId" | "sessionId" | "messageId">,
    ) => Effect.Effect<
      {
        readonly status: "not_found" | "accepted" | "rejected" | "pending" | "unknown_durability";
        readonly echoEntryId?: string;
        readonly rejectionCode?: string;
        readonly acceptedAtMs?: string | number;
      },
      RuntimeError
    >;
    readonly interrupt: (
      input: Pick<Turn, "binding" | "botId" | "sessionId">,
    ) => Effect.Effect<{ readonly hadActiveRun: boolean }, RuntimeError>;
    /** Each approval method resolves only after native reports dispatched without refusal. */
    readonly resolveAutoReviewApproval: (
      input: AutoReviewApprovalInput,
    ) => Effect.Effect<{ readonly workflowId?: string }, RuntimeError>;
    readonly resolveLocalToolPermission: (
      input: LocalToolPermissionInput,
    ) => Effect.Effect<{ readonly workflowId?: string }, RuntimeError>;
    readonly resolveConnectorGrant: (
      input: ConnectorGrantInput,
    ) => Effect.Effect<{ readonly workflowId?: string }, RuntimeError>;
    readonly respondToWidget: (
      input: WidgetResponseInput,
    ) => Effect.Effect<{ readonly workflowId?: string }, RuntimeError>;
    readonly dismissWidget: (
      input: WidgetDismissInput,
    ) => Effect.Effect<{ readonly workflowId?: string }, RuntimeError>;
    /** Answers a transcript `secret-request` entry. Resolves only on native `accepted`, never echoes the value. */
    readonly submitSecret: (input: SecretSubmitInput) => Effect.Effect<void, RuntimeError>;
    /**
     * Secret requests in the newest transcript rows of one account/bot/session, with no value.
     * Native scopes the read to the bound account, so a bot or session the account does not own
     * yields nothing.
     */
    readonly secretRequests: (
      input: typeof WidgetOwner.Type,
    ) => Effect.Effect<readonly GrokBotSecretRequest[], RuntimeError>;
    /** Destructive: native recreates the account's computer. Callers must hold explicit confirmation. */
    /** Destructive: restores the account's computer from its last saved snapshot (ForceRecreateSandBox, no arguments). */
    readonly resetComputer: (
      input: ComputerResetInput,
    ) => Effect.Effect<ComputerRecreateResult, RuntimeError>;
    readonly recreateComputer: (
      input: ComputerRecreateInput,
    ) => Effect.Effect<ComputerRecreateResult, RuntimeError>;
    readonly computerUpgradeSchedule: (
      binding: string,
    ) => Effect.Effect<ComputerUpgradeSchedule | undefined, RuntimeError>;
    readonly openSettlementWatch: (
      input: Pick<Turn, "binding" | "botId" | "sessionId">,
    ) => Effect.Effect<
      { readonly events: Stream.Stream<SettlementFrame, RuntimeError> },
      RuntimeError,
      Scope.Scope
    >;
    readonly settlementSnapshot: (
      input: Pick<Turn, "binding" | "botId" | "sessionId">,
    ) => Effect.Effect<readonly SettlementFrame[], RuntimeError>;
    readonly watchSettlements: (
      input: Pick<Turn, "binding" | "botId" | "sessionId">,
    ) => Stream.Stream<SettlementFrame, RuntimeError>;
    readonly watch: (cursor: TranscriptCursor) => Stream.Stream<RuntimeFrame, RuntimeError>;
    readonly plugins: (
      input: Pick<Turn, "binding" | "botId">,
    ) => Effect.Effect<readonly (typeof Plugin.Type)[], RuntimeError>;
    readonly upsertPlugin: (
      input: Pick<Turn, "binding" | "botId"> & {
        readonly name: string;
        readonly config: typeof McpConfig.Type;
      },
    ) => Effect.Effect<PluginLease, RuntimeError>;
    readonly restorePlugin: (lease: PluginLease) => Effect.Effect<void, RuntimeError>;
    /** Read native state on every call; never trust an in-process installation cache. */
    readonly ensureSkill: (
      input: typeof SkillInput.Type,
    ) => Effect.Effect<{ readonly skillId: string; readonly changed: boolean }, RuntimeError>;
  }
>()("t3/grokBot/GrokBotNativeRuntimeService") {}

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  kind: "invalid_input" | "response",
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => new NativeRuntimeError({ kind })),
  );
const enumValue = (value: string | number | undefined, prefix: string) =>
  typeof value === "string" ? value.replace(prefix, "") : value;

const make = Effect.gen(function* () {
  const native = yield* Native.GrokBotNativeService;
  const roster = Effect.fnUntraced(function* (binding: string) {
    yield* decode(Id, binding, "invalid_input");
    const result = yield* native
      .runtimeRequest(binding, "ListGrokBotAgents", {})
      .pipe(
        Effect.flatMap((value) =>
          decode(
            Schema.Struct({ agents: Schema.optionalKey(Schema.Array(SessionContext)) }),
            value,
            "response",
          ),
        ),
      );
    return result.agents ?? [];
  });
  const sessionContext = Effect.fnUntraced(function* (input: Pick<Turn, "binding" | "botId">) {
    yield* decode(Schema.Struct({ binding: Id, botId: Id }), input, "invalid_input");
    const agents = yield* roster(input.binding);
    const bot = agents.find((agent) => agent.agentId === input.botId);
    if (bot === undefined) return yield* new NativeRuntimeError({ kind: "refused" });
    const result = yield* native
      .runtimeRequest(input.binding, "ListGrokBotAgentSessions", { agentId: input.botId })
      .pipe(
        Effect.flatMap((value) =>
          decode(
            Schema.Struct({ sessions: Schema.optionalKey(Schema.Array(Session)) }),
            value,
            "response",
          ),
        ),
      );
    return {
      bot,
      sessions: (result.sessions ?? []).filter((session) => session.agentId === input.botId),
    };
  });
  // Task-list states are exposed as facts; they do not prove this provider turn settled.
  const tasks = Effect.fnUntraced(function* (input: Pick<Turn, "binding" | "botId" | "sessionId">) {
    yield* decode(
      Schema.Struct({ binding: Id, botId: Id, sessionId: SessionId }),
      input,
      "invalid_input",
    );
    const result = yield* native
      .runtimeRequest(input.binding, "ListGrokBotTasks", {
        agentId: input.botId,
        sessionId: input.sessionId,
      })
      .pipe(
        Effect.flatMap((value) =>
          decode(
            Schema.Struct({ tasks: Schema.optionalKey(Schema.Array(Task)) }),
            value,
            "response",
          ),
        ),
      );
    return result.tasks ?? [];
  });
  const startTurn = Effect.fnUntraced(function* (input: Turn) {
    const turn = yield* decode(TurnInput, input, "invalid_input");
    const mcpConfigJson =
      turn.mcpConfig === undefined
        ? undefined
        : yield* encodeMcpConfig(turn.mcpConfig).pipe(
            Effect.mapError(() => new NativeRuntimeError({ kind: "invalid_input" })),
          );
    const result = yield* native
      .runtimeRequest(turn.binding, "SendGrokBotUserMessage", {
        agentId: turn.botId,
        sessionId: turn.sessionId,
        messageId: turn.messageId,
        text: turn.text,
        sentAtMs: String(turn.sentAtMs),
        ...(mcpConfigJson === undefined ? {} : { mcpConfigJson }),
        ...(turn.taskId === undefined ? {} : { taskId: turn.taskId }),
        ...(turn.attachmentPaths === undefined ? {} : { attachmentPaths: turn.attachmentPaths }),
        ...(turn.attachmentNames === undefined ? {} : { attachmentNames: turn.attachmentNames }),
      })
      .pipe(Effect.flatMap((value) => decode(SendResult, value, "response")));
    const delivery = enumValue(result.delivery, "GROK_BOT_USER_MESSAGE_DELIVERY_");
    if (delivery === 4 || delivery === "REFUSED")
      return yield* new NativeRuntimeError({ kind: "refused" });
    if (
      delivery !== 1 &&
      delivery !== 2 &&
      delivery !== 3 &&
      delivery !== "ACCEPTED_BOX" &&
      delivery !== "ACCEPTED_TEMPORAL" &&
      delivery !== "DUPLICATE"
    )
      return yield* new NativeRuntimeError({ kind: "uncertain" });
    return {
      delivery:
        delivery === 3 || delivery === "DUPLICATE" ? ("duplicate" as const) : ("accepted" as const),
      ...(result.workflowId ? { workflowId: result.workflowId } : {}),
    };
  });
  const identity = Schema.Struct({ binding: Id, botId: Id, sessionId: SessionId });
  const sendStatus = Effect.fnUntraced(function* (
    input: Pick<Turn, "binding" | "botId" | "sessionId" | "messageId">,
  ) {
    const value = yield* decode(
      Schema.Struct({ ...identity.fields, messageId: Id }),
      input,
      "invalid_input",
    );
    const result = yield* native
      .runtimeRequest(value.binding, "GetGrokBotSendStatus", {
        agentId: value.botId,
        sessionId: value.sessionId,
        messageId: value.messageId,
      })
      .pipe(Effect.flatMap((value) => decode(StatusResult, value, "response")));
    const statuses = {
      NOT_FOUND: "not_found",
      ACCEPTED: "accepted",
      REJECTED: "rejected",
      PENDING: "pending",
      UNKNOWN_DURABILITY: "unknown_durability",
    } as const;
    const code = enumValue(result.status, "GROK_BOT_SEND_STATUS_");
    const key =
      typeof code === "number"
        ? ["UNSPECIFIED", "NOT_FOUND", "ACCEPTED", "REJECTED", "PENDING", "UNKNOWN_DURABILITY"][
            code
          ]
        : code;
    if (key === undefined || !(key in statuses))
      return yield* new NativeRuntimeError({ kind: "uncertain" });
    return {
      status: statuses[key as keyof typeof statuses],
      ...(result.echoEntryId ? { echoEntryId: result.echoEntryId } : {}),
      ...(result.rejectionCode ? { rejectionCode: result.rejectionCode.slice(0, 128) } : {}),
      ...(result.acceptedAtMs === undefined ? {} : { acceptedAtMs: result.acceptedAtMs }),
    };
  });
  const interrupt = Effect.fnUntraced(function* (
    input: Pick<Turn, "binding" | "botId" | "sessionId">,
  ) {
    const value = yield* decode(identity, input, "invalid_input");
    const result = yield* native
      .runtimeRequest(value.binding, "InterruptGrokBotAgentRun", {
        agentId: value.botId,
        sessionId: value.sessionId,
        reason: "user_interrupt",
      })
      .pipe(
        Effect.flatMap((value) =>
          decode(
            Schema.Struct({ hadActiveRun: Schema.optionalKey(Schema.Boolean) }),
            value,
            "response",
          ),
        ),
      );
    return { hadActiveRun: result.hadActiveRun ?? false };
  });
  // Native acknowledges with dispatched=true; a refusal or a false/missing flag is never success.
  const resolveApproval = Effect.fnUntraced(function* (
    binding: string,
    method: Native.NativeRuntimeMethod,
    body: object,
  ) {
    const result = yield* native
      .runtimeRequest(binding, method, body)
      .pipe(Effect.flatMap((value) => decode(ApprovalResult, value, "response")));
    if (result.refusal !== undefined) return yield* new NativeRuntimeError({ kind: "refused" });
    if (result.dispatched !== true) return yield* new NativeRuntimeError({ kind: "uncertain" });
    return result.workflowId ? { workflowId: result.workflowId } : {};
  });
  const resolveAutoReviewApproval = Effect.fnUntraced(function* (input: AutoReviewApprovalInput) {
    const v = yield* decode(AutoReviewApprovalInput, input, "invalid_input");
    return yield* resolveApproval(v.binding, "ResolveGrokBotAutoReviewApproval", {
      agentId: v.botId,
      requestId: v.requestId,
      resolution: v.resolution,
      approvalPlatform: v.approvalPlatform,
      ...(v.approvedCommand === undefined ? {} : { approvedCommand: v.approvedCommand }),
      sessionId: v.sessionId,
    });
  });
  const resolveLocalToolPermission = Effect.fnUntraced(function* (input: LocalToolPermissionInput) {
    const v = yield* decode(LocalToolPermissionInput, input, "invalid_input");
    return yield* resolveApproval(v.binding, "ResolveGrokBotLocalToolPermission", {
      agentId: v.botId,
      entryId: v.entryId,
      requestId: v.requestId,
      resolution: v.resolution,
      sessionId: v.sessionId,
    });
  });
  const resolveConnectorGrant = Effect.fnUntraced(function* (input: ConnectorGrantInput) {
    const v = yield* decode(ConnectorGrantInput, input, "invalid_input");
    return yield* resolveApproval(v.binding, "ResolveGrokBotConnectorGrant", {
      agentId: v.botId,
      requestId: v.requestId,
      resolution: v.resolution,
      sessionId: v.sessionId,
      ...(v.entryId === undefined ? {} : { entryId: v.entryId }),
    });
  });
  const resolveWidget = Effect.fnUntraced(function* (
    binding: string,
    method: Native.NativeRuntimeMethod,
    body: object,
  ) {
    const result = yield* native
      .runtimeRequest(binding, method, body)
      .pipe(Effect.flatMap((value) => decode(WidgetResult, value, "response")));
    if (result.refusal !== undefined) return yield* new NativeRuntimeError({ kind: "refused" });
    if (result.accepted !== true) return yield* new NativeRuntimeError({ kind: "uncertain" });
    return {};
  });
  const respondToWidget = Effect.fnUntraced(function* (input: WidgetResponseInput) {
    const v = yield* decode(WidgetResponseInput, input, "invalid_input");
    return yield* resolveWidget(v.binding, "RespondGrokBotWidget", {
      agentId: v.botId,
      sessionId: v.sessionId,
      entryId: v.entryId,
      value: v.value,
    });
  });
  const dismissWidget = Effect.fnUntraced(function* (input: WidgetDismissInput) {
    const v = yield* decode(WidgetDismissInput, input, "invalid_input");
    return yield* resolveWidget(v.binding, "DismissGrokBotWidget", {
      agentId: v.botId,
      sessionId: v.sessionId,
      entryId: v.entryId,
    });
  });
  const submitSecret = Effect.fnUntraced(function* (input: SecretSubmitInput) {
    const v = yield* decode(SecretSubmitMeta, input, "invalid_input");
    const value = Redacted.value(input.value);
    if (value.length < 1 || value.length > SECRET_MAX_LENGTH)
      return yield* new NativeRuntimeError({ kind: "invalid_input" });
    yield* resolveWidget(v.binding, "SubmitGrokBotSecret", {
      agentId: v.botId,
      sessionId: v.sessionId,
      entryId: v.entryId,
      value,
    });
  });
  const secretRequests = Effect.fnUntraced(function* (input: typeof WidgetOwner.Type) {
    const v = yield* decode(WidgetOwner, input, "invalid_input");
    const tail = yield* native
      .runtimeRequest(v.binding, "ListGrokBotTranscriptEntries", {
        agentId: v.botId,
        sessionId: v.sessionId,
        limit: 200,
      })
      .pipe(Effect.flatMap((value) => decode(TranscriptTail, value, "response")));
    // A secret card is small and always inline; a blob-only row cannot be one.
    const entries = yield* Effect.forEach(
      (tail.entries ?? []).filter((entry) => entry.body && !entry.bodyOmitted).toReversed(),
      (entry) =>
        Effect.try({
          try: () =>
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.from(entry.body ?? "", "base64"),
            ),
          catch: () => new NativeRuntimeError({ kind: "response" }),
        }).pipe(
          Effect.flatMap((body) => decode(Schema.fromJsonString(Schema.Unknown), body, "response")),
        ),
    );
    return secretRequestsIn(entries);
  });
  const recreateComputer = Effect.fnUntraced(function* (input: ComputerRecreateInput) {
    yield* decode(Id, input.binding, "invalid_input");
    // `force` skips native safety checks and `acknowledgeTerminalUpgradeSchedule` overrides a
    // pending upgrade, so T3 never sets either.
    const result = yield* native
      .runtimeRequest(input.binding, "RecreateSandBox", {
        preserveData: input.preserveData,
        force: false,
        acknowledgeTerminalUpgradeSchedule: false,
      })
      .pipe(Effect.flatMap((value) => decode(RecreateResult, value, "response")));
    return {
      started: result.started === true,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.operationId ? { operationId: result.operationId } : {}),
    };
  });
  const resetComputer = Effect.fnUntraced(function* (input: ComputerResetInput) {
    yield* decode(Id, input.binding, "invalid_input");
    const result = yield* native
      .runtimeRequest(input.binding, "ForceRecreateSandBox", {})
      .pipe(Effect.flatMap((value) => decode(RecreateResult, value, "response")));
    return {
      started: result.started === true,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.operationId ? { operationId: result.operationId } : {}),
    };
  });
  const computerUpgradeSchedule = Effect.fnUntraced(function* (binding: string) {
    yield* decode(Id, binding, "invalid_input");
    const result = yield* native
      .runtimeRequest(binding, "GetSandBoxUpgradeSchedule", {})
      .pipe(
        Effect.flatMap((value) =>
          decode(
            Schema.Struct({ schedule: Schema.optionalKey(UpgradeSchedule) }),
            value,
            "response",
          ),
        ),
      );
    return result.schedule;
  });
  const settlementSnapshot = Effect.fnUntraced(function* (
    input: Pick<Turn, "binding" | "botId" | "sessionId">,
  ) {
    yield* decode(identity, input, "invalid_input");
    const roster = yield* native.gatewayRoster(input.binding);
    const settlements = yield* GatewaySettlement.fromRoster(input.botId, roster).pipe(
      Effect.mapError(() => new NativeRuntimeError({ kind: "response" })),
    );
    return settlements.map((settlement) => ({ ...settlement, _tag: "Settlement" as const }));
  });
  const openSettlementWatch = Effect.fnUntraced(function* (
    input: Pick<Turn, "binding" | "botId" | "sessionId">,
  ) {
    const value = yield* decode(identity, input, "invalid_input");
    const agents = yield* roster(value.binding);
    const bot = agents.find((agent) => agent.agentId === value.botId);
    if (bot === undefined) return yield* new NativeRuntimeError({ kind: "refused" });
    // Temporal turns do not publish legacy gateway settlements or require a running computer.
    // Their completion declarations arrive through the managed binding's durable completion watch.
    if (bot.harness === "temporal") return { events: Stream.never };
    const ready = yield* Deferred.make<void, RuntimeError>();
    const queue = yield* Effect.acquireRelease(
      Queue.make<SettlementFrame, RuntimeError | Cause.Done>({ capacity: 64 }),
      Queue.shutdown,
    );
    const pump = native
      .gatewayEvents(value.binding, Deferred.succeed(ready, undefined).pipe(Effect.asVoid))
      .pipe(
        Stream.mapEffect((event) =>
          GatewaySettlement.fromEvent(value.botId, event).pipe(
            Effect.mapError(() => new NativeRuntimeError({ kind: "response" })),
          ),
        ),
        Stream.flatMap(Stream.fromIterable),
        Stream.runForEach((settlement) =>
          Queue.offer(queue, { ...settlement, _tag: "Settlement" }),
        ),
        Effect.flatMap(() => Queue.end(queue)),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Deferred.failCause(ready, cause);
            yield* Queue.failCause(queue, cause);
          }),
        ),
      );
    yield* pump.pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    const snapshot = yield* settlementSnapshot(value);
    // Subscribe before taking the snapshot. The provider de-duplicates by its durable nonce.
    return { events: Stream.fromIterable(snapshot).pipe(Stream.concat(Stream.fromQueue(queue))) };
  });
  const watchSettlements = (input: Pick<Turn, "binding" | "botId" | "sessionId">) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const value = yield* decode(identity, input, "invalid_input");
        return native.gatewayEvents(value.binding).pipe(
          Stream.mapEffect((event) =>
            GatewaySettlement.fromEvent(value.botId, event).pipe(
              Effect.mapError(() => new NativeRuntimeError({ kind: "response" })),
            ),
          ),
          Stream.flatMap(Stream.fromIterable),
          Stream.map((settlement) => ({ ...settlement, _tag: "Settlement" as const })),
        );
      }),
    );
  const watch = (input: TranscriptCursor) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cursor = yield* decode(Cursor, input, "invalid_input");
        const belongs = (value: { readonly agentId: string; readonly sessionId?: string }) =>
          value.agentId === cursor.botId && (value.sessionId ?? "") === cursor.sessionId;
        return native
          .watchTranscripts(cursor.binding, {
            cursors: [
              {
                agentId: cursor.botId,
                sessionId: cursor.sessionId,
                generation: cursor.generation,
                afterUpdatedSeq: cursor.afterUpdatedSeq,
              },
            ],
            includeUnlistedAgents: false,
            inlineBodyMaxBytes: 1048576,
          })
          .pipe(
            Stream.mapEffect((raw) =>
              Effect.gen(function* () {
                const frame = yield* decode(Frame, raw, "response");
                const result: RuntimeFrame[] = [];
                if (frame.connected)
                  result.push({
                    _tag: "Connected",
                    streamId: frame.connected.streamId ?? "",
                    ...(frame.connected.absoluteLifetimeMs === undefined
                      ? {}
                      : { absoluteLifetimeMs: frame.connected.absoluteLifetimeMs }),
                  });
                if (frame.heartbeat) result.push({ _tag: "Heartbeat" });
                if (frame.rows && belongs(frame.rows)) {
                  const entries = yield* Effect.forEach(frame.rows.entries ?? [], (entry) =>
                    entry.body && !entry.bodyOmitted
                      ? Effect.try({
                          try: () =>
                            new TextDecoder("utf-8", { fatal: true }).decode(
                              Buffer.from(entry.body ?? "", "base64"),
                            ),
                          catch: () => new NativeRuntimeError({ kind: "response" }),
                        }).pipe(
                          Effect.flatMap((body) =>
                            decode(Schema.fromJsonString(Schema.Unknown), body, "response"),
                          ),
                          Effect.map((value) => ({ ...entry, value })),
                        )
                      : Effect.succeed(entry),
                  );
                  result.push({
                    _tag: "Rows",
                    generation: frame.rows.generation ?? 0,
                    entries,
                    deletes: frame.rows.deletes ?? [],
                    replay: frame.rows.replay ?? false,
                  });
                }
                if (frame.cleared && belongs(frame.cleared))
                  result.push({ _tag: "Cleared", generation: frame.cleared.newGeneration ?? 0 });
                if (frame.cursorTooOld && belongs(frame.cursorTooOld))
                  result.push({
                    _tag: "CursorTooOld",
                    generation: frame.cursorTooOld.generation ?? 0,
                  });
                if (frame.agentState) {
                  const now = DateTime.toEpochMillis(yield* DateTime.now);
                  for (const live of frame.agentState.live ?? [])
                    if (belongs(live))
                      result.push({
                        _tag: "Live",
                        state: live,
                        observedAtMs: now,
                        snapshot: frame.agentState.snapshot ?? false,
                      });
                }
                if (frame.turnFailed && belongs(frame.turnFailed))
                  result.push({
                    _tag: "TurnFailed",
                    ...(frame.turnFailed.turnId ? { turnId: frame.turnFailed.turnId } : {}),
                    ...(frame.turnFailed.code === undefined ? {} : { code: frame.turnFailed.code }),
                  });
                if (frame.agentStateChanged?.agentId === cursor.botId)
                  result.push({
                    _tag: "StateChanged",
                    families: frame.agentStateChanged.families ?? [],
                  });
                return result.length === 0 ? [{ _tag: "Other" } as const] : result;
              }),
            ),
            Stream.flatMap(Stream.fromIterable),
          );
      }),
    );
  const plugins = Effect.fnUntraced(function* (input: Pick<Turn, "binding" | "botId">) {
    const value = yield* decode(Schema.Struct({ binding: Id, botId: Id }), input, "invalid_input");
    const result = yield* native
      .runtimeRequest(value.binding, "GetGrokBotAgentPlugins", {
        agentId: value.botId,
        includeMcpConfig: true,
      })
      .pipe(Effect.flatMap((value) => decode(PluginList, value, "response")));
    return result.plugins ?? [];
  });
  const setPlugins = (binding: string, botId: string, entries: readonly object[]) =>
    native
      .runtimeRequest(binding, "SetGrokBotAgentPlugins", { agentId: botId, plugins: entries })
      .pipe(Effect.flatMap((value) => decode(PluginList, value, "response")));
  const upsertPlugin = Effect.fnUntraced(function* (
    input: Pick<Turn, "binding" | "botId"> & {
      readonly name: string;
      readonly config: typeof McpConfig.Type;
    },
  ) {
    const config = yield* decode(McpConfig, input.config, "invalid_input");
    yield* decode(Id, input.name, "invalid_input");
    const before = yield* plugins(input);
    const matches = before.filter((plugin) => plugin.name === input.name);
    if (matches.length > 1 || (matches[0] && matches[0].mcpConfigJson === undefined))
      return yield* new NativeRuntimeError({ kind: "plugin_conflict" });
    const original = matches[0];
    const appliedConfig = yield* encodeMcpConfig(config).pipe(
      Effect.mapError(() => new NativeRuntimeError({ kind: "invalid_input" })),
    );
    const entries = before
      .filter((plugin) => plugin.pluginId !== original?.pluginId)
      .map((plugin) => ({ pluginId: plugin.pluginId }));
    const changed = original
      ? { configUpdate: { pluginId: original.pluginId, mcpConfigJson: appliedConfig } }
      : {
          inline: {
            name: input.name,
            displayName: input.name,
            description: "T3 managed bot session",
            mcpConfigJson: appliedConfig,
          },
        };
    const after = yield* setPlugins(input.binding, input.botId, [...entries, changed]);
    const owned = (after.plugins ?? []).filter((plugin) =>
      original ? plugin.pluginId === original.pluginId : plugin.name === input.name,
    );
    if (owned.length !== 1 || owned[0]?.mcpConfigJson !== appliedConfig)
      return yield* new NativeRuntimeError({ kind: "uncertain" });
    return {
      binding: input.binding,
      botId: input.botId,
      pluginId: owned[0].pluginId,
      appliedConfig: Redacted.make(appliedConfig),
      created: original === undefined,
      ...(original?.mcpConfigJson === undefined
        ? {}
        : { originalConfig: Redacted.make(original.mcpConfigJson) }),
    };
  });
  const restorePlugin = Effect.fnUntraced(function* (lease: PluginLease) {
    const current = yield* plugins(lease);
    const owned = current.find((plugin) => plugin.pluginId === lease.pluginId);
    if (!owned) {
      if (lease.created) return;
      return yield* new NativeRuntimeError({ kind: "plugin_conflict" });
    }
    if (
      owned.mcpConfigJson !== Redacted.value(lease.appliedConfig) ||
      (!lease.created && lease.originalConfig === undefined)
    )
      return yield* new NativeRuntimeError({ kind: "plugin_conflict" });
    const entries = current
      .filter((plugin) => plugin.pluginId !== lease.pluginId)
      .map((plugin) => ({ pluginId: plugin.pluginId }));
    yield* setPlugins(
      lease.binding,
      lease.botId,
      lease.created
        ? entries
        : [
            ...entries,
            {
              configUpdate: {
                pluginId: lease.pluginId,
                mcpConfigJson:
                  lease.originalConfig === undefined
                    ? undefined
                    : Redacted.value(lease.originalConfig),
              },
            },
          ],
    );
  });
  const ensureSkill = Effect.fnUntraced(function* (input: typeof SkillInput.Type) {
    const value = yield* decode(SkillInput, input, "invalid_input");
    const list = () =>
      native
        .runtimeRequest(value.binding, "ListGrokBotAgentSkills", {
          agentId: value.botId,
        })
        .pipe(Effect.flatMap((raw) => decode(SkillList, raw, "response")));
    const matches = (skills: readonly (typeof Skill.Type)[]) =>
      skills.filter((skill) => skill.name === value.name);
    const before = matches((yield* list()).skills ?? []);
    if (before.length > 1) return yield* new NativeRuntimeError({ kind: "skill_conflict" });
    const original = before[0];
    if (original?.description === value.description && original.body === value.body)
      return { skillId: original.id, changed: false };
    // Only this exact reserved name is touched. Native mutation receipts do not carry
    // the canonical body, so a separate list read is the installation proof.
    yield* native.runtimeRequest(
      value.binding,
      original === undefined ? "AddGrokBotAgentSkill" : "UpdateGrokBotAgentSkill",
      {
        agentId: value.botId,
        name: value.name,
        description: value.description,
        content: [
          "---",
          `name: ${encodeYamlScalar(value.name)}`,
          `description: ${encodeYamlScalar(value.description)}`,
          "---",
          "",
          value.body,
        ].join("\n"),
      },
    );
    const after = matches((yield* list()).skills ?? []);
    const installed = after[0];
    if (
      after.length !== 1 ||
      installed?.description !== value.description ||
      installed.body !== value.body
    )
      return yield* new NativeRuntimeError({ kind: "uncertain" });
    return { skillId: installed.id, changed: true };
  });
  return GrokBotNativeRuntimeService.of({
    accountBinding: native.accountBinding,
    usageLimits: native.usageLimits,
    accountInfo: native.accountInfo,
    roster,
    sessionContext,
    tasks,
    startTurn,
    receiveAttachments: native.receiveAttachments,
    uploadAttachments: native.uploadAttachments,
    sendStatus,
    interrupt,
    resolveAutoReviewApproval,
    resolveLocalToolPermission,
    resolveConnectorGrant,
    respondToWidget,
    dismissWidget,
    submitSecret,
    secretRequests,
    recreateComputer,
    resetComputer,
    computerUpgradeSchedule,
    watch,
    settlementSnapshot,
    openSettlementWatch,
    watchSettlements,
    plugins,
    upsertPlugin,
    restorePlugin,
    ensureSkill,
  });
});
export const layer = Layer.effect(GrokBotNativeRuntimeService, make);
