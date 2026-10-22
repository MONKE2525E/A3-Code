import { grokBotUserEchoText } from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import {
  GrokBot,
  GrokBotId,
  GrokBotConversation,
  GrokBotError,
  GrokBotStatus,
  GrokBotCreateInput,
  GrokBotUpdateInput,
  GrokBotSendInput,
  GrokBotLinkInput,
  GrokBotDeleteInput,
  GrokBotDeleteResult,
  GrokBotPullRequest,
  GrokBotMessage,
  GrokBotMessageSender,
  GrokBotParticipant,
  GrokBotRuntimeActivity,
  type PullRequestRef,
} from "@t3tools/contracts";
import { parsePinnedAgentIds } from "./desktopPins.ts";
import { defaultGrokBotAvatarColor, defaultGrokBotAvatarShape } from "./defaultAvatar.ts";
import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GrokBotNativeService from "./GrokBotNativeService.ts";
import { grokBotConnectorCard, grokBotConnectorCardLabel } from "./GrokBotConnectorCard.ts";
import { grokBotWorkflowReferences } from "./GrokBotWorkflowReferences.ts";
import { grokBotVoiceCallMarker, isGrokBotVoiceCallInstruction } from "./GrokBotVoiceCall.ts";
import { waitingWidget } from "./GrokBotWidget.ts";
import { setupFailureDetail } from "./grokBotPlatform.ts";
import * as DateTime from "effect/DateTime";

const Preferences = Schema.Record(
  Schema.String,
  Schema.Struct({
    pinned: Schema.Boolean,
    featured: Schema.Boolean,
    pullRequests: Schema.Array(GrokBotPullRequest),
  }),
);
type Preferences = typeof Preferences.Type;
const DESKTOP_SHAPES: ReadonlySet<string> = new Set([
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
  "square",
  "sparkle",
  "clover",
  "flower",
  "heart",
  "house",
  "star",
]);
const DESKTOP_COLORS: ReadonlySet<string> = new Set([
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
]);
// The shapes `gbot bots create` accepts. Create rejects the rest of the desktop set.
const CLI_CREATE_SHAPES: ReadonlySet<string> = new Set([
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
]);
const RawBot = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["bot", "group"])),
  members: Schema.optionalKey(Schema.Array(GrokBotId)),
  isGroup: Schema.optionalKey(Schema.Boolean),
  memberIds: Schema.optionalKey(Schema.Array(GrokBotId)),
  id: GrokBotId,
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  avatarShape: Schema.optionalKey(Schema.String),
  avatarColor: Schema.optionalKey(Schema.String),
  notifyOnAgentUpdates: Schema.optionalKey(Schema.Boolean),
  hiddenFromSidebar: Schema.optionalKey(Schema.Boolean),
  runtimeActivity: Schema.optionalKey(GrokBotRuntimeActivity),
});
const Transcript = Schema.Struct({
  transcript: Schema.Struct({ entries: Schema.Array(Schema.Unknown) }),
});
const Receipt = Schema.Struct({
  delivery: Schema.String,
  exitCode: Schema.Number,
  messageId: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
});
const RuntimeSettings = Schema.Struct({
  settings: Schema.Struct({
    pinnedAgents: Schema.optionalKey(
      Schema.Struct({ agentIds: Schema.optionalKey(Schema.Array(Schema.String)) }),
    ),
  }),
});
const decodeRuntimeSettings = Schema.decodeUnknownEffect(RuntimeSettings);
const isGrokBotError = Schema.is(GrokBotError);
const nativeProfileError = (
  error: GrokBotNativeService.NativeReadError | GrokBotNativeService.NativeSignedOutError,
  mutation: boolean,
  committed = false,
) =>
  new GrokBotError({
    reason: committed
      ? "profile_save_uncertain"
      : error._tag === "GrokBotNativeSignedOutError" || error.status === 401
        ? "signed_out"
        : error.status === 403
          ? "permission_denied"
          : error.status === 404
            ? "bot_not_found"
            : mutation && error.stage !== "session"
              ? "profile_save_uncertain"
              : "native_unavailable",
  });
const decodePreferences = Schema.decodeEffect(Schema.fromJsonString(Preferences));
const encodePreferences = Schema.encodeEffect(Schema.fromJsonString(Preferences));
const decodeRoster = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(RawBot)));
const decodeTranscript = Schema.decodeEffect(Schema.fromJsonString(Transcript));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(Receipt));
const decodeRawBot = Schema.decodeEffect(Schema.fromJsonString(RawBot));

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** gbot reports failures as `{"error":{...}}` on stderr (stdout when it succeeds with bad output). */
function cliFailureDetail(output: { readonly stdout: string; readonly stderr: string }) {
  const fromJson = (text: string) => {
    try {
      const error = record(record(JSON.parse(text))?.error);
      const issue = Array.isArray(error?.issues) ? record(error.issues[0]) : undefined;
      return [error?.message, issue?.message, error?.code].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
    } catch {
      return undefined;
    }
  };
  const detail =
    fromJson(output.stderr) ??
    fromJson(output.stdout) ??
    output.stderr.trim().split("\n")[0]?.trim();
  return detail ? detail.slice(0, 500) : undefined;
}

type RosterBot = { readonly id: string; readonly name: string };
type Participant = typeof GrokBotParticipant.Type;

/**
 * Bot-to-bot wire entries name the peer by id and by the name it had when it wrote. The roster
 * name wins; an id outside the roster keeps the wire name as an `unknown` label.
 */
function participantFrom(wire: unknown, roster: readonly RosterBot[]): Participant {
  const agent = record(wire);
  const id = typeof agent?.id === "string" ? agent.id : undefined;
  const known = id === undefined ? undefined : roster.find((bot) => bot.id === id);
  if (known !== undefined) return { kind: "bot", id: known.id, name: known.name };
  return {
    kind: "unknown",
    label: typeof agent?.name === "string" && agent.name.length > 0 ? agent.name : "Unknown bot",
  };
}

/**
 * Chat text and reactions belong in chat; tool events remain on Grok's computer.
 * Every message gets one sender here so clients never re-read the wire shape.
 */
export function messagesFrom(
  entries: readonly unknown[],
  self: RosterBot,
  roster: readonly RosterBot[],
) {
  const me: Participant = { kind: "bot", id: self.id, name: self.name };
  const senderOf = (from: unknown): typeof GrokBotMessageSender.Type =>
    from === "user" ? { kind: "user" } : me;
  const positions = new Map(
    entries.flatMap((value, index) => {
      const entry = record(value);
      return typeof entry?.id === "string" ? [[entry.id, index] as const] : [];
    }),
  );
  const messages: {
    -readonly [K in keyof typeof GrokBotMessage.Type]: (typeof GrokBotMessage.Type)[K];
  }[] = [];
  const voiceCallRows = new Set<string>();
  const pending: {
    id: string;
    timestampMs: number;
    reaction: NonNullable<typeof GrokBotMessage.Type.reactions>[number];
  }[] = [];
  for (const value of entries) {
    const entry = record(value);
    if (entry === undefined || typeof entry.id !== "string") continue;
    const message = record(entry.message);
    const timestampMs =
      typeof entry.timestampMs === "number" && Number.isFinite(entry.timestampMs)
        ? entry.timestampMs
        : 0;
    const reactionKind =
      ["reaction", "react", "emoji"].includes(String(entry.kind)) ||
      ["reaction", "react", "emoji"].includes(String(message?.type));
    const reactions = Array.isArray(entry.reactions)
      ? entry.reactions.slice(0, 32)
      : reactionKind
        ? [record(entry.reaction) ?? message ?? entry]
        : [];
    for (const value of reactions) {
      const reaction = record(value);
      const emoji = reaction?.emoji ?? (reactionKind ? reaction?.content : undefined);
      if (typeof emoji !== "string" || emoji.length === 0 || emoji.length > 128) continue;
      const target = reactionKind
        ? (reaction?.messageId ??
          reaction?.entryId ??
          entry.messageId ??
          entry.entryId ??
          entry.targetMessageId ??
          entry.replyToId)
        : entry.id;
      const sender = reaction?.from ?? reaction?.by ?? entry.from ?? entry.by ?? entry.role;
      pending.push({
        id: entry.id,
        timestampMs,
        reaction: {
          emoji,
          from: sender === "me" || sender === "user" ? "user" : "bot",
          messageId: typeof target === "string" ? target : entry.id,
        },
      });
    }
    if (entry.kind === "voice-call") {
      // Native can replay the same call record; the entry id is the identity, so keep the first.
      const marker = grokBotVoiceCallMarker(entry.call);
      if (marker === undefined || voiceCallRows.has(entry.id)) continue;
      voiceCallRows.add(entry.id);
      messages.push({
        id: entry.id,
        role: "assistant",
        sender: me,
        voiceCall: marker,
        text: "",
        timestampMs,
        streaming: false,
      });
      continue;
    }
    const connectorCard = entry.kind === "send-message" ? grokBotConnectorCard(message) : undefined;
    const text =
      connectorCard !== undefined
        ? grokBotConnectorCardLabel(connectorCard)
        : entry.kind === "send-message" && message?.type === "text"
          ? message.content
          : entry.kind === "message"
            ? entry.content
            : undefined;
    if (typeof text !== "string") continue;
    // A peer's message is `role: "user"` on the wire, but it is not the human user's.
    const fromAgent = record(entry.fromAgent)
      ? participantFrom(entry.fromAgent, roster)
      : undefined;
    const toAgent = record(entry.toAgent) ? participantFrom(entry.toAgent, roster) : undefined;
    const sender =
      entry.kind === "send-message"
        ? record(entry.author)
          ? participantFrom(entry.author, roster)
          : me
        : fromAgent !== undefined
          ? fromAgent
          : entry.role === "user"
            ? ({ kind: "user" } as const)
            : me;
    if (sender.kind === "user" && isGrokBotVoiceCallInstruction(entry)) continue;
    const workflowReferences = grokBotWorkflowReferences(entry.richText);
    messages.push({
      id: entry.id,
      ...(workflowReferences.length === 0 ? {} : { grokBotWorkflowReferences: workflowReferences }),
      ...(connectorCard === undefined ? {} : { connectorCard }),
      role:
        fromAgent !== undefined || entry.role === "user"
          ? ("user" as const)
          : ("assistant" as const),
      sender,
      ...(toAgent === undefined ? {} : { addressee: toAgent }),
      text:
        sender.kind === "user" && toAgent === undefined
          ? grokBotUserEchoText(
              text,
              typeof entry.clientNonce === "string" ? entry.clientNonce : undefined,
            )
          : text,
      timestampMs,
      streaming: entry.isStreaming === true,
    });
  }
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const { id, timestampMs, reaction } of pending) {
    const target = byId.get(reaction.messageId);
    if (target !== undefined) {
      const reactions = target.reactions ?? [];
      if (
        !reactions.some(
          (existing) => existing.emoji === reaction.emoji && existing.from === reaction.from,
        )
      ) {
        target.reactions = [...reactions, reaction];
        if (target.reactionOnly) target.text += ` ${reaction.emoji}`;
      }
    } else {
      const standalone = byId.get(id);
      if (standalone !== undefined) {
        standalone.reactions = [...(standalone.reactions ?? []), reaction];
        standalone.text += ` ${reaction.emoji}`;
      } else {
        const turn = {
          id,
          role: reaction.from === "user" ? ("user" as const) : ("assistant" as const),
          sender: senderOf(reaction.from),
          text: reaction.emoji,
          timestampMs,
          streaming: false,
          reactions: [reaction],
          reactionOnly: true,
        };
        messages.push(turn);
        byId.set(id, turn);
      }
    }
  }
  return messages.sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
}

/** Pending cards and explicitly streaming text are observable; historic tools are not live state. */
function transcriptActivity(
  entries: readonly unknown[],
  observedAtMs: number,
): typeof GrokBotRuntimeActivity.Type {
  const pending =
    entries.some((value) => {
      const entry = record(value);
      const message = record(entry?.message);
      const card =
        message?.type === "auto-review-approval"
          ? record(message.approval)
          : message?.type === "local-tool-permission"
            ? record(message.ask)
            : undefined;
      return (
        entry?.kind === "send-message" &&
        card?.status === "pending" &&
        typeof entry.id === "string" &&
        entry.id.length > 0 &&
        entry.id.length <= 1024 &&
        typeof card.requestId === "string" &&
        card.requestId.length > 0 &&
        card.requestId.length <= 1024
      );
    }) || waitingWidget(entries) !== undefined;
  return {
    source: "transcript",
    observedAtMs,
    isComposingMessage: entries.some((value) => {
      const entry = record(value);
      return (
        entry?.isStreaming === true &&
        entry.kind === "send-message" &&
        record(entry.message)?.type === "text"
      );
    }),
    awaitingUserResponse: pending ? { reason: "approval_pending" } : null,
  };
}

function delivered(receipt: typeof Receipt.Type) {
  if (receipt.exitCode !== 0 || ["rejected", "failed"].includes(receipt.delivery)) return false;
  const result = record(receipt.result);
  if (result?.accepted === false || result?.error !== undefined) return false;
  const states = [receipt.delivery, result?.delivery, result?.status, result?.outcome];
  if (states.some((state) => state === "rejected" || state === "failed")) return false;
  return (
    states.some((state) => state === "accepted" || state === "queued" || state === "sent") ||
    result?.accepted === true ||
    (typeof receipt.messageId === "string" && receipt.messageId.length > 0) ||
    (typeof result?.messageId === "string" && result.messageId.length > 0)
  );
}

function linkKey(reference: PullRequestRef): string {
  return [reference.projectId, reference.host ?? "", reference.repository, reference.number].join(
    "\u0000",
  );
}

export class GrokBotService extends Context.Service<
  GrokBotService,
  {
    readonly status: Effect.Effect<typeof GrokBotStatus.Type, GrokBotError>;
    readonly setup: Effect.Effect<typeof GrokBotStatus.Type, GrokBotError>;
    readonly list: Effect.Effect<readonly GrokBot[], GrokBotError>;
    readonly read: (botId: string) => Effect.Effect<typeof GrokBotConversation.Type, GrokBotError>;
    readonly send: (
      input: typeof GrokBotSendInput.Type,
    ) => Effect.Effect<{ readonly accepted: boolean }, GrokBotError>;
    readonly create: (
      input: typeof GrokBotCreateInput.Type,
    ) => Effect.Effect<GrokBot, GrokBotError>;
    readonly update: (
      input: typeof GrokBotUpdateInput.Type,
    ) => Effect.Effect<GrokBot, GrokBotError>;
    readonly link: (input: typeof GrokBotLinkInput.Type) => Effect.Effect<GrokBot, GrokBotError>;
    readonly delete: (
      input: typeof GrokBotDeleteInput.Type,
    ) => Effect.Effect<typeof GrokBotDeleteResult.Type, GrokBotError>;
  }
>()("t3/grokBot/GrokBotService") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const prs = yield* PullRequestService.PullRequestService;
  const native = yield* GrokBotNativeService.GrokBotNativeService;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const platform = yield* HostProcess.Platform;
  const lock = yield* Semaphore.make(1);
  const installLock = yield* Semaphore.make(1);
  const root = path.join(config.baseDir, "integrations", "grokbot");
  const managedCli = path.join(root, "node_modules", "grok-bot-cli", "dist", "bin", "gbot.mjs");
  const preferencesPath = path.join(config.stateDir, "grok-bots.json");
  const appData =
    env.T3CODE_GROK_BOT_APP_DATA_DIR?.trim() ||
    (platform === "win32"
      ? path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Grok Bot")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Grok Bot")
        : path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Grok Bot"));
  const storageError = () => new GrokBotError({ reason: "storage_failed" });
  const invalidResponse = () => new GrokBotError({ reason: "invalid_response" });
  const load = Effect.gen(function* () {
    if (!(yield* fs.exists(preferencesPath))) return {} as Preferences;
    return yield* decodePreferences(yield* fs.readFileString(preferencesPath));
  }).pipe(Effect.mapError(storageError));
  const save = Effect.fn("GrokBotService.save")(function* (preferences: Preferences) {
    yield* fs.makeDirectory(path.dirname(preferencesPath), { recursive: true });
    const temp = `${preferencesPath}.tmp`;
    const encoded = yield* encodePreferences(preferences);
    yield* fs.writeFileString(temp, encoded, { mode: 0o600 });
    yield* fs.rename(temp, preferencesPath);
  }, Effect.mapError(storageError));
  // Best effort: a missing or unreadable desktop app just means nothing is pinned yet.
  const readDesktopPinned = Effect.gen(function* () {
    const directory = path.join(appData, "sand-client-persistence");
    for (const name of yield* fs.readDirectory(directory)) {
      const bytes = yield* fs.readFile(path.join(directory, name));
      const ids = parsePinnedAgentIds(new TextDecoder("latin1").decode(bytes));
      if (ids.length > 0) return new Set(ids);
    }
    return new Set<string>();
  }).pipe(Effect.orElseSucceed(() => new Set<string>()));
  const readNativePinned = (binding: string) =>
    native.runtimeRequest(binding, "GetGrokBotUserRuntimeSettings", {}).pipe(
      Effect.flatMap((response) =>
        decodeRuntimeSettings(response).pipe(
          Effect.mapError(() => new GrokBotNativeService.NativeReadError({ stage: "response" })),
        ),
      ),
      Effect.map((response) => new Set(response.settings.pinnedAgents?.agentIds ?? [])),
    );
  const readPinned = native.accountBinding.pipe(
    Effect.flatMap(readNativePinned),
    Effect.map((ids) => ({ ids, authoritative: true })),
    Effect.catch(() =>
      readDesktopPinned.pipe(Effect.map((ids) => ({ ids, authoritative: false }))),
    ),
  );
  const invocation = Effect.gen(function* () {
    return (yield* fs.exists(managedCli))
      ? {
          command: isExecutable ? "node" : executable,
          prefix: [managedCli],
          env: { ...env, ELECTRON_RUN_AS_NODE: "1", CODEX_THREAD_ID: "" },
        }
      : { command: "gbot", prefix: [] as string[], env: { ...env, CODEX_THREAD_ID: "" } };
  }).pipe(Effect.mapError(() => new GrokBotError({ reason: "cli_unavailable" })));
  const statusCache = yield* Cache.makeWith(
    () =>
      Effect.gen(function* () {
        const managed = yield* fs.exists(managedCli);
        const sessionPresent = yield* fs.exists(path.join(appData, "gateway-descriptor.json"));
        const command = yield* invocation;
        const installed = yield* runner
          .run({
            ...command,
            args: [...command.prefix, "--version"],
            timeout: "5 seconds",
            maxOutputBytes: 4096,
          })
          .pipe(
            Effect.map((result) => result.code === 0),
            Effect.orElseSucceed(() => false),
          );
        // The desktop app's own sign-in is enough for every native read and managed turn; the CLI
        // is only needed for the gateway-only paths, so readiness reports both.
        const nativeAvailable = yield* native.accountBinding.pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        return { installed, managed, sessionPresent, nativeAvailable };
      }).pipe(Effect.mapError(() => new GrokBotError({ reason: "cli_unavailable" }))),
    {
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && (exit.value.installed || exit.value.nativeAvailable)
          ? "30 seconds"
          : "5 seconds",
    },
  );
  const status = Cache.get(statusCache, undefined);
  const cli = Effect.fn("GrokBotService.cli")(
    function* (args: readonly string[], sending = false) {
      if (!(yield* fs.exists(path.join(appData, "gateway-descriptor.json"))))
        return yield* new GrokBotError({ reason: "signed_out" });
      const command = yield* invocation;
      const result = yield* runner
        .run({
          command: command.command,
          env: command.env,
          args: [...command.prefix, ...args],
          timeout: "45 seconds",
          maxOutputBytes: 2 * 1024 * 1024,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new GrokBotError({
                reason:
                  error._tag === "ProcessSpawnError"
                    ? "cli_unavailable"
                    : sending
                      ? "delivery_unknown"
                      : "gateway_failed",
              }),
          ),
        );
      if (result.code !== 0) {
        if (sending) return yield* new GrokBotError({ reason: "delivery_unknown" });
        const detail = cliFailureDetail(result);
        yield* Effect.logWarning("Grok Bot CLI call failed", {
          command: args.slice(0, 2).join(" "),
          exitCode: result.code,
          detail,
        });
        return yield* new GrokBotError({
          reason: "gateway_failed",
          ...(detail === undefined ? {} : { detail }),
        });
      }
      return result.stdout;
    },
    Effect.mapError((error) =>
      isGrokBotError(error) ? error : new GrokBotError({ reason: "gateway_failed" }),
    ),
  );
  const rawList = native.list.pipe(
    Effect.catchTags({
      GrokBotNativeSignedOutError: () => Effect.fail(new GrokBotError({ reason: "signed_out" })),
      GrokBotNativeReadError: () =>
        Effect.all(
          ["bots", "groups"].map((kind) =>
            cli([kind, "list", "--gateway", "--json"]).pipe(
              Effect.flatMap((text) => decodeRoster(text).pipe(Effect.mapError(invalidResponse))),
              // A missing legacy descriptor after a native read failure is a connection failure,
              // not proof that the user's native account signed out.
              Effect.mapError((error) =>
                error.reason === "signed_out"
                  ? new GrokBotError({ reason: "gateway_failed" })
                  : error,
              ),
            ),
          ),
          { concurrency: 2 },
        ).pipe(
          Effect.map((lists) => [...new Map(lists.flat().map((bot) => [bot.id, bot])).values()]),
        ),
    }),
  );
  const decorate = (
    bot: typeof RawBot.Type,
    preferences: Preferences,
    desktopPinned: ReadonlySet<string>,
  ): GrokBot => ({
    id: bot.id,
    isGroup: bot.isGroup ?? bot.kind === "group",
    memberIds: bot.memberIds ?? bot.members ?? [],
    name: bot.name,
    label: bot.title ?? "",
    description: bot.description ?? "",
    avatarShape: bot.avatarShape ?? defaultGrokBotAvatarShape(bot.id),
    avatarColor: bot.avatarColor ?? defaultGrokBotAvatarColor(bot.id),
    notificationEnabled: bot.notifyOnAgentUpdates ?? true,
    hidden: bot.hiddenFromSidebar ?? false,
    pinned: preferences[bot.id]?.pinned ?? desktopPinned.has(bot.id),
    featured: preferences[bot.id]?.featured ?? false,
    pullRequests: preferences[bot.id]?.pullRequests ?? [],
    ...(bot.runtimeActivity === undefined ? {} : { runtimeActivity: bot.runtimeActivity }),
  });
  // Preserve failed host reads. Only a confirmed merge removes a link, never the remote bot.
  const reconcile = lock.withPermits(1)(
    Effect.gen(function* () {
      const preferences = { ...(yield* load) };
      let changed = false;
      for (const [id, preference] of Object.entries(preferences)) {
        const links = yield* Effect.forEach(
          preference.pullRequests,
          (link) =>
            prs.summary({ ...link.reference, allowStale: false }).pipe(
              Effect.map((summary) =>
                summary.state === "merged"
                  ? null
                  : {
                      ...link,
                      title: summary.title,
                      url: summary.url,
                      state: summary.state,
                    },
              ),
              Effect.orElseSucceed(() => link),
            ),
          { concurrency: 4 },
        );
        const remaining = links.filter((link) => link !== null);
        if (
          remaining.length !== preference.pullRequests.length ||
          remaining.some((link, index) => {
            const previous = preference.pullRequests[index];
            return (
              previous?.title !== link.title ||
              previous.url !== link.url ||
              previous.state !== link.state
            );
          })
        ) {
          preferences[id] = { ...preference, pullRequests: remaining };
          changed = true;
        }
      }
      if (changed) yield* save(preferences);
      return preferences;
    }),
  );
  const listCache = yield* Cache.makeWith(
    () =>
      Effect.gen(function* () {
        const bots = yield* rawList;
        const preferences = yield* reconcile;
        const pinned = yield* readPinned;
        return bots.map((bot) => ({
          ...decorate(bot, preferences, pinned.ids),
          ...(pinned.authoritative ? { pinned: pinned.ids.has(bot.id) } : {}),
        }));
      }),
    { capacity: 1, timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 seconds" : 0) },
  );
  const list = Cache.get(listCache, undefined);
  const find = (botId: string) =>
    list.pipe(
      Effect.flatMap((bots) => {
        const bot = bots.find((candidate) => candidate.id === botId);
        return bot === undefined
          ? Effect.fail(new GrokBotError({ reason: "bot_not_found" }))
          : Effect.succeed(bot);
      }),
    );
  const readTail = (
    botId: string,
  ): Effect.Effect<
    {
      readonly entries: readonly unknown[];
      readonly runtimeActivity?: typeof GrokBotRuntimeActivity.Type;
    },
    GrokBotError
  > =>
    native.read(botId).pipe(
      Effect.catchTags({
        GrokBotNativeSignedOutError: () => Effect.fail(new GrokBotError({ reason: "signed_out" })),
        GrokBotNativeReadError: () =>
          cli([
            "thread",
            "--gateway",
            "--json",
            "--no-history",
            "--limit",
            "200",
            "--",
            botId,
          ]).pipe(
            Effect.flatMap((text) => decodeTranscript(text).pipe(Effect.mapError(invalidResponse))),
            Effect.mapError((error) =>
              error.reason === "signed_out"
                ? new GrokBotError({ reason: "gateway_failed" })
                : error,
            ),
            Effect.map((result) => ({
              entries: result.transcript.entries,
            })),
          ),
      }),
    );
  const conversationCache = yield* Cache.makeWith(
    (botId: string) =>
      Effect.gen(function* () {
        const [bot, tail, bots] = yield* Effect.all([find(botId), readTail(botId), list], {
          concurrency: 2,
        });
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        return {
          bot,
          messages: messagesFrom(tail.entries, bot, bots),
          runtimeActivity: tail.runtimeActivity ?? transcriptActivity(tail.entries, now),
        };
      }),
    { capacity: 64, timeToLive: (exit) => (Exit.isSuccess(exit) ? "250 millis" : 0) },
  );
  const read = (botId: string) => Cache.get(conversationCache, botId);
  const invalidate = (botId: string) =>
    Effect.all([Cache.invalidateAll(listCache), Cache.invalidate(conversationCache, botId)], {
      discard: true,
    });
  const send = Effect.fn("GrokBotService.send")(
    function* (input: typeof GrokBotSendInput.Type) {
      // The CLI resolves the bot itself; PR reconciliation is unrelated to sending.
      const text = yield* cli(
        [
          "send",
          "--gateway",
          "--json",
          "--no-history",
          "--reply-mode",
          "manual",
          "--",
          input.botId,
          input.message,
        ],
        true,
      );
      const receipt = yield* decodeReceipt(text).pipe(
        Effect.mapError(() => new GrokBotError({ reason: "delivery_unknown" })),
      );
      if (!delivered(receipt)) return yield* new GrokBotError({ reason: "delivery_unknown" });
      return { accepted: true };
    },
    (self, input) => Effect.ensuring(invalidate(input.botId))(self),
  );
  // Creation goes through the gateway CLI because the desktop profile API has no create method.
  const create = Effect.fn("GrokBotService.create")(
    function* (input: typeof GrokBotCreateInput.Type) {
      if (
        (input.avatarShape !== undefined && !CLI_CREATE_SHAPES.has(input.avatarShape)) ||
        (input.avatarColor !== undefined && !DESKTOP_COLORS.has(input.avatarColor))
      )
        return yield* new GrokBotError({ reason: "invalid_avatar" });
      const text = yield* cli([
        input.memberIds === undefined ? "bots" : "groups",
        "create",
        "--gateway",
        "--json",
        `--name=${input.name}`,
        ...(input.memberIds?.map((id) => `--member=${id}`) ?? []),
        ...(input.description ? [`--description=${input.description}`] : []),
        ...(input.avatarShape === undefined ? [] : [`--avatar-shape=${input.avatarShape}`]),
        ...(input.avatarColor === undefined ? [] : [`--avatar-color=${input.avatarColor}`]),
      ]);
      const created = yield* decodeRawBot(text).pipe(
        Effect.mapError((): GrokBotError => {
          const detail = cliFailureDetail({ stdout: text, stderr: "" });
          return new GrokBotError({
            reason: "invalid_response",
            ...(detail === undefined ? {} : { detail }),
          });
        }),
      );
      const preferences = yield* load;
      const pinned = yield* readPinned;
      return {
        ...decorate(created, preferences, pinned.ids),
        ...(pinned.authoritative ? { pinned: pinned.ids.has(created.id) } : {}),
      };
    },
    Effect.ensuring(Cache.invalidateAll(listCache)),
  );
  const update = Effect.fn("GrokBotService.update")(
    function* (input: typeof GrokBotUpdateInput.Type) {
      if (
        (input.avatarShape !== undefined && !DESKTOP_SHAPES.has(input.avatarShape)) ||
        (input.avatarColor !== undefined && !DESKTOP_COLORS.has(input.avatarColor))
      )
        return yield* new GrokBotError({ reason: "invalid_avatar" });
      const hasAppearance = input.avatarShape !== undefined || input.avatarColor !== undefined;
      const profile = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.label === undefined ? {} : { title: input.label }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.avatarShape === undefined ? {} : { avatarShape: input.avatarShape }),
        ...(input.avatarColor === undefined ? {} : { avatarColor: input.avatarColor }),
        // Selecting a character replaces a native avatar photo, as the desktop editor does.
        ...(hasAppearance ? { clearAvatar: {} } : {}),
      };
      const clientState = {
        ...(input.notificationEnabled === undefined
          ? {}
          : { notifyOnUpdatesEnabled: input.notificationEnabled }),
        ...(input.hidden === undefined ? {} : { hiddenFromSidebar: input.hidden }),
      };
      const hasProfile = Object.keys(profile).length > 0;
      const hasClientState = Object.keys(clientState).length > 0;
      const hasNativeChanges = hasProfile || hasClientState || input.pinned !== undefined;
      const binding = hasNativeChanges
        ? yield* native.accountBinding.pipe(
            Effect.mapError((error) => nativeProfileError(error, false)),
          )
        : undefined;
      if (binding !== undefined) {
        const nativeBot = (yield* native
          .listForBinding(binding)
          .pipe(Effect.mapError((error) => nativeProfileError(error, false)))).find(
          (agent) => agent.id === input.botId,
        );
        if (nativeBot === undefined) return yield* new GrokBotError({ reason: "bot_not_found" });
        let committed = false;
        // Desktop profiles use partialUpdate so omitted fields remain intact.
        // Once a mutation is attempted, a lost response must not retry via CLI.
        if (hasProfile) {
          const profileId = nativeBot.nativeProfileId;
          if (!profileId) return yield* new GrokBotError({ reason: "native_unavailable" });
          yield* native
            .runtimeRequest(binding, "UpdateGrokBotAgent", {
              id: profileId,
              partialUpdate: true,
              ...profile,
            })
            .pipe(Effect.mapError((error) => nativeProfileError(error, true)));
          committed = true;
        }
        if (hasClientState)
          yield* native
            .runtimeRequest(binding, "SetGrokBotAgentClientState", {
              agentId: input.botId,
              ...clientState,
            })
            .pipe(Effect.mapError((error) => nativeProfileError(error, true, committed)));
        if (input.pinned !== undefined)
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const ids = yield* readNativePinned(binding).pipe(
                Effect.mapError((error) => nativeProfileError(error, false, committed)),
              );
              if (input.pinned) ids.add(input.botId);
              else ids.delete(input.botId);
              yield* native
                .runtimeRequest(binding, "UpdateGrokBotUserRuntimeSettings", {
                  pinnedAgents: { agentIds: [...ids] },
                })
                .pipe(Effect.mapError((error) => nativeProfileError(error, true, committed)));
              const saved = yield* readNativePinned(binding).pipe(
                Effect.mapError((error) => nativeProfileError(error, false, true)),
              );
              if (saved.has(input.botId) !== input.pinned)
                return yield* new GrokBotError({ reason: "profile_save_uncertain" });
            }),
          );
      } else yield* find(input.botId);
      if (input.pinned !== undefined || input.featured !== undefined)
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const preferences = { ...(yield* load) };
            const current = preferences[input.botId] ?? {
              pinned: (yield* readDesktopPinned).has(input.botId),
              featured: false,
              pullRequests: [],
            };
            preferences[input.botId] = {
              ...current,
              pinned: input.pinned ?? current.pinned,
              featured: input.featured ?? current.featured,
            };
            yield* save(preferences);
          }),
        );
      yield* invalidate(input.botId);
      if (binding !== undefined) {
        // Confirm once through the native roster; a stale CLI fallback can undo the visible save.
        if (
          (yield* native.accountBinding.pipe(
            Effect.mapError((error) => nativeProfileError(error, false, true)),
          )) !== binding
        )
          return yield* new GrokBotError({ reason: "profile_save_uncertain" });
        const saved = (yield* native
          .listForBinding(binding)
          .pipe(Effect.mapError((error) => nativeProfileError(error, false, true)))).find(
          (agent) => agent.id === input.botId,
        );
        if (
          (yield* native.accountBinding.pipe(
            Effect.mapError((error) => nativeProfileError(error, false, true)),
          )) !== binding ||
          saved === undefined ||
          (input.name !== undefined && saved.name !== input.name) ||
          (input.label !== undefined && (saved.title ?? "") !== input.label) ||
          (input.description !== undefined && (saved.description ?? "") !== input.description) ||
          (input.avatarShape !== undefined && saved.avatarShape !== input.avatarShape) ||
          (input.avatarColor !== undefined && saved.avatarColor !== input.avatarColor) ||
          (hasAppearance && saved.hasAvatarPhoto === true) ||
          (input.notificationEnabled !== undefined &&
            saved.notifyOnAgentUpdates !== input.notificationEnabled) ||
          (input.hidden !== undefined && saved.hiddenFromSidebar !== input.hidden)
        )
          return yield* new GrokBotError({ reason: "profile_save_uncertain" });
        const preferences = yield* load;
        const pinned = yield* readPinned;
        return {
          ...decorate(saved, preferences, pinned.ids),
          ...(pinned.authoritative ? { pinned: pinned.ids.has(saved.id) } : {}),
        };
      }
      return yield* find(input.botId);
    },
    (self, input) => Effect.ensuring(invalidate(input.botId))(self),
  );
  const link = Effect.fn("GrokBotService.link")(function* (input: typeof GrokBotLinkInput.Type) {
    yield* find(input.botId);
    const summary = input.remove
      ? undefined
      : yield* prs
          .summary({ ...input.reference, allowStale: false })
          .pipe(Effect.mapError(() => new GrokBotError({ reason: "pr_failed" })));
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const preferences = { ...(yield* load) };
        const current = preferences[input.botId] ?? {
          pinned: (yield* readDesktopPinned).has(input.botId),
          featured: false,
          pullRequests: [],
        };
        const links = current.pullRequests.filter(
          (entry) => linkKey(entry.reference) !== linkKey(input.reference),
        );
        if (summary !== undefined && summary.state !== "merged")
          links.push({
            reference: input.reference,
            url: summary.url,
            title: summary.title,
            state: summary.state,
          });
        preferences[input.botId] = { ...current, pullRequests: links };
        yield* save(preferences);
      }),
    );
    yield* invalidate(input.botId);
    return yield* find(input.botId);
  });
  // A sent delete may commit even when its response is lost, so the roster is re-read to decide.
  // The mutation is never retried through the CLI once it has been attempted.
  const remove = Effect.fn("GrokBotService.remove")(
    function* (input: typeof GrokBotDeleteInput.Type) {
      const current = yield* find(input.botId);
      if (current.runtimeActivity?.isRunning === true)
        return yield* new GrokBotError({ reason: "delete_running" });
      const binding = yield* native.accountBinding.pipe(
        Effect.map((value): string | undefined => value),
        Effect.catchTags({
          GrokBotNativeReadError: () => Effect.succeed(undefined),
          GrokBotNativeSignedOutError: () =>
            Effect.fail(new GrokBotError({ reason: "signed_out" })),
        }),
      );
      if (binding === undefined) {
        yield* cli([
          current.isGroup ? "groups" : "bots",
          "delete",
          "--gateway",
          "--json",
          "--",
          input.botId,
        ]).pipe(Effect.ignore);
      } else {
        const nativeBot = (yield* native
          .listForBinding(binding)
          .pipe(Effect.mapError((error) => nativeProfileError(error, false)))).find(
          (agent) => agent.id === input.botId,
        );
        if (nativeBot === undefined) return yield* new GrokBotError({ reason: "bot_not_found" });
        const profileId = nativeBot.nativeProfileId;
        if (!profileId) return yield* new GrokBotError({ reason: "native_unavailable" });
        yield* native
          .runtimeRequest(binding, "DeleteGrokBotAgent", { id: profileId })
          .pipe(Effect.ignore);
      }
      // Verify through an uncached read; the list cache may still show the bot.
      const uncertain = () => new GrokBotError({ reason: "delete_uncertain" });
      const remaining =
        binding === undefined
          ? yield* rawList.pipe(Effect.mapError(uncertain))
          : yield* native.listForBinding(binding).pipe(Effect.mapError(uncertain));
      if (remaining.some((bot) => bot.id === input.botId))
        return yield* new GrokBotError({ reason: "delete_uncertain" });
      // Pins and PR links are T3-side preferences for this bot, so they go with it. The PRs stay as they are.
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const preferences = yield* load;
          yield* save(
            Object.fromEntries(Object.entries(preferences).filter(([id]) => id !== input.botId)),
          );
        }),
      );
      return { botId: input.botId };
    },
    (self, input) => Effect.ensuring(invalidate(input.botId))(self),
  );
  const setup = installLock.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidateAll(statusCache);
      if (yield* fs.exists(managedCli)) return yield* status;
      const result = yield* runner
        .run({
          command: "npm",
          args: [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--prefix",
            root,
            "grok-bot-cli@0.12.4",
          ],
          timeout: "120 seconds",
          maxOutputBytes: 65536,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new GrokBotError({
                reason: "setup_failed",
                detail: setupFailureDetail(
                  platform,
                  error._tag === "ProcessSpawnError"
                    ? { kind: "npm_missing" }
                    : error._tag === "ProcessTimeoutError"
                      ? { kind: "timeout" }
                      : { kind: "install_failed", code: -1 },
                ),
              }),
          ),
        );
      if (result.code !== 0)
        return yield* new GrokBotError({
          reason: "setup_failed",
          detail: setupFailureDetail(platform, { kind: "install_failed", code: result.code ?? -1 }),
        });
      const ready = yield* status;
      // A zero exit without the CLI file means the install did not land where it is read.
      if (!ready.managed)
        return yield* new GrokBotError({
          reason: "setup_failed",
          detail: setupFailureDetail(platform, { kind: "unreadable" }),
        });
      return ready;
    }).pipe(
      Effect.mapError((error) =>
        isGrokBotError(error) ? error : new GrokBotError({ reason: "setup_failed" }),
      ),
    ),
  );
  return GrokBotService.of({
    status,
    setup,
    list,
    read,
    send,
    create,
    update,
    link,
    delete: remove,
  });
});

export const layer = Layer.effect(GrokBotService, make);
