import { GrokBotId, GrokBotSetupStatus, GrokBotSetupVerificationInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as Endpoint from "../cloud/ManagedEndpointAddress.ts";
import { resolveHostCliCommand } from "../cli/invocation.ts";
import * as Binding from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import * as Native from "./GrokBotNativeService.ts";
import * as Runtime from "./GrokBotNativeRuntimeService.ts";
import * as Bots from "./GrokBotService.ts";

const Settings = Schema.Struct({
  settings: Schema.Struct({ mainAgentId: Schema.optionalKey(Schema.String) }),
});
const Roster = Schema.Struct({
  agents: Schema.optionalKey(
    Schema.Array(Schema.Struct({ agentId: GrokBotId, name: Schema.String })),
  ),
});
const Saved = Schema.Struct({
  binding: Schema.String,
  endpoint: Schema.String,
  skillHash: Schema.String,
  nonce: Schema.String,
  startedAtMs: Schema.Number,
  status: GrokBotSetupStatus,
});
const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(Saved));
const encodeSaved = Schema.encodeEffect(Schema.fromJsonString(Saved));
const decodeSettings = Schema.decodeUnknownEffect(Settings);
const decodeRoster = Schema.decodeUnknownEffect(Roster);
const decodeConnectors = Schema.decodeUnknownEffect(
  Schema.Struct({
    servers: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
          url: Schema.optionalKey(Schema.String),
          userHasAccessToken: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    ),
  }),
);
const SETUP_TIMEOUT_MS = 15 * 60_000;

/** Only accept a same-environment authorization link after this setup's native user-message echo. */
export function grokBotSetupAuthorizationUrl(
  messages: readonly { readonly role: "user" | "assistant"; readonly text: string }[],
  nonce: string,
  mcpUrl: string,
): string | null {
  const echo = messages.findIndex(
    (message) => message.role === "user" && message.text.includes(nonce),
  );
  if (echo < 0) return null;
  const origin = new URL(mcpUrl).origin;
  const urls = messages
    .slice(echo + 1)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.text.match(/https?:\/\/[^\s<>"']+/g) ?? []);
  return (
    urls
      .map((url) => url.replace(/[),.;]+$/, ""))
      .find((url) => {
        try {
          const parsed = new URL(url);
          return (
            parsed.origin === origin &&
            parsed.pathname === "/oauth/mcp/authorize" &&
            !parsed.username &&
            !parsed.password
          );
        } catch {
          return false;
        }
      }) ?? null
  );
}

export class GrokBotSetupError extends Schema.TaggedError<GrokBotSetupError>()(
  "GrokBotSetupError",
  {
    stage: Schema.Literals(["read", "write", "account", "verification"]),
  },
) {
  override get message() {
    return "GrokBot setup could not be verified. Check the connection and try again.";
  }
}

/** Setup uses native delivery; its proof must arrive through the ordinary OAuth MCP connection. */
export class GrokBotSetupService extends Context.Service<
  GrokBotSetupService,
  {
    readonly status: Effect.Effect<GrokBotSetupStatus, GrokBotSetupError>;
    readonly send: Effect.Effect<GrokBotSetupStatus, GrokBotSetupError>;
    readonly verify: (
      input: typeof GrokBotSetupVerificationInput.Type,
    ) => Effect.Effect<{ verified: true }, GrokBotSetupError>;
  }
>()("t3/grokBot/GrokBotSetupService") {}

const make = Effect.gen(function* () {
  const native = yield* Native.GrokBotNativeService;
  const runtime = yield* Runtime.GrokBotNativeRuntimeService;
  const bots = yield* Bots.GrokBotService;
  const endpoint = yield* Endpoint.ManagedEndpointAddress;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  const scope = yield* Effect.scope;
  const accountBinding = native.accountBinding.pipe(
    Effect.mapError(() => new GrokBotSetupError({ stage: "account" })),
  );
  const lock = yield* Semaphore.make(1);
  const statePath = path.join(config.stateDir, "grokbot-setup.json");
  const skillHash = Buffer.from(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(Binding.GROK_BOT_MANAGED_SKILL_BODY)),
  ).toString("hex");
  const quote = (value: string) =>
    platform === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const pairingArgs = `auth pairing create --base-dir ${quote(config.baseDir)} --ttl 5m --label ${quote("GrokBot MCP setup")}`;
  const hostCommand = yield* resolveHostCliCommand(
    pairingArgs,
    platform === "win32" ? "powershell" : "posix",
  );
  const terminalCommand =
    config.stateDir !== path.join(config.baseDir, "userdata")
      ? null
      : platform === "win32" && hostCommand.launcher
        ? `& ${hostCommand.command}`
        : hostCommand.command;
  const read = fs.readFileString(statePath).pipe(
    Effect.flatMap(decodeSaved),
    Effect.map((saved) => ({ ...saved })),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(new GrokBotSetupError({ stage: "read" })),
    }),
    Effect.catchTags({ SchemaError: () => Effect.succeed(null) }),
    Effect.mapError(() => new GrokBotSetupError({ stage: "read" })),
  );
  const write = (value: typeof Saved.Type) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(statePath + ".tmp", yield* encodeSaved(value), { mode: 0o600 });
      yield* fs.rename(statePath + ".tmp", statePath);
    }).pipe(Effect.mapError(() => new GrokBotSetupError({ stage: "write" })));
  const current = Effect.gen(function* () {
    const binding = yield* accountBinding;
    const raw = yield* native.runtimeRequest(binding, "GetGrokBotUserRuntimeSettings", {});
    const settings = yield* decodeSettings(raw);
    const roster = yield* native
      .runtimeRequest(binding, "ListGrokBotAgents", {})
      .pipe(Effect.flatMap(decodeRoster));
    const bot =
      roster.agents?.find((item) => item.agentId === settings.settings.mainAgentId) ?? null;
    if ((yield* accountBinding) !== binding)
      return yield* new GrokBotSetupError({ stage: "account" });
    const published = yield* endpoint.read;
    return {
      binding,
      bot: bot ? { id: bot.agentId, name: bot.name } : null,
      hasPrimary: Boolean(settings.settings.mainAgentId),
      mcpUrl: published ? new URL("/mcp", published.httpBaseUrl).href : null,
    };
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "GrokBotSetupError" ? error : new GrokBotSetupError({ stage: "read" }),
    ),
  );
  const empty = (
    value: typeof current extends Effect.Effect<infer A, infer _E, infer _R> ? A : never,
    now: number,
  ): GrokBotSetupStatus => ({
    phase:
      !value.bot && !value.hasPrimary
        ? "needs_primary"
        : !value.bot || !value.mcpUrl
          ? "needs_prerequisite"
          : "needs_setup",
    complete: false,
    primaryBot: value.bot,
    mcpUrl: value.mcpUrl,
    terminalCommand: value.mcpUrl ? terminalCommand : null,
    authorizationUrl: null,
    error:
      !value.bot && value.hasPrimary
        ? "Your starred primary bot was not found in the bot list. Refresh the list in GrokBot, then check again."
        : !value.bot
          ? "Choose a primary bot in GrokBot first."
          : !value.mcpUrl
            ? "Enable T3 Connect for this environment, then check again."
            : null,
    updatedAtMs: now,
  });
  const matches = (
    saved: typeof Saved.Type,
    value: { binding: string; mcpUrl: string | null; bot: { id: string } | null },
  ) =>
    saved.binding === value.binding &&
    saved.endpoint === value.mcpUrl &&
    saved.skillHash === skillHash &&
    saved.status.primaryBot?.id === value.bot?.id;
  const status = Effect.gen(function* () {
    const value = yield* current;
    const snapshot = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* accountBinding) !== value.binding)
          return yield* new GrokBotSetupError({ stage: "account" });
        const now = yield* Clock.currentTimeMillis;
        const saved = yield* read;
        if (!saved || !matches(saved, value)) return { saved: null, view: empty(value, now) };
        if (
          !saved.status.complete &&
          ["sending", "awaiting_authorization", "verifying"].includes(saved.status.phase) &&
          now - saved.startedAtMs >= SETUP_TIMEOUT_MS
        ) {
          saved.status = {
            ...saved.status,
            phase: "stalled",
            error:
              "Setup did not finish within 15 minutes. Check the primary bot's chat, then retry setup.",
            updatedAtMs: now,
          };
          yield* write(saved);
        }
        return { saved, view: { ...saved.status, terminalCommand } };
      }),
    );
    const saved = snapshot.saved;
    if (
      !saved ||
      saved.status.complete ||
      !["awaiting_authorization", "verifying"].includes(saved.status.phase)
    )
      return snapshot.view;
    // Native history can be slow. Never hold the verification lock while reading it.
    const conversation = yield* bots.read(saved.status.primaryBot!.id).pipe(Effect.option);
    const authorizationUrl =
      conversation._tag === "Some"
        ? grokBotSetupAuthorizationUrl(conversation.value.messages, saved.nonce, saved.endpoint)
        : null;
    if (!authorizationUrl) {
      const connectors = yield* native
        .readMcp(value.binding, { method: "GetAvailableMcpServers", input: {} })
        .pipe(Effect.flatMap(decodeConnectors), Effect.option);
      if ((yield* accountBinding) !== value.binding)
        return yield* new GrokBotSetupError({ stage: "account" });
      const connector =
        connectors._tag === "Some"
          ? connectors.value.servers?.find(
              (server) => server.url === saved.endpoint && server.userHasAccessToken !== true,
            )
          : undefined;
      return connector
        ? {
            ...snapshot.view,
            phase: "awaiting_authorization" as const,
            connectorServerId: connector.id,
          }
        : snapshot.view;
    }
    if (authorizationUrl === saved.status.authorizationUrl) return snapshot.view;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const latest = yield* read;
        if (!latest || latest.nonce !== saved.nonce) return snapshot.view;
        if (!latest.status.complete) {
          latest.status = {
            ...latest.status,
            authorizationUrl,
            phase: "awaiting_authorization",
            updatedAtMs: yield* Clock.currentTimeMillis,
          };
          yield* write(latest);
        }
        return { ...latest.status, terminalCommand };
      }),
    );
  });
  const send = Effect.gen(function* () {
    const value = yield* current;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* accountBinding) !== value.binding)
          return yield* new GrokBotSetupError({ stage: "account" });
        const now = yield* Clock.currentTimeMillis;
        if (!value.bot || !value.mcpUrl) return empty(value, now);
        const previous = yield* read;
        if (
          previous &&
          matches(previous, value) &&
          (previous.status.complete ||
            (now - previous.startedAtMs < SETUP_TIMEOUT_MS &&
              ["sending", "awaiting_authorization", "verifying"].includes(previous.status.phase)))
        )
          return previous.status;
        const nonce = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
        const saved: typeof Saved.Type = {
          binding: value.binding,
          endpoint: value.mcpUrl,
          skillHash,
          nonce,
          startedAtMs: now,
          status: { ...empty(value, now), phase: "sending", error: null },
        };
        yield* write(saved);
        const prompt = [
          Binding.grokBotSkillSetupPrompt(skillHash),
          "This is an explicit one-time setup request for the ordinary, account-wide T3 Code MCP connector, separate from the temporary t3-code-managed connection.",
          `Connect the account's shared HTTP MCP connector to exactly ${value.mcpUrl}. Give it a name that identifies this environment (${new URL(value.mcpUrl).hostname}). Reuse a connector only if its URL matches exactly. Do not replace another T3 environment's connector. Do not name it t3-code-managed.`,
          "Use your native connector management and OAuth tools. If authorization is required, send me the OAuth link in this chat and wait for me to approve it. Do not run commands on my computer to approve your own access.",
          terminalCommand
            ? "If the T3 OAuth page asks for a pairing code, tell me to use the command shown in T3 provider setup on the hosting computer. Never approve your own connection or ask me to paste the code into this chat."
            : "If the T3 OAuth page asks for a pairing code, tell me to create a pairing link in this environment's Settings → Connections and enter its code on the authorization page. No terminal command is available for this environment; do not invent one. Never approve your own connection or ask me to paste the code into this chat.",
          `After saving and reading back the account-shared skill and authorizing this connector, discover grok_bot_verify_setup on this ordinary T3 connector and call it with nonce ${nonce} and managedSkillHash ${skillHash}. This call is the setup test. Use the hash from the installed skill's description, and do not report success if the skill or MCP call fails. Do not use any temporary injected MCP connection for this test.`,
          "Reply in this normal conversation with what completed or the exact step needing my help. Leave other skills, bots, connectors, and sharing unchanged.",
        ].join("\n\n");
        yield* Effect.gen(function* () {
          yield* runtime.startTurn({
            binding: value.binding,
            botId: value.bot!.id,
            sessionId: "",
            messageId: `t3-setup-${nonce}`,
            sentAtMs: now,
            text: prompt,
          });
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const latest = yield* read;
              if (latest?.nonce !== nonce || latest.status.complete) return;
              latest.status = {
                ...latest.status,
                phase: "verifying",
                updatedAtMs: yield* Clock.currentTimeMillis,
              };
              yield* write(latest);
            }),
          );
        }).pipe(
          Effect.catch(() =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                const latest = yield* read;
                if (latest?.nonce !== nonce || latest.status.complete) return;
                latest.status = {
                  ...latest.status,
                  phase: "failed",
                  error:
                    "The setup message could not be confirmed. Check the primary bot's chat before retrying.",
                  updatedAtMs: yield* Clock.currentTimeMillis,
                };
                yield* write(latest);
              }),
            ),
          ),
          Effect.forkIn(scope),
        );
        return saved.status;
      }),
    );
  });
  const verify = (input: typeof GrokBotSetupVerificationInput.Type) =>
    Effect.gen(function* () {
      const value = yield* current;
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* accountBinding) !== value.binding)
            return yield* new GrokBotSetupError({ stage: "account" });
          const saved = yield* read;
          const now = yield* Clock.currentTimeMillis;
          if (
            !saved ||
            !matches(saved, value) ||
            saved.nonce !== input.nonce ||
            saved.skillHash !== input.managedSkillHash ||
            (!saved.status.complete && now - saved.startedAtMs >= SETUP_TIMEOUT_MS)
          )
            return yield* new GrokBotSetupError({ stage: "verification" });
          saved.status = {
            ...saved.status,
            phase: "complete",
            complete: true,
            authorizationUrl: null,
            error: null,
            updatedAtMs: now,
          };
          yield* write(saved);
          return { verified: true as const };
        }),
      );
    });
  return GrokBotSetupService.of({
    status,
    send: send.pipe(
      Effect.catchTags({
        PlatformError: () => Effect.fail(new GrokBotSetupError({ stage: "write" })),
      }),
    ),
    verify,
  });
});

export const layer = Layer.effect(GrokBotSetupService, make);
