import {
  CommandId,
  MessageId,
  type GrokBotSendInput,
  type GrokBotSendResult,
  GrokBotError,
  GrokBotThreadError,
  ProviderSessionId,
  type ProviderInstanceId,
  ThreadId,
  type GrokBotOpenThreadInput,
  type GrokBotOpenThreadResult,
  type GrokBotDeleteInput,
  type GrokBotDeleteResult,
  type GrokBotOrchestratorError,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Settings from "../serverSettings.ts";
import * as Native from "./GrokBotNativeRuntimeService.ts";
import * as Config from "./GrokBotOrchestratorService.ts";
import * as Bots from "./GrokBotService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

export class GrokBotThreadService extends Context.Service<
  GrokBotThreadService,
  {
    readonly send: (
      input: typeof GrokBotSendInput.Type,
      caller: {
        readonly requestNamespace: string;
        readonly senderThreadId?: ThreadId;
        /** Where the message came from; defaults to an MCP caller. */
        readonly voiceRequest?: true;
      },
    ) => Effect.Effect<
      typeof GrokBotSendResult.Type,
      GrokBotError | GrokBotOrchestratorError | GrokBotThreadError
    >;
    readonly open: (
      input: typeof GrokBotOpenThreadInput.Type,
    ) => Effect.Effect<
      typeof GrokBotOpenThreadResult.Type,
      GrokBotError | GrokBotOrchestratorError | GrokBotThreadError
    >;
    /**
     * Attaches a read-only native observation session to every bot's canonical
     * thread, so messages sent from the native app (phone) reach T3
     * while no T3 turn is running. Starts no provider turn. A bot with no thread yet gets one, which is what makes its native history searchable.
     */
    readonly observeAll: Effect.Effect<void>;
    /** Deletes the bot and the T3 thread that observes it. Blocked while that thread has a run in flight. */
    readonly deleteBot: (
      input: typeof GrokBotDeleteInput.Type,
    ) => Effect.Effect<typeof GrokBotDeleteResult.Type, GrokBotError | GrokBotThreadError>;
  }
>()("t3/grokBot/GrokBotThreadService") {}

const storageError = () => new GrokBotThreadError({ reason: "storage_failed" });
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** A released observation session (idle cap, restart) is re-attached within this interval. */
const OBSERVE_INTERVAL = Duration.seconds(5);

const make = Effect.gen(function* () {
  const providerSessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const scope = yield* Effect.scope;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const projects = yield* Projects.ProjectStoreV2;
  const folders = yield* Folders.ManagedProjectFolders;
  const settings = yield* Settings.ServerSettingsService;
  const native = yield* Native.GrokBotNativeRuntimeService;
  const config = yield* Config.GrokBotOrchestratorService;
  const bots = yield* Bots.GrokBotService;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* Threads.ThreadManagementService;
  // All devices share this service. The durable command receipt and identity
  // below also cover a retry after the process stops between create and pin.
  const lock = yield* Semaphore.make(1);
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(Effect.mapError(storageError));
  const account = native.accountBinding.pipe(
    Effect.mapError(() => new GrokBotThreadError({ reason: "provider_not_ready" })),
  );
  const digestIdentity = (parts: readonly string[]) =>
    crypto.digest("SHA-256", new TextEncoder().encode(encodeIdentity(parts))).pipe(
      Effect.map((digest) =>
        Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
      Effect.mapError(storageError),
    );

  // Session each canonical thread is observed through, so a turn that starts
  // under a different session replaces the observer instead of doubling it.
  const observed = new Map<ThreadId, ProviderSessionId>();
  const observeLock = Semaphore.makeUnsafe(1);
  const identityOf = (botId: string, binding: string, instanceId: string) =>
    digestIdentity([binding, instanceId, botId]);

  const observeBot = Effect.fn("GrokBotThreadService.observeBot")(function* (
    botId: string,
    binding: string,
    instanceId: ProviderInstanceId,
    /** Names the canonical thread when a bot that was never opened in T3 gets one. */
    title?: string,
  ) {
    const identity = yield* identityOf(botId, binding, instanceId);
    const threadId = ThreadId.make(`grok-bot:${identity}`);
    const lookup = projections.getThread(threadId).pipe(
      Effect.asSome,
      Effect.catchTags({
        ProjectionStoreThreadNotFoundError: () => Effect.succeedNone,
      }),
    );
    let thread = yield* lookup;
    // Native history only reaches the projections (and so global search) through
    // a canonical thread. Create it here, with the same receipt id `open` uses, so
    // bots never opened in T3 are searchable without a pin or any provider turn.
    if (Option.isNone(thread) && title !== undefined) {
      const { projectId } = yield* folders.ensureNativeAgentProject;
      const project = yield* projects.getShell(projectId);
      if (Option.isNone(project)) return;
      const currentSettings = yield* settings.getSettings;
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(`grok-bot:open:${identity}`),
        threadId,
        projectId,
        title,
        modelSelection: { instanceId, model: botId },
        runtimeMode: resolveProjectSettings(currentSettings, projectId, project.value).settings
          .defaultRuntimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      });
      thread = yield* lookup;
    }
    if (
      Option.isNone(thread) ||
      thread.value.deletedAt !== null ||
      thread.value.archivedAt !== null ||
      thread.value.providerInstanceId !== instanceId ||
      thread.value.modelSelection.instanceId !== instanceId ||
      thread.value.modelSelection.model !== botId
    )
      return;
    const records = yield* projections.getThreadRecords(threadId, [
      "providerThreads",
      "providerSessions",
    ]);
    const bound = records.providerThreads.find(
      (candidate) =>
        candidate.driver === "grok-bot" &&
        candidate.providerSessionId !== null &&
        candidate.providerInstanceId === instanceId,
    );
    const boundSessionId = bound?.providerSessionId ?? null;
    const liveBound =
      boundSessionId === null
        ? Option.none()
        : yield* providerSessions.get(boundSessionId).pipe(
            Effect.catchTags({
              ProviderSessionLookupError: () => Effect.succeedNone,
            }),
          );
    // Reuse a live turn session. A stopped persisted id is not reopened after
    // restart; a dedicated observer keeps native history without a T3 turn.
    const providerSessionId =
      boundSessionId !== null && Option.isSome(liveBound)
        ? boundSessionId
        : ProviderSessionId.make(`provider-session:grok-bot-observe:${threadId}`);
    const previous = observed.get(threadId);
    if (previous !== undefined && previous !== providerSessionId)
      yield* providerSessions.close(previous).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to close the previous Grok Bot observation session", {
            threadId,
            providerSessionId: previous,
            cause,
          }),
        ),
      );
    observed.set(threadId, providerSessionId);
    // The adapter requires these; the thread's own project policy does not apply to a read-only watch.
    const project = yield* projects.get(thread.value.projectId);
    if (Option.isNone(project)) return;
    const persisted = records.providerSessions.find(
      (candidate) =>
        candidate.id === providerSessionId &&
        candidate.status !== "stopped" &&
        candidate.status !== "error",
    );
    // Opening an already-live session is an attach no-op, so a turn's own session is reused.
    yield* providerSessions.open({
      threadId,
      providerSessionId,
      modelSelection: thread.value.modelSelection,
      runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: thread.value.worktreePath ?? project.value.workspaceRoot,
      }),
      ...(persisted === undefined ? {} : { resumeFromSession: persisted }),
      ...(bound?.nativeThreadRef?.nativeId == null
        ? {}
        : { initialNativeThreadId: bound.nativeThreadRef.nativeId }),
    });
  });
  const observeAll = observeLock.withPermits(1)(
    Effect.gen(function* () {
      // Read account readiness once per sweep, not once per bot. Healthy
      // sessions remain attached; only a dropped watch needs opening again.
      const binding = yield* account;
      const ready = yield* config.inspect({ action: "status" });
      if (
        (ready.state !== "ready" && ready.state !== "blocked") ||
        ready.provider === null ||
        (yield* account) !== binding
      )
        return;
      const instanceId = ready.provider.instanceId;
      const ids = new Set(ready.botIds);
      const list = yield* bots.list;
      yield* Effect.forEach(
        list.filter((bot) => ids.has(bot.id)),
        (bot) =>
          observeBot(
            bot.id,
            binding,
            instanceId,
            bot.name.trim() || bot.label.trim() || "Grok Bot",
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to attach native Grok Bot observation", {
                botId: bot.id,
                cause,
              }),
            ),
          ),
        { discard: true, concurrency: 4 },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to list Grok Bots for native observation", { cause }),
      ),
    ),
  );
  // Restart and idle release both land here: no persisted observer state is needed.
  yield* observeAll.pipe(
    Effect.andThen(Effect.sleep(OBSERVE_INTERVAL)),
    Effect.forever,
    Effect.forkIn(scope),
  );

  const open = Effect.fn("GrokBotThreadService.open")(function* (
    input: typeof GrokBotOpenThreadInput.Type,
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const binding = yield* account;
        const ready = yield* config.inspect({ action: "status", botId: input.botId });
        // Opening a thread starts no provider turn. A current bound provider can
        // still show its chat while managed delivery or its public endpoint is blocked.
        if ((ready.state !== "ready" && ready.state !== "blocked") || ready.provider === null)
          return yield* new GrokBotThreadError({
            reason: ready.state === "account_changed" ? "account_changed" : "provider_not_ready",
          });
        if (!ready.botIds.includes(input.botId))
          return yield* new GrokBotError({ reason: "bot_not_found" });
        const instanceId = ready.provider.instanceId;
        const identity = yield* digestIdentity([binding, instanceId, input.botId]);
        const canonicalId = ThreadId.make(`grok-bot:${identity}`);
        const checkAccount = Effect.gen(function* () {
          if ((yield* account) !== binding)
            return yield* new GrokBotThreadError({ reason: "account_changed" });
          const current = yield* config.inspect({ action: "status", botId: input.botId });
          if ((yield* account) !== binding || current.state === "account_changed")
            return yield* new GrokBotThreadError({ reason: "account_changed" });
          if (
            (current.state !== "ready" && current.state !== "blocked") ||
            current.provider?.instanceId !== instanceId
          )
            return yield* new GrokBotThreadError({ reason: "provider_not_ready" });
        });
        const previous = yield* projections.getThread(canonicalId).pipe(
          Effect.asSome,
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeedNone,
          }),
          Effect.mapError(storageError),
        );
        if (Option.isSome(previous)) {
          if (previous.value.deletedAt !== null)
            return yield* new GrokBotThreadError({ reason: "thread_deleted" });
          if (
            previous.value.providerInstanceId !== instanceId ||
            previous.value.modelSelection.instanceId !== instanceId ||
            previous.value.modelSelection.model !== input.botId
          )
            return yield* new GrokBotThreadError({ reason: "thread_changed" });
        }
        let thread = Option.getOrUndefined(previous);
        const bot = (yield* bots.list).find((entry) => entry.id === input.botId);
        if (bot === undefined) return yield* new GrokBotError({ reason: "bot_not_found" });
        const { projectId } = yield* folders.ensureNativeAgentProject.pipe(
          Effect.mapError(storageError),
        );
        const project = yield* projects.getShell(projectId).pipe(Effect.mapError(storageError));
        if (Option.isNone(project)) return yield* storageError();
        if (thread === undefined) {
          const currentSettings = yield* settings.getSettings.pipe(Effect.mapError(storageError));
          yield* checkAccount;
          yield* dispatch({
            type: "thread.create",
            commandId: CommandId.make(`grok-bot:open:${identity}`),
            threadId: canonicalId,
            projectId,
            title: bot.name.trim() || bot.label.trim() || "Grok Bot",
            modelSelection: { instanceId, model: input.botId },
            runtimeMode: resolveProjectSettings(currentSettings, projectId, project.value).settings
              .defaultRuntimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "server",
          });
          thread = yield* projections.getThread(canonicalId).pipe(Effect.mapError(storageError));
        } else if (thread.projectId !== projectId) {
          const records = yield* projections
            .getThreadRecords(thread.id, ["runs"])
            .pipe(Effect.mapError(storageError));
          if (
            records.runs.some((run) =>
              ["preparing", "starting", "running", "waiting", "queued"].includes(run.status),
            )
          )
            return yield* new GrokBotThreadError({ reason: "thread_active" });
          yield* checkAccount;
          yield* dispatch({
            type: "grok-bot.thread.rebind",
            commandId: CommandId.make(
              `grok-bot:rebind:${yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError))}`,
            ),
            threadId: thread.id,
            projectId,
          });
        }
        yield* checkAccount;
        if (thread.archivedAt !== null)
          yield* dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(
              `grok-bot:unarchive:${yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError))}`,
            ),
            threadId: thread.id,
          });
        // Import the bot's pin once, through a durable receipt. Later explicit
        // unpinning remains authoritative, including after an environment restart.
        if (thread.id === canonicalId && bot.pinned)
          yield* dispatch({
            type: "thread.pin",
            commandId: CommandId.make(`grok-bot:initial-pin:${identity}`),
            threadId: thread.id,
          });
        yield* checkAccount;
        // Viewing the bot re-attaches observation right away rather than at the next interval.
        yield* observeLock
          .withPermits(1)(observeBot(input.botId, binding, instanceId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to attach native Grok Bot observation", {
                botId: input.botId,
                cause,
              }),
            ),
          );
        return { threadId: thread.id, providerInstanceId: instanceId };
      }),
    );
  });
  const send = Effect.fn("GrokBotThreadService.send")(function* (
    input: typeof GrokBotSendInput.Type,
    caller: {
      readonly requestNamespace: string;
      readonly senderThreadId?: ThreadId;
      /** Marks a request a voice call made; its text stays stored for execution. */
      readonly voiceRequest?: true;
    },
  ) {
    const binding = yield* account;
    const target = yield* open({ botId: input.botId });
    if ((yield* account) !== binding)
      return yield* new GrokBotThreadError({ reason: "account_changed" });
    const thread = yield* projections
      .getThread(target.threadId)
      .pipe(Effect.mapError(storageError));
    const key =
      input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError)));
    const identity = yield* digestIdentity([
      caller.requestNamespace,
      binding,
      target.threadId,
      key,
    ]);
    const result = yield* threads
      .sendToThread({
        projectId: thread.projectId,
        threadId: thread.id,
        commandId: CommandId.make(`grok-bot:send:${identity}`),
        messageId: MessageId.make(`grok-bot:message:${identity}`),
        text: input.message,
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
        ...(caller.voiceRequest === undefined ? {} : { voiceRequest: caller.voiceRequest }),
        ...(caller.senderThreadId === undefined ? {} : { senderThreadId: caller.senderThreadId }),
      })
      .pipe(Effect.mapError(storageError));
    return {
      accepted: true,
      threadId: thread.id,
      messageId: result.message.id,
      runId: result.run.id,
      delivery: result.delivery === "queued" ? ("queued" as const) : ("started" as const),
    };
  });
  // The bot's canonical thread is derived from the same identity as `open`, so it is found here
  // without a second source of truth. Deleting the bot first keeps a failed native delete from
  // removing the chat history.
  const deleteBot = Effect.fn("GrokBotThreadService.deleteBot")(function* (
    input: typeof GrokBotDeleteInput.Type,
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const binding = yield* account;
        const ready = yield* config
          .inspect({ action: "status", botId: input.botId })
          .pipe(Effect.orElseSucceed(() => undefined));
        const instanceId = ready?.provider?.instanceId;
        const threadId =
          instanceId === undefined
            ? undefined
            : ThreadId.make(
                `grok-bot:${yield* digestIdentity([binding, instanceId, input.botId])}`,
              );
        const linked =
          threadId === undefined
            ? Option.none()
            : yield* projections.getThread(threadId).pipe(
                Effect.asSome,
                Effect.catchTags({
                  ProjectionStoreThreadNotFoundError: () => Effect.succeedNone,
                }),
                Effect.mapError(storageError),
              );
        const live = Option.filter(linked, (thread) => thread.deletedAt === null);
        if (threadId !== undefined && Option.isSome(live)) {
          const records = yield* projections
            .getThreadRecords(threadId, ["runs"])
            .pipe(Effect.mapError(storageError));
          if (records.runs.some((run) => !Threads.isTerminalRunStatus(run.status)))
            return yield* new GrokBotError({ reason: "delete_running" });
        }
        const deleted = yield* bots.delete(input);
        if (threadId !== undefined && Option.isSome(live)) {
          observed.delete(threadId);
          // The bot is already gone, so a failed thread delete is logged rather than reported as a failed bot delete.
          yield* dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`grok-bot-delete:${threadId}`),
            threadId,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to delete the Grok Bot thread", { threadId, cause }),
            ),
          );
        }
        return deleted;
      }),
    );
  });

  return GrokBotThreadService.of({ open, send, observeAll, deleteBot });
});

export const layer = Layer.effect(GrokBotThreadService, make);
