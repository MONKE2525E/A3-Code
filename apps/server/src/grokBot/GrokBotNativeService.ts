import { grokBotComputerSocketUrl } from "./grokBotComputerSocketUrl.ts";
import {
  GrokBotTeachRecording,
  GrokBotId,
  GrokBotRuntimeActivity,
  type ServerProviderUsageLimits,
  type ChatAttachment,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  isProviderSendTurnSupportedImageMimeType,
} from "@t3tools/contracts";
import {
  attachmentFileExtension,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto has no Chromium Safe Storage AES/PBKDF2 support.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native attachment URLs always name POSIX paths, independently of the host filesystem.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as GatewayEventStream from "./GatewayEventStream.ts";
import * as ConnectJsonStream from "./ConnectJsonStream.ts";
import * as ByteSize from "effect/ByteSize";
import * as Duration from "effect/Duration";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import { grokBotUsageLimits } from "./grokBotUsageLimits.ts";

const OptionalString = Schema.optionalKey(Schema.String);
const OptionalBoolean = Schema.optionalKey(Schema.Boolean);
const Millis = Schema.Union([Schema.String, Schema.Number]);
const encodeUploadIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const NativeAgent = Schema.Struct({
  id: OptionalString,
  agentId: GrokBotId,
  name: OptionalString,
  title: OptionalString,
  description: OptionalString,
  avatarShape: OptionalString,
  avatarColor: OptionalString,
  avatarVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const NativeLive = Schema.Struct({
  isRunning: OptionalBoolean,
  isComposingMessage: OptionalBoolean,
  hasRunningSubagents: OptionalBoolean,
  updatedAtMs: Schema.optionalKey(Millis),
  staleAfterMs: Schema.optionalKey(Millis),
  activity: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.String,
      tool: OptionalString,
      detail: OptionalString,
      target: OptionalString,
    }),
  ),
  awaiting: Schema.optionalKey(
    Schema.Struct({
      reason: OptionalString,
      sinceMs: Schema.optionalKey(Millis),
    }),
  ),
});
const NativeStatus = Schema.Struct({
  agentId: GrokBotId,
  isRunning: OptionalBoolean,
  live: Schema.optionalKey(NativeLive),
  client: Schema.optionalKey(
    Schema.Struct({
      notifyOnUpdatesEnabled: OptionalBoolean,
      hiddenFromSidebar: OptionalBoolean,
    }),
  ),
});
const Roster = Schema.Struct({ agents: Schema.optionalKey(Schema.Array(NativeAgent)) });
const decodeAccountDetails = Schema.decodeUnknownEffect(
  Schema.Struct({
    email: Schema.optionalKey(Schema.String),
  }),
);
const decodeAccountPlan = Schema.decodeUnknownEffect(
  Schema.Struct({
    grokPlanLabel: Schema.optionalKey(Schema.String),
    includedUsageSuperGrokPlan: Schema.optionalKey(Schema.String),
  }),
);
const Statuses = Schema.Struct({ statuses: Schema.optionalKey(Schema.Array(NativeStatus)) });
const Transcript = Schema.Struct({
  entries: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        body: OptionalString,
        blobHash: OptionalString,
        seq: Millis,
      }),
    ),
  ),
});
const Secrets = Schema.Record(Schema.String, Schema.Unknown);
const Accounts = Schema.Struct({
  active: Schema.NullOr(Schema.String),
  accounts: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
});
const encodeBinding = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSecrets = Schema.decodeEffect(Schema.fromJsonString(Secrets));
const decodeAccounts = Schema.decodeEffect(Schema.fromJsonString(Accounts));

export class NativeReadError extends Schema.TaggedError<NativeReadError>()(
  "GrokBotNativeReadError",
  {
    stage: Schema.Literals(["session", "request", "response"]),
    status: Schema.optionalKey(Schema.Number),
    transient: Schema.optionalKey(Schema.Boolean),
  },
) {
  // Native session/schema/HTTP errors can carry credentials. Only bounded categories leave this adapter.
  override get message() {
    return "The direct Grok Bot read connection is unavailable.";
  }
}

const isNativeReadError = Schema.is(NativeReadError);
export class NativeSignedOutError extends Schema.TaggedError<NativeSignedOutError>()(
  "GrokBotNativeSignedOutError",
  {},
) {
  override get message() {
    return "No Grok Bot desktop account is selected.";
  }
}
const isNativeSignedOutError = Schema.is(NativeSignedOutError);

export type NativeRuntimeMethod =
  | "GetGrokBotUserRuntimeSettings"
  | "UpdateGrokBotUserRuntimeSettings"
  | "ListGrokBotAgentAutomations"
  | "ListGrokBotAccountAutomations"
  | "SetGrokBotAgentAutomationEnabled"
  | "DeleteGrokBotAgentAutomation"
  | "ResolveGrokBotAutoReviewApproval"
  | "ResolveGrokBotLocalToolPermission"
  | "ResolveGrokBotConnectorGrant"
  | "RespondGrokBotWidget"
  | "DismissGrokBotWidget"
  | "SubmitGrokBotSecret"
  | "ListGrokBotTranscriptEntries"
  | "RecreateSandBox"
  | "ForceRecreateSandBox"
  | "GetSandBoxUpgradeSchedule"
  | "ReadGrokBotAgentAttachmentChunk"
  | "UploadGrokBotAgentAttachmentChunk"
  | "SendGrokBotUserMessage"
  | "UpdateGrokBotAgent"
  | "DeleteGrokBotAgent"
  | "SetGrokBotAgentClientState"
  | "GetGrokBotSendStatus"
  | "InterruptGrokBotAgentRun"
  | "GetGrokBotAgentPlugins"
  | "SetGrokBotAgentPlugins"
  | "ListGrokBotAgentSkills"
  | "AddGrokBotAgentSkill"
  | "UpdateGrokBotAgentSkill"
  | "ListGrokBotAgents"
  | "ListGrokBotAgentSessions"
  | "ListGrokBotTasks"
  | "GetSandBoxRunState"
  | "EnsureSandBox"
  | "MintSandVoiceCallSecret"
  | "VoiceCallHarnessSession"
  | "VoiceCallHarnessTool";

/** Gateway methods the official voice call store uses to mark presence and record the finished call. */
export type NativeVoiceGatewayMethod = "recordVoiceCall" | "setVoiceCallPresence";

export class NativeAttachmentError extends Schema.TaggedError<NativeAttachmentError>()(
  "GrokBotNativeAttachmentError",
  {
    reason: Schema.Literals([
      "invalid",
      "missing",
      "changed",
      "too_large",
      "upload_failed",
      "invalid_receipt",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "too_large":
        return "The attachment exceeds the upload limit. The Grok Bot message was not sent.";
      case "missing":
        return "An attachment is no longer available. Attach it again; the Grok Bot message was not sent.";
      case "changed":
        return "An attachment changed during upload. Attach it again; the Grok Bot message was not sent.";
      case "invalid":
        return "An attachment is empty or unsupported. The Grok Bot message was not sent.";
      default:
        return "The Grok Bot attachment upload could not be confirmed. The message was not sent. Retry the attachment upload.";
    }
  }
}

export type NativeReceivedAttachmentsInput = {
  readonly binding: string;
  readonly botId: string;
  readonly threadId: string;
  readonly entryId: string;
  readonly attachmentsDir: string;
  readonly attachments: readonly {
    readonly url: string;
    readonly name?: string;
    readonly image: boolean;
  }[];
};

export type NativeAttachmentsInput = {
  readonly binding: string;
  readonly botId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly attachmentsDir: string;
  readonly attachments: readonly ChatAttachment[];
};

export type NativeMcpReadRequest =
  | {
      readonly method: "GetAvailableMcpServers";
      readonly input: { readonly grokBotAgentId?: string };
    }
  | {
      readonly method: "ListSandMcpTools";
      readonly input: {
        readonly serverIdentifiers: readonly string[];
        readonly mcpConfigJson?: string;
        readonly grokBotPluginScope?: { readonly agentId: string; readonly sessionKind: string };
      };
    }
  | {
      readonly method: "GetMcpConfig";
      readonly input: { readonly teamScope: boolean; readonly teamId: number };
    }
  | { readonly method: "GetGrokBotUserMcpSettings"; readonly input: object };

/** Marketplace calls that live on the dashboard service rather than the Grok Bot service. */
const DASHBOARD_MARKETPLACE_METHODS: ReadonlySet<string> = new Set([
  "ListMarketplacePlugins",
  "GetEffectiveUserPlugins",
  "InstallUserPlugin",
  "UninstallUserPlugin",
  "CheckHttpMcpStatus",
  "CompleteMcpOAuth",
]);
const PLUGIN_CATALOG_MAX_BYTES = 64 * 1024 * 1024;

/** Marketplace reads, plus the one write that creates a bot from a template. Installing a plugin is a separate account write; a template import never installs its plugins. */
export type NativeMarketplaceRequest =
  | {
      readonly method: "CheckHttpMcpStatus";
      readonly input: {
        readonly serverIds: readonly number[];
        readonly oauthRedirectUri: string;
        readonly accountKey: string;
        readonly forceReauth: boolean;
      };
    }
  | {
      readonly method: "CompleteMcpOAuth";
      readonly input: { readonly stateId: string; readonly authorizationCode: string };
    }
  | {
      readonly method: "ListMarketplacePlugins";
      readonly input: { readonly excludeCloudAgentPlugins: true; readonly pageToken?: string };
    }
  | {
      readonly method: "GetEffectiveUserPlugins";
      readonly input: { readonly excludeConfiguredVariables: true };
    }
  | {
      readonly method: "InstallUserPlugin";
      /** An int64 id travels as a string in Connect JSON. */
      readonly input: {
        readonly pluginId: string;
        readonly variables?: Readonly<Record<string, string>>;
      };
    }
  | { readonly method: "UninstallUserPlugin"; readonly input: { readonly pluginId: string } }
  | {
      readonly method: "ListPublicGrokBotMarketplaceListings";
      readonly input: { readonly pageSize: number; readonly pageToken?: string };
    }
  | {
      readonly method: "GetGrokBotTemplateImportDetails";
      readonly input: { readonly shareId: string };
    }
  | {
      readonly method: "CreateGrokBotAgentFromTemplate";
      readonly input: {
        readonly shareId: string;
        readonly agentId: string;
        readonly expectedActiveVersion: number;
        /** T3 has no setup delegation, so the account must run setup itself or leave it conversational. */
        readonly setupDelegationSupported: false;
      };
    };

type NativeBotProfile = {
  readonly id: string;
  /** Profile mutations use the roster record id; messaging uses agentId. */
  readonly nativeProfileId?: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly avatarShape?: string;
  readonly avatarColor?: string;
  /** An uploaded/generated photo takes precedence over the character in the native app. */
  readonly hasAvatarPhoto?: boolean;
  readonly notifyOnAgentUpdates?: boolean;
  readonly hiddenFromSidebar?: boolean;
  readonly runtimeActivity?: typeof GrokBotRuntimeActivity.Type;
};

export class GrokBotNativeService extends Context.Service<
  GrokBotNativeService,
  {
    readonly receiveAttachments: (
      input: NativeReceivedAttachmentsInput,
    ) => Effect.Effect<readonly ChatAttachment[], NativeReadError | NativeSignedOutError>;
    readonly uploadAttachments: (
      input: NativeAttachmentsInput,
    ) => Effect.Effect<
      { readonly paths: readonly string[]; readonly names: readonly string[] },
      NativeAttachmentError
    >;
    readonly teachRecording: (
      binding: string,
      input: {
        readonly method: "getTeachRecordingStatus" | "startTeachRecording" | "stopTeachRecording";
        readonly args: unknown;
      },
    ) => Effect.Effect<typeof GrokBotTeachRecording.Type, NativeReadError | NativeSignedOutError>;
    /** The desktop's gateway calls that finish a voice call; the gateway answers with no body. */
    readonly voiceGateway: (
      binding: string,
      input: { readonly method: NativeVoiceGatewayMethod; readonly args: object },
    ) => Effect.Effect<void, NativeReadError | NativeSignedOutError>;
    readonly computer: (
      binding: string,
      botId: string,
      wake: boolean,
    ) => Effect.Effect<
      { readonly state: string; readonly socketUrl?: string },
      NativeReadError | NativeSignedOutError
    >;
    readonly gatewaySkills: (
      binding: string,
      botId: string,
    ) => Effect.Effect<unknown, NativeReadError | NativeSignedOutError>;
    readonly gatewayRoster: (
      binding: string,
    ) => Effect.Effect<unknown, NativeReadError | NativeSignedOutError>;
    readonly gatewayEvents: (
      binding: string,
      onReady?: Effect.Effect<void>,
    ) => Stream.Stream<
      { readonly channel: string; readonly payload: unknown },
      NativeReadError | NativeSignedOutError
    >;
    readonly accountBinding: Effect.Effect<string, NativeReadError | NativeSignedOutError>;
    readonly accountInfo: (
      binding: string,
    ) => Effect.Effect<
      { readonly email?: string; readonly plan?: string },
      NativeReadError | NativeSignedOutError
    >;
    readonly usageLimits: (
      binding: string,
      checkedAt: string,
    ) => Effect.Effect<ServerProviderUsageLimits, NativeReadError | NativeSignedOutError>;
    readonly runtimeRequest: (
      binding: string,
      method: NativeRuntimeMethod,
      input: object,
    ) => Effect.Effect<unknown, NativeReadError | NativeSignedOutError>;
    readonly readMcp: (
      binding: string,
      request: NativeMcpReadRequest,
    ) => Effect.Effect<unknown, NativeReadError | NativeSignedOutError>;
    readonly marketplaceRequest: (
      binding: string,
      request: NativeMarketplaceRequest,
    ) => Effect.Effect<unknown, NativeReadError | NativeSignedOutError>;
    /** Downloads a template recipe from the URL the marketplace returned. Sends no credentials. */
    readonly templateBlob: (
      binding: string,
      url: string,
    ) => Effect.Effect<unknown, NativeReadError | NativeSignedOutError>;
    readonly watchTranscripts: (
      binding: string,
      input: object,
    ) => Stream.Stream<unknown, NativeReadError | NativeSignedOutError>;
    readonly list: Effect.Effect<
      readonly NativeBotProfile[],
      NativeReadError | NativeSignedOutError
    >;
    readonly listForBinding: (
      binding: string,
    ) => Effect.Effect<readonly NativeBotProfile[], NativeReadError | NativeSignedOutError>;
    readonly read: (botId: string) => Effect.Effect<
      {
        readonly entries: readonly unknown[];
        readonly runtimeActivity?: typeof GrokBotRuntimeActivity.Type;
      },
      NativeReadError | NativeSignedOutError
    >;
  }
>()("t3/grokBot/GrokBotNativeService") {}

const millis = (value: string | number | undefined) => {
  const number = value === undefined ? 0 : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};

function runtimeActivity(
  status: typeof NativeStatus.Type,
  observedAtMs: number,
): typeof GrokBotRuntimeActivity.Type {
  const live = status.live;
  const updatedAtMs = millis(live?.updatedAtMs);
  // The official coordinator treats staleAfterMs as a duration, with a 90 second default.
  const staleAtMs =
    live === undefined
      ? undefined
      : (updatedAtMs || observedAtMs) + (millis(live.staleAfterMs) || 90000);
  const stale = staleAtMs !== undefined && staleAtMs <= observedAtMs;
  const isRunning =
    !stale &&
    (live === undefined
      ? status.isRunning === true
      : live.isRunning === true || live.hasRunningSubagents === true);
  const activity = isRunning ? live?.activity : undefined;
  const awaiting = stale ? undefined : live?.awaiting;
  return {
    source: "native",
    observedAtMs,
    ...(staleAtMs === undefined ? {} : { staleAtMs }),
    isRunning,
    isComposingMessage: !stale && live?.isRunning === true && live.isComposingMessage === true,
    awaitingUserResponse:
      awaiting === undefined
        ? null
        : {
            reason: (awaiting.reason || "user_response").slice(0, 128),
            ...(millis(awaiting.sinceMs) > 0 ? { sinceMs: millis(awaiting.sinceMs) } : {}),
          },
    ...(activity?.kind === "thinking" || activity?.kind === "tool"
      ? {
          currentActivity: {
            kind: activity.kind,
            ...(activity.tool ? { tool: activity.tool.slice(0, 128) } : {}),
            hasDetail: Boolean(activity.detail),
            ...(activity.target ? { target: activity.target.slice(0, 128) } : {}),
          },
        }
      : {}),
  };
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const client = yield* HttpClient.HttpClient;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  const appData =
    env.T3CODE_GROK_BOT_APP_DATA_DIR?.trim() ||
    (platform === "win32"
      ? path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Grok Bot")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Grok Bot")
        : path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Grok Bot"));
  const secretCommand = Effect.fnUntraced(function* (
    command: string,
    args: readonly string[],
    stdin?: string,
  ) {
    const result = yield* runner.run({
      command,
      args,
      ...(stdin === undefined ? {} : { stdin }),
      env,
      timeout: "10 seconds",
      maxOutputBytes: 65536,
    });
    if (result.code !== 0)
      return yield* Effect.fail(
        new NativeReadError({
          stage: "session",
        }),
      );
    return result.stdout.trimEnd();
  });
  const decrypt = Effect.fnUntraced(function* (wrapped: string) {
    let value = wrapped;
    if (value.startsWith("scoped:v1:")) {
      const split = value.indexOf(":", "scoped:v1:".length);
      if (split < 0 || !/^[0-9a-f]{64}$/.test(value.slice("scoped:v1:".length, split)))
        return yield* Effect.fail(new NativeReadError({ stage: "session" }));
      value = value.slice(split + 1);
    }
    if (value.startsWith("plaintext:v1:"))
      return Buffer.from(value.slice("plaintext:v1:".length), "base64").toString("utf8");
    const bytes = Buffer.from(value, "base64");
    const prefix = bytes.subarray(0, 3).toString("ascii");
    if (platform === "win32") {
      const state = yield* decodeSecrets(
        yield* fs.readFileString(path.join(appData, "Local State")),
      );
      const stateSchema = Schema.Struct({
        os_crypt: Schema.Struct({ encrypted_key: Schema.String }),
      });
      const decoded = yield* Schema.decodeUnknownEffect(stateSchema)(state);
      const protectedKey = Buffer.from(decoded.os_crypt.encrypted_key, "base64");
      if (prefix !== "v10" || protectedKey.subarray(0, 5).toString() !== "DPAPI")
        return yield* Effect.fail(
          new NativeReadError({
            stage: "session",
          }),
        );
      const script =
        "Add-Type -AssemblyName System.Security; $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'))";
      const clearKey = yield* secretCommand(
        path.join(
          env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        protectedKey.subarray(5).toString("base64"),
      );
      return yield* Effect.try(() => {
        const decipher = NodeCrypto.createDecipheriv(
          "aes-256-gcm",
          Buffer.from(clearKey, "base64"),
          bytes.subarray(3, 15),
        );
        decipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([decipher.update(bytes.subarray(15, -16)), decipher.final()]).toString(
          "utf8",
        );
      });
    }
    if (prefix !== "v10" && !(platform === "linux" && prefix === "v11"))
      return yield* Effect.fail(
        new NativeReadError({
          stage: "session",
        }),
      );
    const password =
      platform === "linux" && prefix === "v10"
        ? "peanuts"
        : platform === "linux"
          ? yield* secretCommand("secret-tool", [
              "lookup",
              "xdg:schema",
              "chrome_libsecret_os_crypt_password_v2",
              "application",
              "Grok Bot",
            ])
          : yield* secretCommand("/usr/bin/security", [
              "find-generic-password",
              "-w",
              "-s",
              "Grok Bot Safe Storage",
            ]);
    return yield* Effect.try(() => {
      const key = NodeCrypto.pbkdf2Sync(
        password,
        "saltysalt",
        platform === "darwin" ? 1003 : 1,
        16,
        "sha1",
      );
      const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
      return Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]).toString("utf8");
    });
  });
  // Read only the selected account. Never refresh tokens, migrate the store, or expose profiles.
  const session = Effect.gen(function* () {
    const secrets = yield* decodeSecrets(
      yield* fs.readFileString(path.join(appData, "sand-secrets.json")),
    );
    if (secrets.version !== undefined && secrets.version !== 1)
      return yield* Effect.fail(new NativeReadError({ stage: "session" }));
    let token: string | undefined;
    let accountSlot: string | undefined;
    let team: string | undefined;
    if (typeof secrets["cursor-accounts"] === "string") {
      const accounts = yield* decodeAccounts(secrets["cursor-accounts"]);
      if (accounts.active === null) return yield* new NativeSignedOutError({});
      accountSlot = accounts.active;
      const selected = accounts.accounts[accounts.active];
      token = selected?.["cursor-access-token"];
      if (!token) return yield* new NativeSignedOutError({});
      team = selected?.["cursor-selected-team-id"];
    } else if (typeof secrets["cursor-access-token"] === "string") {
      token = secrets["cursor-access-token"];
      team =
        typeof secrets["cursor-selected-team-id"] === "string"
          ? secrets["cursor-selected-team-id"]
          : undefined;
    }
    if (!token) return yield* Effect.fail(new NativeReadError({ stage: "session" }));
    const accessToken = yield* decrypt(token);
    const teamId = team === undefined ? 0 : Number(yield* decrypt(team));
    return {
      accessToken,
      ...(accountSlot === undefined ? {} : { accountSlot }),
      ...(Number.isSafeInteger(teamId) && teamId > 0 ? { teamId } : {}),
    };
  }).pipe(
    Effect.mapError((cause) =>
      isNativeSignedOutError(cause) || isNativeReadError(cause)
        ? cause
        : new NativeReadError({ stage: "session" }),
    ),
  );
  const request = Effect.fnUntraced(function* (
    auth: { readonly accessToken: string; readonly teamId?: number },
    method:
      | "ListGrokBotAgents"
      | "ListGrokBotAgentStatuses"
      | "ListGrokBotTranscriptEntries"
      | NativeRuntimeMethod
      | "GetSandUsageStatus"
      | "GetMe"
      | NativeMcpReadRequest["method"]
      | NativeMarketplaceRequest["method"],
    input: object,
    service: "GrokBotService" | "DashboardService" = "GrokBotService",
    /** The plugin catalog arrives in one large response; every other read stays small. */
    limits: { readonly maxBodyBytes: number; readonly timeout: Duration.Input } = {
      maxBodyBytes: 2 * 1024 * 1024,
      timeout: "15 seconds",
    },
  ) {
    // A fixed official origin prevents a remote client from selecting where credentials go.
    const rpc = HttpClientRequest.post(
      `https://api2.cursor.sh/aiserver.v1.${service}/${method}`,
    ).pipe(
      HttpClientRequest.setHeaders({
        "connect-protocol-version": "1",
        "x-cursor-client-type": "sand",
        "x-cursor-client-version": "0.68.1",
        "x-cursor-client-os": platform,
        "x-sand-box-namespace": "prod",
        "x-ghost-mode": "true",
        ...(auth.teamId === undefined ? {} : { "x-cursor-team-id": String(auth.teamId) }),
      }),
      HttpClientRequest.bearerToken(auth.accessToken),
      HttpClientRequest.bodyJsonUnsafe(input),
    );
    return yield* Effect.gen(function* () {
      const response = yield* client.execute(rpc);
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.fail(
          new NativeReadError({ stage: "request", status: response.status }),
        );
      return yield* response.json.pipe(
        Effect.mapError(() => new NativeReadError({ stage: "response" })),
      );
    }).pipe(
      Effect.timeout(limits.timeout),
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limits.maxBodyBytes)),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.mapError((cause) =>
        isNativeReadError(cause) ? cause : new NativeReadError({ stage: "request" }),
      ),
    );
  });
  const statuses = (
    auth: { readonly accessToken: string; readonly teamId?: number },
    ids: readonly string[],
  ) =>
    request(auth, "ListGrokBotAgentStatuses", { agentIds: ids }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Statuses)),
      Effect.mapError((cause) =>
        isNativeReadError(cause) ? cause : new NativeReadError({ stage: "response" }),
      ),
    );
  // Runtime operations must stay on the selected account/team captured by the durable provider session.
  // Legacy stores without a stable account slot can still be read, but cannot own managed turns.
  const bindingFor = (auth: { readonly accountSlot?: string; readonly teamId?: number }) =>
    auth.accountSlot === undefined
      ? undefined
      : NodeCrypto.createHash("sha256")
          .update(encodeBinding([auth.accountSlot, auth.teamId ?? null]))
          .digest("hex");
  const boundSession = Effect.fnUntraced(function* (binding: string) {
    const auth = yield* session;
    if (!/^[0-9a-f]{64}$/.test(binding) || bindingFor(auth) !== binding)
      return yield* Effect.fail(new NativeReadError({ stage: "session" }));
    return auth;
  });
  const accountBinding = session.pipe(
    Effect.flatMap((auth) => {
      const binding = bindingFor(auth);
      return binding === undefined
        ? Effect.fail(new NativeReadError({ stage: "session" }))
        : Effect.succeed(binding);
    }),
  );
  const listForSession = Effect.fnUntraced(function* (auth: {
    readonly accessToken: string;
    readonly accountSlot?: string;
    readonly teamId?: number;
  }) {
    const roster = yield* request(auth, "ListGrokBotAgents", {}).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Roster)),
      Effect.mapError((cause) =>
        isNativeReadError(cause) ? cause : new NativeReadError({ stage: "response" }),
      ),
    );
    const states = yield* statuses(
      auth,
      (roster.agents ?? []).map((agent) => agent.agentId),
    );
    const selected = yield* session;
    if (selected.accountSlot !== auth.accountSlot || selected.teamId !== auth.teamId)
      return yield* new NativeReadError({ stage: "session" });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const byId = new Map((states.statuses ?? []).map((status) => [status.agentId, status]));
    return (roster.agents ?? []).map((agent) => {
      const status = byId.get(agent.agentId);
      return {
        id: agent.agentId,
        ...(agent.id === undefined ? {} : { nativeProfileId: agent.id }),
        name: agent.name ?? "",
        ...(agent.title === undefined ? {} : { title: agent.title }),
        ...(agent.description === undefined ? {} : { description: agent.description }),
        ...(agent.avatarShape ? { avatarShape: agent.avatarShape } : {}),
        ...(agent.avatarColor ? { avatarColor: agent.avatarColor } : {}),
        hasAvatarPhoto: Boolean(agent.avatarVersion || agent.avatarUrl),
        ...(status?.client === undefined
          ? {}
          : {
              notifyOnAgentUpdates: status.client.notifyOnUpdatesEnabled ?? false,
              hiddenFromSidebar: status.client.hiddenFromSidebar ?? false,
            }),
        ...(status === undefined ? {} : { runtimeActivity: runtimeActivity(status, now) }),
      };
    });
  });
  const list = session.pipe(Effect.flatMap(listForSession));
  const listForBinding = (binding: string) =>
    boundSession(binding).pipe(Effect.flatMap(listForSession));
  const read = Effect.fnUntraced(function* (botId: string) {
    const auth = yield* session;
    const [tail, states] = yield* Effect.all(
      [
        request(auth, "ListGrokBotTranscriptEntries", {
          agentId: botId,
          sessionId: "",
          limit: 200,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Transcript)),
          Effect.mapError((cause) =>
            isNativeReadError(cause) ? cause : new NativeReadError({ stage: "response" }),
          ),
        ),
        statuses(auth, [botId]),
      ],
      { concurrency: 2 },
    );
    // Blob-only rows need the official presigned-read adapter; do not present a partial tail as complete.
    if ((tail.entries ?? []).some((entry) => !entry.body))
      return yield* Effect.fail(new NativeReadError({ stage: "response" }));
    const entries = yield* Effect.forEach((tail.entries ?? []).toReversed(), (entry) =>
      Effect.try({
        try: () =>
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(entry.body ?? "", "base64")),
        catch: () => new NativeReadError({ stage: "response" }),
      }).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))),
        Effect.mapError(() => new NativeReadError({ stage: "response" })),
      ),
    );
    const status = states.statuses?.find((state) => state.agentId === botId);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return {
      entries,
      ...(status === undefined ? {} : { runtimeActivity: runtimeActivity(status, now) }),
    };
  });
  const runtimeRequest = Effect.fnUntraced(function* (
    binding: string,
    method: NativeRuntimeMethod,
    input: object,
  ) {
    const result = yield* request(yield* boundSession(binding), method, input);
    yield* boundSession(binding).pipe(
      Effect.catchTags({
        GrokBotNativeReadError: () => Effect.fail(new NativeReadError({ stage: "response" })),
        GrokBotNativeSignedOutError: () => Effect.fail(new NativeReadError({ stage: "response" })),
      }),
    );
    return result;
  });
  const receiveAttachments = Effect.fn("GrokBotNativeService.receiveAttachments")(function* (
    input: NativeReceivedAttachmentsInput,
  ) {
    yield* boundSession(input.binding);
    if (!path.isAbsolute(input.attachmentsDir))
      return yield* new NativeReadError({ stage: "response" });
    const chunkSchema = Schema.Struct({
      data: Schema.optionalKey(Schema.String),
      totalSize: Schema.Union([Schema.String, Schema.Number]),
    });
    const attachments: ChatAttachment[] = [];
    for (const media of input.attachments) {
      const filePath = yield* Effect.try({
        try: () => {
          const url = new URL(media.url);
          const decoded = decodeURIComponent(url.pathname);
          const root = "/home/box/agent-data/agents/" + input.botId + "/attachments/";
          if (
            url.protocol !== "file:" ||
            url.hostname ||
            url.search ||
            url.hash ||
            !decoded.startsWith(root) ||
            NodePath.posix.normalize(decoded) !== decoded ||
            decoded.slice(root.length).includes("/")
          )
            throw new Error("invalid attachment path");
          return decoded;
        },
        catch: () => new NativeReadError({ stage: "response" }),
      });
      const name = (media.name ?? NodePath.posix.basename(filePath)).trim();
      if (!name || name.length > 255) return yield* new NativeReadError({ stage: "response" });
      const extension = NodePath.posix.extname(filePath).toLowerCase();
      const mimeType =
        (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".svg": "image/svg+xml",
            ".txt": "text/plain",
            ".pdf": "application/pdf",
            ".mp4": "video/mp4",
            ".webm": "video/webm",
          } as Record<string, string>
        )[extension] ?? "application/octet-stream";
      if (media.image && !mimeType.startsWith("image/"))
        return yield* new NativeReadError({ stage: "response" });
      const baseId = createDeterministicAttachmentId(
        input.threadId,
        encodeUploadIdentity([input.binding, input.botId, input.entryId, media.url]),
      );
      if (baseId === null) return yield* new NativeReadError({ stage: "response" });
      const id = media.image ? baseId : `${baseId}-${attachmentFileExtension(name).slice(1)}`;
      const provisional = {
        type: media.image ? ("image" as const) : ("file" as const),
        id,
        name,
        mimeType,
        sizeBytes: 1,
      };
      const target = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment: provisional,
      });
      if (target === null) return yield* new NativeReadError({ stage: "response" });
      const cached = yield* fs.stat(target).pipe(Effect.orElseSucceed(() => undefined));
      if (cached?.type === "File" && cached.size > 0n) {
        attachments.push({ ...provisional, sizeBytes: Number(cached.size) });
        continue;
      }
      const read = (offset: number, length: number) =>
        requestSessionChunk(input.binding, filePath, offset, length);
      const requestSessionChunk = Effect.fnUntraced(function* (
        binding: string,
        path: string,
        offset: number,
        length: number,
      ) {
        return yield* request(yield* boundSession(binding), "ReadGrokBotAgentAttachmentChunk", {
          path,
          offset: String(offset),
          length,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(chunkSchema)),
          Effect.mapError(() => new NativeReadError({ stage: "response" })),
        );
      });
      const metadata = yield* read(0, 0);
      const sizeBytes = Number(metadata.totalSize);
      const limit = media.image
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > limit)
        return yield* new NativeReadError({ stage: "response" });
      const bytes = new Uint8Array(sizeBytes);
      let offset = 0;
      while (offset < sizeBytes) {
        const length = Math.min(256 * 1024, sizeBytes - offset);
        const chunk = yield* read(offset, length);
        const decoded = Buffer.from(chunk.data ?? "", "base64");
        if (Number(chunk.totalSize) !== sizeBytes || decoded.byteLength !== length)
          return yield* new NativeReadError({ stage: "response" });
        bytes.set(decoded, offset);
        offset += length;
      }
      yield* boundSession(input.binding);
      const partPath = target + "." + NodeCrypto.randomUUID() + ".part";
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFile(partPath, bytes);
        yield* fs.rename(partPath, target);
      }).pipe(
        Effect.mapError(() => new NativeReadError({ stage: "response" })),
        Effect.ensuring(
          fs.remove(partPath, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      );
      attachments.push({ ...provisional, sizeBytes });
    }
    return attachments;
  });
  const uploadAttachments = Effect.fn("GrokBotNativeService.uploadAttachments")(function* (
    input: NativeAttachmentsInput,
  ) {
    if (getProviderAttachmentLimitError(input.attachments) !== undefined)
      return yield* new NativeAttachmentError({ reason: "too_large" });
    if (!path.isAbsolute(input.attachmentsDir))
      return yield* new NativeAttachmentError({ reason: "invalid" });
    const files: { attachment: ChatAttachment; filePath: string }[] = [];
    // Validate every file before creating any remote upload or sending any message.
    for (const attachment of input.attachments) {
      if (
        attachment.type === "image" &&
        !isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
      )
        return yield* new NativeAttachmentError({ reason: "invalid" });
      const filePath = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
      if (filePath === null) return yield* new NativeAttachmentError({ reason: "invalid" });
      const stat = yield* fs
        .stat(filePath)
        .pipe(Effect.mapError(() => new NativeAttachmentError({ reason: "missing" })));
      if (stat.type !== "File" || stat.size === 0n)
        return yield* new NativeAttachmentError({ reason: "invalid" });
      if (
        stat.size >
        BigInt(
          attachment.type === "image"
            ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            : PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        )
      )
        return yield* new NativeAttachmentError({ reason: "too_large" });
      if (stat.size !== BigInt(attachment.sizeBytes))
        return yield* new NativeAttachmentError({ reason: "changed" });
      files.push({ attachment, filePath });
    }
    const paths: string[] = [];
    const names: string[] = [];
    const receiptSchema = Schema.Struct({
      receivedBytes: Schema.optionalKey(Millis),
      path: OptionalString,
    });
    for (const { attachment, filePath } of files) {
      // One bounded file at a time; only small chunks cross the native HTTP boundary.
      const bytes = yield* fs
        .readFile(filePath)
        .pipe(Effect.mapError(() => new NativeAttachmentError({ reason: "missing" })));
      if (bytes.byteLength !== attachment.sizeBytes)
        return yield* new NativeAttachmentError({ reason: "changed" });
      const sha256Hex = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const uploadId = NodeCrypto.createHash("sha256")
        .update(
          encodeUploadIdentity([
            input.binding,
            input.botId,
            input.sessionId,
            input.messageId,
            attachment.id,
            sha256Hex,
          ]),
        )
        .digest("hex");
      let offset = 0;
      let committedPath: string | undefined;
      while (offset < bytes.byteLength) {
        const end = Math.min(offset + 512 * 1024, bytes.byteLength);
        const response = yield* runtimeRequest(input.binding, "UploadGrokBotAgentAttachmentChunk", {
          agentId: input.botId,
          sessionId: input.sessionId,
          uploadId,
          fileName: attachment.name,
          offset: String(offset),
          totalSize: String(bytes.byteLength),
          data: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
          sha256Hex,
        }).pipe(
          Effect.mapError(
            (error) =>
              new NativeAttachmentError({
                reason:
                  error._tag === "GrokBotNativeReadError" && error.status === 413
                    ? "too_large"
                    : "upload_failed",
              }),
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)),
          Effect.mapError((error) =>
            error._tag === "GrokBotNativeAttachmentError"
              ? error
              : new NativeAttachmentError({ reason: "invalid_receipt" }),
          ),
        );
        const received = Number(response.receivedBytes ?? 0);
        if (
          !Number.isSafeInteger(received) ||
          received < end ||
          received > bytes.byteLength ||
          (received !== end && (received !== bytes.byteLength || !response.path)) ||
          (response.path !== undefined &&
            (received !== bytes.byteLength ||
              response.path.length === 0 ||
              response.path.length > 4096))
        )
          return yield* new NativeAttachmentError({ reason: "invalid_receipt" });
        offset = received;
        committedPath = response.path;
      }
      if (!committedPath) return yield* new NativeAttachmentError({ reason: "invalid_receipt" });
      paths.push(committedPath);
      names.push(attachment.name);
    }
    return { paths, names };
  });
  const usageLimits = Effect.fnUntraced(function* (binding: string, checkedAt: string) {
    const auth = yield* boundSession(binding);
    const sand = yield* request(auth, "GetSandUsageStatus", {}, "DashboardService");
    yield* boundSession(binding).pipe(
      Effect.mapError(() => new NativeReadError({ stage: "response" })),
    );
    return yield* Effect.try({
      // Native account slots hash the authentication principal; the binding also includes its team.
      try: () => ({ ...grokBotUsageLimits(sand, checkedAt), credentialFingerprint: binding }),
      catch: () => new NativeReadError({ stage: "response" }),
    });
  });
  const accountInfo = Effect.fnUntraced(function* (binding: string) {
    const auth = yield* boundSession(binding);
    const [me, usage] = yield* Effect.all(
      [
        request(auth, "GetMe", {}, "DashboardService"),
        request(auth, "GetSandUsageStatus", {}, "DashboardService"),
      ],
      { concurrency: 2 },
    );
    yield* boundSession(binding);
    const details = yield* decodeAccountDetails(me).pipe(
      Effect.mapError(() => new NativeReadError({ stage: "response" })),
    );
    const plan = yield* decodeAccountPlan(usage).pipe(
      Effect.mapError(() => new NativeReadError({ stage: "response" })),
    );
    const label = plan.grokPlanLabel?.trim() || plan.includedUsageSuperGrokPlan?.trim();
    return {
      ...(details.email?.trim() ? { email: details.email.trim() } : {}),
      ...(label ? { plan: label } : {}),
    };
  });
  const readMcp = Effect.fnUntraced(function* (binding: string, read: NativeMcpReadRequest) {
    const result = yield* request(
      yield* boundSession(binding),
      read.method,
      read.method === "GetMcpConfig" ? { ...read.input, redactSecrets: true } : read.input,
      read.method === "GetGrokBotUserMcpSettings" ? "GrokBotService" : "DashboardService",
    );
    yield* boundSession(binding).pipe(
      Effect.mapError(() => new NativeReadError({ stage: "response" })),
    );
    return result;
  });
  const marketplaceRequest = Effect.fnUntraced(function* (
    binding: string,
    read: NativeMarketplaceRequest,
  ) {
    const result = yield* request(
      yield* boundSession(binding),
      read.method,
      read.input,
      DASHBOARD_MARKETPLACE_METHODS.has(read.method) ? "DashboardService" : "GrokBotService",
      read.method === "ListMarketplacePlugins"
        ? { maxBodyBytes: PLUGIN_CATALOG_MAX_BYTES, timeout: "45 seconds" }
        : read.method === "InstallUserPlugin" ||
            read.method === "UninstallUserPlugin" ||
            read.method === "CheckHttpMcpStatus" ||
            read.method === "CompleteMcpOAuth"
          ? { maxBodyBytes: 2 * 1024 * 1024, timeout: "45 seconds" }
          : undefined,
    );
    yield* boundSession(binding).pipe(
      Effect.mapError(() => new NativeReadError({ stage: "response" })),
    );
    return result;
  });
  const templateBlob = Effect.fnUntraced(
    function* (binding: string, url: string) {
      yield* boundSession(binding);
      const target = yield* Effect.try({
        try: () => new URL(url),
        catch: () => new NativeReadError({ stage: "response" }),
      });
      if (target.protocol !== "https:") return yield* new NativeReadError({ stage: "response" });
      const response = yield* client.execute(HttpClientRequest.get(target.href)).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => new NativeReadError({ stage: "request" })),
      );
      if (response.status < 200 || response.status >= 300)
        return yield* new NativeReadError({ stage: "request", status: response.status });
      const blob = yield* response.json.pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => new NativeReadError({ stage: "response" })),
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(26)),
      );
      yield* boundSession(binding).pipe(
        Effect.mapError(() => new NativeReadError({ stage: "response" })),
      );
      return blob;
    },
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  );
  const watchTranscripts = (binding: string, input: object) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const auth = yield* boundSession(binding);
        const rpc = HttpClientRequest.post(
          "https://api2.cursor.sh/aiserver.v1.GrokBotService/WatchGrokBotTranscripts",
        ).pipe(
          HttpClientRequest.setHeaders({
            "connect-protocol-version": "1",
            "connect-timeout-ms": "300000",
            "x-cursor-client-type": "sand",
            "x-cursor-client-version": "0.68.1",
            "x-cursor-client-os": platform,
            "x-sand-box-namespace": "prod",
            "x-ghost-mode": "true",
            ...(auth.teamId === undefined ? {} : { "x-cursor-team-id": String(auth.teamId) }),
          }),
          HttpClientRequest.bearerToken(auth.accessToken),
          HttpClientRequest.bodyUint8Array(
            ConnectJsonStream.encodeMessage(input),
            "application/connect+json",
          ),
        );
        const response = yield* client.execute(rpc).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(() => new NativeReadError({ stage: "request", transient: true })),
        );
        if (
          response.status !== 200 ||
          !response.headers["content-type"]?.startsWith("application/connect+json")
        )
          return yield* Effect.fail(
            new NativeReadError({
              stage: "request",
              status: response.status,
              transient: [408, 502, 503, 504].includes(response.status),
            }),
          );
        return ConnectJsonStream.decodeMessages(
          response.stream.pipe(
            Stream.mapError(() => new NativeReadError({ stage: "response", transient: true })),
          ),
        ).pipe(
          Stream.mapEffect((frame) => boundSession(binding).pipe(Effect.as(frame))),
          Stream.mapError((error) =>
            isNativeReadError(error) || isNativeSignedOutError(error)
              ? error
              : new NativeReadError({ stage: "response" }),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isNativeReadError(cause) || isNativeSignedOutError(cause)
            ? cause
            : new NativeReadError({ stage: "request" }),
        ),
      ),
    ).pipe(
      Stream.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Stream.provideService(HttpClient.TracerDisabledWhen, () => true),
    );
  const describeGateway = Effect.fnUntraced(function* (binding: string, wake = false) {
    const auth = yield* boundSession(binding);
    // The official desktop describe operation uses wake:false. It never wakes a parked computer.
    const description = yield* request(auth, "EnsureSandBox", { wake }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            gatewayUrl: Schema.String,
            gatewayToken: Schema.String,
            vncUrl: OptionalString,
            forkVncBaseUrl: OptionalString,
            networkToken: OptionalString,
            runState: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
          }),
        ),
      ),
      Effect.mapError(() => new NativeReadError({ stage: "response" })),
    );
    if (
      description.runState !== 3 &&
      description.runState !== "SAND_BOX_RUN_STATE_RUNNING" &&
      description.runState !== "RUNNING"
    )
      return yield* new NativeReadError({ stage: "request" });
    yield* boundSession(binding);
    const baseUrl = yield* Effect.try({
      try: () => {
        const url = new URL(description.gatewayUrl);
        const host = url.hostname.toLowerCase();
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !["cursor.sh", "cursor.com", "cursorvm.com"].some(
            (domain) => host === domain || host.endsWith("." + domain),
          )
        )
          throw new Error("invalid route");
        return url.toString().replace(/\/$/, "");
      },
      catch: () => new NativeReadError({ stage: "response" }),
    });
    return {
      baseUrl,
      token: description.gatewayToken,
      primaryUrl: description.vncUrl,
      forkBaseUrl: description.forkVncBaseUrl,
      ...(description.networkToken === undefined ? {} : { networkToken: description.networkToken }),
    };
  });
  const gatewayHeaders = (connection: {
    readonly token: string;
    readonly networkToken?: string;
  }) => ({
    authorization: "Bearer " + connection.token,
    ...(connection.networkToken ? { "x-anyrun-network-token": connection.networkToken } : {}),
  });
  const gatewaySkills = Effect.fnUntraced(function* (binding: string, botId: string) {
    const connection = yield* describeGateway(binding);
    const body = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(connection.baseUrl + "/api/getAgentWorkflows"),
      { id: botId },
    ).pipe(Effect.mapError(() => new NativeReadError({ stage: "request" })));
    const result = yield* client
      .execute(HttpClientRequest.setHeaders(body, gatewayHeaders(connection)))
      .pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status !== 200)
              return yield* new NativeReadError({ stage: "request", status: response.status });
            return yield* response.json;
          }),
        ),
        Effect.timeout("15 seconds"),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(() => new NativeReadError({ stage: "response" })),
      );
    yield* boundSession(binding);
    return result;
  });
  const teachRecording = Effect.fnUntraced(function* (
    binding: string,
    input: {
      readonly method: "getTeachRecordingStatus" | "startTeachRecording" | "stopTeachRecording";
      readonly args: unknown;
    },
  ) {
    const connection = yield* describeGateway(binding);
    const body = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(connection.baseUrl + "/api/" + input.method),
      input.args,
    ).pipe(Effect.mapError(() => new NativeReadError({ stage: "request" })));
    const result = yield* client
      .execute(HttpClientRequest.setHeaders(body, gatewayHeaders(connection)))
      .pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status !== 200)
              return yield* new NativeReadError({ stage: "request", status: response.status });
            return yield* response.json;
          }),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(GrokBotTeachRecording)),
        Effect.timeout("15 seconds"),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(() => new NativeReadError({ stage: "response" })),
      );
    yield* boundSession(binding);
    return result;
  });
  const computer = Effect.fnUntraced(function* (binding: string, botId: string, wake: boolean) {
    const connection = yield* describeGateway(binding, wake);
    const body = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(
        connection.baseUrl + "/api/" + (wake ? "ensureForeverBox" : "getForeverBoxStatus"),
      ),
      { id: botId },
    ).pipe(Effect.mapError(() => new NativeReadError({ stage: "request" })));
    const response = yield* client
      .execute(HttpClientRequest.setHeaders(body, gatewayHeaders(connection)))
      .pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status !== 200)
              return yield* new NativeReadError({ stage: "request", status: response.status });
            return yield* response.json;
          }),
        ),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              state: Schema.String,
              vncUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
        Effect.mapError(() => new NativeReadError({ stage: "response" })),
        Effect.timeout("15 seconds"),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(() => new NativeReadError({ stage: "response" })),
      );
    yield* boundSession(binding);
    const socketUrl =
      response.state === "running" && response.vncUrl
        ? yield* Effect.try({
            try: () => grokBotComputerSocketUrl(response.vncUrl ?? "", connection),
            catch: () => new NativeReadError({ stage: "response" }),
          })
        : undefined;
    return { state: response.state, ...(socketUrl === undefined ? {} : { socketUrl }) };
  });
  const voiceGateway = Effect.fnUntraced(function* (
    binding: string,
    input: { readonly method: NativeVoiceGatewayMethod; readonly args: object },
  ) {
    const connection = yield* describeGateway(binding);
    const body = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(connection.baseUrl + "/api/" + input.method),
      input.args,
    ).pipe(Effect.mapError(() => new NativeReadError({ stage: "request" })));
    yield* client.execute(HttpClientRequest.setHeaders(body, gatewayHeaders(connection))).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.void
          : Effect.fail(new NativeReadError({ stage: "request", status: response.status })),
      ),
      Effect.timeout("15 seconds"),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.mapError((error) =>
        isNativeReadError(error) ? error : new NativeReadError({ stage: "response" }),
      ),
    );
    yield* boundSession(binding);
  });
  const gatewayRoster = Effect.fnUntraced(function* (binding: string) {
    const connection = yield* describeGateway(binding);
    const rpc = HttpClientRequest.post(connection.baseUrl + "/api/listAgents").pipe(
      HttpClientRequest.setHeaders(gatewayHeaders(connection)),
      HttpClientRequest.bodyJsonUnsafe({}),
    );
    return yield* Effect.gen(function* () {
      const response = yield* client.execute(rpc);
      if (response.status !== 200)
        return yield* new NativeReadError({ stage: "request", status: response.status });
      const result = yield* response.json;
      yield* boundSession(binding);
      return result;
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(2)),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.mapError((error) =>
        isNativeReadError(error) || isNativeSignedOutError(error)
          ? error
          : new NativeReadError({ stage: "request" }),
      ),
    );
  });
  const gatewayEvents = (binding: string, onReady?: Effect.Effect<void>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* describeGateway(binding);
        const rpc = HttpClientRequest.get(connection.baseUrl + "/events").pipe(
          HttpClientRequest.setHeaders({
            ...gatewayHeaders(connection),
            accept: "text/event-stream",
          }),
        );
        const response = yield* client.execute(rpc).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(() => new NativeReadError({ stage: "request", transient: true })),
        );
        if (
          response.status !== 200 ||
          !response.headers["content-type"]?.startsWith("text/event-stream")
        )
          return yield* new NativeReadError({
            stage: "request",
            status: response.status,
            transient: [408, 502, 503, 504].includes(response.status),
          });
        if (onReady !== undefined) yield* onReady;
        return GatewayEventStream.decodeEvents(
          response.stream.pipe(
            Stream.mapError(() => new NativeReadError({ stage: "response", transient: true })),
            Stream.mapEffect((chunk) => boundSession(binding).pipe(Effect.as(chunk))),
          ),
        ).pipe(
          Stream.mapEffect((event) => boundSession(binding).pipe(Effect.as(event))),
          Stream.mapError((error) =>
            isNativeSignedOutError(error) || isNativeReadError(error)
              ? error
              : new NativeReadError({ stage: "response" }),
          ),
        );
      }).pipe(
        Effect.mapError((error) =>
          isNativeReadError(error) || isNativeSignedOutError(error)
            ? error
            : new NativeReadError({ stage: "request" }),
        ),
      ),
    ).pipe(
      Stream.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Stream.provideService(HttpClient.TracerDisabledWhen, () => true),
    );
  return GrokBotNativeService.of({
    list,
    listForBinding,
    read,
    accountBinding,
    runtimeRequest,
    receiveAttachments,
    uploadAttachments,
    usageLimits,
    accountInfo,
    readMcp,
    marketplaceRequest,
    templateBlob,
    watchTranscripts,
    computer,
    teachRecording,
    voiceGateway,
    gatewaySkills,
    gatewayRoster,
    gatewayEvents,
  });
});

export const layer = Layer.effect(GrokBotNativeService, make);
