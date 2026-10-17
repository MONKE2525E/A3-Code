import {
  CommandId,
  NativeAgentError,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  MuseAgentDictationRequestError,
  MuseAgentDictationPcm,
  MuseAgentDictationTranscript,
  type MuseAgentDictationLanguage,
  type MuseAgentConnectionStatus,
  type MuseAgentClientProfile,
  type NativeAgentOpenThreadInput,
  type NativeAgentOpenThreadResult,
  type NativeAgentFeatureReadInput,
  type NativeAgentFeatureReadResult,
  type NativeAgentFeatureUpdateInput,
  type NativeAgentFeatureUpdateResult,
  type NativeAgentPendingDelivery,
} from "@t3tools/contracts";
import type { MuseAgentPendingDelivery } from "../museAgent/MuseAgentDeliveryOwnership.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Muse from "../museAgent/MuseAgentNativeRuntimeService.ts";
import * as MuseTransport from "../museAgent/MuseAgentTransport.ts";
import * as CredentialInbox from "../museAgent/MuseAgentCredentialInbox.ts";
import * as Features from "../museAgent/MuseAgentFeatureService.ts";
import {
  museIdentityOfThread,
  museThreadIdentity,
  museThreadIdForSession,
} from "../museAgent/MuseAgentThreadIds.ts";
import * as Connectors from "../museAgent/MuseAgentConnectorService.ts";
import * as Computer from "../museAgent/MuseAgentComputerService.ts";
import * as Dictation from "../museAgent/MuseAgentDictation.ts";
import * as Grok from "../grokBot/GrokBotThreadService.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Hydration from "../provider/ProviderInstanceRegistryHydration.ts";
import * as Mutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export class NativeAgentService extends Context.Service<
  NativeAgentService,
  {
    readonly status: Effect.Effect<typeof MuseAgentConnectionStatus.Type, NativeAgentError>;
    readonly featureRead: (
      input: typeof NativeAgentFeatureReadInput.Type,
    ) => Effect.Effect<typeof NativeAgentFeatureReadResult.Type, NativeAgentError>;
    readonly featureUpdate: (
      input: typeof NativeAgentFeatureUpdateInput.Type,
    ) => Effect.Effect<typeof NativeAgentFeatureUpdateResult.Type, NativeAgentError>;
    readonly setup: Effect.Effect<typeof MuseAgentConnectionStatus.Type, NativeAgentError>;
    readonly profile: (
      instanceId?: ProviderInstanceId,
    ) => Effect.Effect<typeof MuseAgentClientProfile.Type, NativeAgentError>;
    readonly avatar: (
      instanceId: ProviderInstanceId,
      variant: string,
    ) => Effect.Effect<
      { readonly bytes: Uint8Array; readonly contentType: string },
      NativeAgentError
    >;
    readonly dictationTranscribe: (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly pcm: Uint8Array;
      readonly language?: MuseAgentDictationLanguage;
    }) => Effect.Effect<typeof MuseAgentDictationTranscript.Type, MuseAgentDictationRequestError>;
    readonly computerStream: (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly sessionId: string;
      readonly taskId: string;
      readonly takeoverId: string;
    }) => Effect.Effect<
      {
        readonly events: Stream.Stream<Uint8Array, NativeAgentError>;
        readonly send: (data: Uint8Array) => Effect.Effect<void, NativeAgentError>;
        readonly close: Effect.Effect<void>;
      },
      NativeAgentError,
      Scope.Scope
    >;
    readonly computerPreview: (
      instanceId: ProviderInstanceId,
      sessionId: string,
      taskId: string,
    ) => Effect.Effect<
      {
        readonly bytes: Uint8Array;
        readonly contentType: "image/png" | "image/jpeg" | "image/webp";
      },
      NativeAgentError
    >;
    readonly open: (
      reference: NativeAgentOpenThreadInput,
    ) => Effect.Effect<typeof NativeAgentOpenThreadResult.Type, NativeAgentError>;
    readonly openAuthorized: <E, R>(
      reference: NativeAgentOpenThreadInput,
      authorize: Effect.Effect<void, E, R>,
    ) => Effect.Effect<typeof NativeAgentOpenThreadResult.Type, NativeAgentError | E, R>;
  }
>()("t3/nativeAgents/NativeAgentService") {}

const failure = (reason: NativeAgentError["reason"]) => () => new NativeAgentError({ reason });
const isNativeAgentError = Schema.is(NativeAgentError);
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeBinding = Schema.decodeUnknownOption(Schema.Struct({ accountBinding: Schema.String }));
const decodeDictationPcm = Schema.decodeEffect(MuseAgentDictationPcm);
const decodeDictationTranscript = Schema.decodeEffect(MuseAgentDictationTranscript);
const nativeFailure = (error: Muse.MuseAgentError) =>
  new NativeAgentError({
    reason:
      "kind" in error && error.kind === "account_changed"
        ? "account_changed"
        : "provider_not_ready",
  });

const make = Effect.gen(function* () {
  const native = yield* Muse.MuseAgentNativeRuntimeService;
  const transport = yield* MuseTransport.MuseAgentTransport;
  const credentialInbox = yield* Effect.serviceOption(CredentialInbox.MuseAgentCredentialInbox);
  const features = yield* Features.MuseAgentFeatureService;
  const connectors = yield* Connectors.MuseAgentConnectorService;
  const computer = yield* Computer.MuseAgentComputerService;
  const dictation = yield* Dictation.MuseAgentDictation;
  const grok = yield* Grok.GrokBotThreadService;
  const settings = yield* Settings.ServerSettingsService;
  const providers = yield* Providers.ProviderRegistry;
  const mutator = yield* Mutator.ProviderInstanceRegistryMutator;
  const projections = yield* Projections.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const folders = yield* Folders.ManagedProjectFolders;
  const projects = yield* Projects.ProjectStoreV2;
  const providerSessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const entries = Effect.map(settings.getSettings, (value) =>
    Object.entries(value.providerInstances).filter(([, entry]) => entry.driver === "muse-agent"),
  );
  const bindingOf = (config: unknown) => {
    const decoded = decodeBinding(config);
    return Option.isSome(decoded) ? decoded.value.accountBinding : undefined;
  };
  const account = native.accountBinding.pipe(Effect.mapError(nativeFailure));
  const selected = Effect.fnUntraced(function* (instanceId?: ProviderInstanceId) {
    const binding = yield* account;
    const entry = (yield* entries.pipe(Effect.mapError(failure("settings_failed")))).find(
      ([id, entry]) =>
        (instanceId === undefined || id === instanceId) &&
        entry.enabled !== false &&
        bindingOf(entry.config) === binding,
    );
    if (entry === undefined)
      return yield* new NativeAgentError({
        reason: instanceId ? "account_changed" : "provider_not_ready",
      });
    return { binding, instanceId: ProviderInstanceId.make(entry[0]) };
  });
  const canonicalIdentity = (selection: { binding: string; instanceId: ProviderInstanceId }) =>
    Effect.try({
      try: () => museThreadIdentity(selection.binding, selection.instanceId),
      catch: failure("storage_failed"),
    });
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);
  const assessDelivery = Effect.fnUntraced(function* (
    selection: { binding: string; instanceId: ProviderInstanceId },
    sessionId: string,
    delivery: MuseAgentPendingDelivery,
  ) {
    const blocked = (blockedReason: NonNullable<NativeAgentPendingDelivery["blockedReason"]>) => ({
      blockedReason,
      context: null,
      providerSessionId: null,
      runOrdinal: null,
    });
    const context = delivery.context;
    if (!context) return blocked("legacy_context");
    if (
      context.providerInstanceId !== selection.instanceId ||
      museIdentityOfThread(context.threadId) !== (yield* canonicalIdentity(selection))
    )
      return blocked("context_changed");
    const thread = yield* projections
      .getThreadShell(context.threadId)
      .pipe(Effect.mapError(failure("storage_failed")));
    if (
      !thread ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.providerInstanceId !== selection.instanceId ||
      thread.modelSelection.instanceId !== selection.instanceId ||
      thread.modelSelection.model !== "muse"
    )
      return blocked("context_changed");
    const records = yield* projections
      .getThreadRecords(context.threadId, [
        "runs",
        "attempts",
        "nodes",
        "providerThreads",
        "providerTurns",
      ])
      .pipe(Effect.mapError(failure("storage_failed")));
    const run = records.runs.find((run) => run.id === context.runId);
    const attempt = records.attempts.find((attempt) => attempt.id === delivery.deliveryKey);
    const node = records.nodes.find((node) => node.id === context.nodeId);
    const providerThread = records.providerThreads.find(
      (thread) => thread.id === context.providerThreadId,
    );
    const providerTurn = records.providerTurns.find((turn) => turn.id === context.providerTurnId);
    if (
      !run ||
      !attempt ||
      !node ||
      !providerThread ||
      run.threadId !== context.threadId ||
      run.providerInstanceId !== selection.instanceId ||
      run.modelSelection.instanceId !== selection.instanceId ||
      run.modelSelection.model !== "muse" ||
      run.userMessageId !== context.userMessageId ||
      run.rootNodeId !== context.nodeId ||
      run.providerThreadId !== context.providerThreadId ||
      run.activeAttemptId !== delivery.deliveryKey ||
      attempt.runId !== context.runId ||
      attempt.rootNodeId !== context.nodeId ||
      attempt.providerInstanceId !== selection.instanceId ||
      attempt.providerThreadId !== context.providerThreadId ||
      (attempt.providerTurnId !== null && attempt.providerTurnId !== context.providerTurnId) ||
      context.providerTurnId !==
        `provider-turn/muse-agent/${encodeURIComponent(delivery.deliveryKey)}` ||
      node.threadId !== context.threadId ||
      node.runId !== context.runId ||
      node.rootNodeId !== context.nodeId ||
      node.providerThreadId !== context.providerThreadId ||
      (node.providerTurnId !== null && node.providerTurnId !== context.providerTurnId) ||
      providerThread.driver !== "muse-agent" ||
      providerThread.providerInstanceId !== selection.instanceId ||
      providerThread.appThreadId !== context.threadId ||
      providerThread.nativeThreadRef?.driver !== "muse-agent" ||
      providerThread.nativeThreadRef.nativeId !==
        `${selection.binding}/${encodeURIComponent(sessionId)}` ||
      (providerTurn !== undefined &&
        (providerTurn.providerThreadId !== context.providerThreadId ||
          providerTurn.nodeId !== context.nodeId ||
          providerTurn.runAttemptId !== delivery.deliveryKey))
    )
      return blocked("context_changed");
    if (
      !terminalStatuses.has(run.status) ||
      !terminalStatuses.has(attempt.status) ||
      !terminalStatuses.has(node.status) ||
      (providerTurn !== undefined && !terminalStatuses.has(providerTurn.status)) ||
      records.runs.some((candidate) => !terminalStatuses.has(candidate.status)) ||
      records.attempts.some(
        (candidate) => !terminalStatuses.has(candidate.status) && candidate.status !== "superseded",
      )
    )
      return blocked("run_active");
    return {
      blockedReason: null,
      context,
      providerSessionId: providerThread.providerSessionId,
      runOrdinal: run.ordinal,
    };
  });
  const status = Effect.gen(function* () {
    const info = yield* native.status;
    const snapshots = yield* providers.getProviders;
    const configured = yield* entries.pipe(Effect.mapError(failure("settings_failed")));
    const provider =
      snapshots.find(
        (item) =>
          item.driver === "muse-agent" &&
          item.enabled &&
          configured.some(
            ([id, entry]) =>
              id === item.instanceId &&
              entry.enabled !== false &&
              info.accountBinding !== undefined &&
              bindingOf(entry.config) === info.accountBinding,
          ),
      ) ?? null;
    const ready = info.ready && info.sessionPresent && provider?.status === "ready";
    return {
      ...info,
      ready,
      provider,
      capabilities: [
        "chat",
        "tools",
        "profile",
        "sessions",
        "attachments",
        "memory",
        "routines",
        "connectors",
        "computer",
        "dictation",
      ] as const,
    };
  });
  const setup = lock.withPermits(1)(
    Effect.gen(function* () {
      const info = yield* native.setup.pipe(
        Effect.mapError(
          (error) => new NativeAgentError({ reason: "provider_not_ready", detail: error.message }),
        ),
      );
      const binding = info.accountBinding;
      if (!binding) return yield* new NativeAgentError({ reason: "provider_not_ready" });
      const configured = yield* entries.pipe(Effect.mapError(failure("settings_failed")));
      const matching = configured.find(([, entry]) => bindingOf(entry.config) === binding);
      if (configured.length && !matching)
        return yield* new NativeAgentError({ reason: "account_changed" });
      const instanceId = ProviderInstanceId.make(
        matching?.[0] ?? `muse-agent-${binding.slice(0, 32)}`,
      );
      if ((yield* account) !== binding)
        return yield* new NativeAgentError({ reason: "account_changed" });
      if (!matching || matching[1].enabled === false)
        yield* settings
          .updateProviderInstance({
            operation: matching ? "upsert" : "create",
            instanceId,
            instance: {
              ...matching?.[1],
              driver: ProviderDriverKind.make("muse-agent"),
              enabled: true,
              config: { accountBinding: binding },
            },
          })
          .pipe(Effect.mapError(failure("settings_failed")));
      yield* Hydration.reconcileSettings.pipe(
        Effect.provideService(Mutator.ProviderInstanceRegistryMutator, mutator),
        Effect.provideService(Settings.ServerSettingsService, settings),
        Effect.mapError(failure("settings_failed")),
      );
      yield* providers.refreshInstance(instanceId);
      if ((yield* account) !== binding)
        return yield* new NativeAgentError({ reason: "account_changed" });
      return yield* status;
    }),
  );
  const profile = Effect.fnUntraced(function* (instanceId?: ProviderInstanceId) {
    const selection = yield* selected(instanceId);
    const identity = yield* native.profile(selection.binding).pipe(Effect.mapError(nativeFailure));
    const avatarDigest = yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          encodeIdentity([
            selection.binding,
            selection.instanceId,
            identity.avatarPath ?? "",
            identity.avatarImagePath ?? "",
            ...Object.entries(identity.avatarVideoVariants ?? {})
              .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .flat(),
          ]),
        ),
      )
      .pipe(Effect.mapError(failure("storage_failed")));
    const avatarRevision = Array.from(avatarDigest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const prefix = `/api/ai-agents/muse/${encodeURIComponent(selection.instanceId)}/avatar/`;
    return {
      ...identity,
      avatarRevision,
      ...(identity.avatarImagePath
        ? { avatarImageUrl: `${prefix}image?revision=${avatarRevision}` }
        : {}),
      avatarVideoUrls: Object.fromEntries(
        Object.keys(identity.avatarVideoVariants ?? {}).map((key) => [
          key,
          `${prefix}${encodeURIComponent(key)}?revision=${avatarRevision}`,
        ]),
      ),
    };
  });
  const avatar = Effect.fnUntraced(function* (instanceId: ProviderInstanceId, variant: string) {
    const selection = yield* selected(instanceId);
    const identity = yield* native.profile(selection.binding).pipe(Effect.mapError(nativeFailure));
    const path =
      variant === "image"
        ? identity.avatarImagePath
        : identity.avatarVideoVariants !== undefined &&
            Object.hasOwn(identity.avatarVideoVariants, variant)
          ? identity.avatarVideoVariants[variant]
          : undefined;
    if (!path) return yield* new NativeAgentError({ reason: "provider_unavailable" });
    return yield* transport
      .readAvatar(selection.binding, path)
      .pipe(Effect.mapError(nativeFailure));
  });
  const observed = new Map<ThreadId, ProviderSessionId>();
  const attachFailure = () =>
    new NativeAgentError({
      reason: "provider_unavailable",
      detail:
        "Could not connect to this Muse conversation. Wait for any active Muse turn to finish, then try again.",
    });
  const observe = <E = never, R = never>(
    threadId: ThreadId,
    instanceId: ProviderInstanceId,
    authorize?: Effect.Effect<void, E, R>,
  ): Effect.Effect<void, NativeAgentError | E, R> =>
    Effect.gen(function* () {
      const thread = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.mapError(attachFailure));
      if (
        !thread ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.providerInstanceId !== instanceId ||
        thread.modelSelection.instanceId !== instanceId ||
        thread.modelSelection.model !== "muse"
      )
        return;
      const records = yield* projections
        .getThreadRecords(threadId, ["providerThreads", "providerSessions"])
        .pipe(Effect.mapError(attachFailure));
      const bound = records.providerThreads.find(
        (candidate) =>
          candidate.driver === "muse-agent" &&
          candidate.providerInstanceId === instanceId &&
          candidate.providerSessionId !== null,
      );
      const boundId = bound?.providerSessionId ?? null;
      const live =
        boundId === null
          ? Option.none()
          : yield* providerSessions.get(boundId).pipe(
              Effect.catchTags({
                ProviderSessionLookupError: () => Effect.succeed(Option.none()),
              }),
              Effect.mapError(attachFailure),
            );
      const providerSessionId =
        boundId !== null && Option.isSome(live)
          ? boundId
          : ProviderSessionId.make(`provider-session:muse-agent-observe:${threadId}`);
      const project = yield* projects.get(thread.projectId).pipe(Effect.mapError(attachFailure));
      if (Option.isNone(project)) return;
      const previous = observed.get(threadId);
      yield* authorize ?? Effect.void;
      if (previous !== undefined && previous !== providerSessionId)
        yield* providerSessions.close(previous).pipe(Effect.mapError(attachFailure));
      const persisted = records.providerSessions.find(
        (candidate) =>
          candidate.id === providerSessionId &&
          candidate.status !== "stopped" &&
          candidate.status !== "error",
      );
      // Attaching a session imports native history without admitting a provider turn.
      yield* authorize ?? Effect.void;
      yield* providerSessions
        .open({
          threadId,
          providerSessionId,
          modelSelection: thread.modelSelection,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: thread.worktreePath ?? project.value.workspaceRoot,
          }),
          ...(persisted === undefined ? {} : { resumeFromSession: persisted }),
          ...(bound?.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: bound.nativeThreadRef.nativeId }),
        })
        .pipe(Effect.mapError(attachFailure));
      observed.set(threadId, providerSessionId);
    });
  const openAuthorized = <E, R>(
    reference: NativeAgentOpenThreadInput,
    authorize: Effect.Effect<void, E, R>,
  ): Effect.Effect<typeof NativeAgentOpenThreadResult.Type, NativeAgentError | E, R> =>
    Effect.gen(function* () {
      yield* authorize ?? Effect.void;
      if (reference.source === "grok-bot") {
        const snapshot = (yield* providers.getProviders).find(
          (item) => item.instanceId === reference.providerInstanceId,
        );
        if (snapshot?.driver !== "grok-bot")
          return yield* new NativeAgentError({ reason: "provider_unavailable" });
        const result = yield* grok
          .open({ botId: reference.agentId })
          .pipe(Effect.mapError(failure("provider_not_ready")));
        if (result.providerInstanceId !== reference.providerInstanceId)
          return yield* new NativeAgentError({ reason: "account_changed" });
        return result;
      }
      if (reference.agentId !== "muse")
        return yield* new NativeAgentError({ reason: "provider_unavailable" });
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* authorize ?? Effect.void;
          const selection = yield* selected(reference.providerInstanceId);
          // Main chat is the primary session; a side chat opens its own session and its own thread.
          const target = yield* native
            .resolveSession(selection.binding, reference.sessionId)
            .pipe(Effect.mapError(nativeFailure));
          const identity = yield* canonicalIdentity(selection);
          const threadId = ThreadId.make(
            museThreadIdForSession(identity, target.is_primary ? undefined : target.session_id),
          );
          const previous = yield* projections
            .getThread(threadId)
            .pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () => Effect.succeed(undefined),
              }),
            )
            .pipe(Effect.mapError(failure("storage_failed")));
          if (previous?.deletedAt) return yield* new NativeAgentError({ reason: "thread_deleted" });
          if (
            previous &&
            (previous.providerInstanceId !== selection.instanceId ||
              previous.modelSelection.instanceId !== selection.instanceId ||
              previous.modelSelection.model !== "muse")
          )
            return yield* new NativeAgentError({ reason: "thread_changed" });
          const check = Effect.gen(function* () {
            const current = yield* selected(selection.instanceId);
            if (current.binding !== selection.binding)
              return yield* new NativeAgentError({ reason: "account_changed" });
          });
          if (!previous) {
            yield* authorize ?? Effect.void;
            const { projectId } = yield* folders.ensureNativeAgentProject.pipe(
              Effect.mapError(failure("scratch_unavailable")),
            );
            const assistant = yield* profile(selection.instanceId);
            yield* check;
            yield* authorize ?? Effect.void;
            yield* orchestrator
              .dispatch({
                type: "thread.create",
                commandId: CommandId.make(`muse-agent:open:${threadId}`),
                threadId,
                projectId,
                title: target.is_primary ? assistant.name : target.title?.trim() || assistant.name,
                modelSelection: { instanceId: selection.instanceId, model: "muse" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "server",
              })
              .pipe(
                Effect.provideService(Orchestrator.MuseThreadCreation, threadId),
                Effect.mapError(failure("storage_failed")),
              );
          } else if (previous.archivedAt !== null) {
            yield* check;
            const nonce = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(failure("storage_failed")),
            );
            yield* authorize ?? Effect.void;
            yield* orchestrator
              .dispatch({
                type: "thread.unarchive",
                commandId: CommandId.make(`muse-agent:unarchive:${nonce}`),
                threadId,
              })
              .pipe(
                Effect.provideService(Orchestrator.MuseThreadMutation, {
                  threadId,
                  operation: "archive",
                }),
                Effect.mapError(failure("storage_failed")),
              );
          }
          yield* check;
          yield* observe(threadId, selection.instanceId, authorize);
          yield* check;
          return { threadId, providerInstanceId: selection.instanceId };
        }),
      );
    });
  const open = (reference: NativeAgentOpenThreadInput) => openAuthorized(reference, Effect.void);
  const featureFailure = (error: Features.MuseAgentFeatureError) =>
    new NativeAgentError({
      reason: error.code === "account_changed" ? "account_changed" : "provider_unavailable",
      detail: error.message,
    });
  const dictationTranscribe = Effect.fnUntraced(
    function* (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly pcm: Uint8Array;
      readonly language?: MuseAgentDictationLanguage;
    }) {
      const selection = yield* selected(input.providerInstanceId);
      const pcm = yield* decodeDictationPcm(input.pcm).pipe(
        Effect.mapError(() => new MuseAgentDictationRequestError({ code: "invalid_audio" })),
      );
      const result = yield* dictation
        .transcribe({ pcm, ...(input.language !== undefined ? { language: input.language } : {}) })
        .pipe(
          Effect.mapError((error) => new MuseAgentDictationRequestError({ code: error.kind })),
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(new MuseAgentDictationRequestError({ code: "timeout" })),
          }),
        );
      if ((yield* selected(input.providerInstanceId)).binding !== selection.binding)
        return yield* new MuseAgentDictationRequestError({ code: "account_changed" });
      if (!result.text.trim())
        return yield* new MuseAgentDictationRequestError({ code: "no_speech" });
      return yield* decodeDictationTranscript(result).pipe(
        Effect.mapError(() => new MuseAgentDictationRequestError({ code: "failed" })),
      );
    },
    Effect.catchTags({
      NativeAgentError: (error) =>
        Effect.fail(
          new MuseAgentDictationRequestError({
            code: error.reason === "account_changed" ? "account_changed" : "unavailable",
          }),
        ),
    }),
  );
  const computerFailure = (error: Computer.MuseAgentComputerError) =>
    new NativeAgentError({
      reason: error.code === "account_changed" ? "account_changed" : "provider_unavailable",
      detail: error.message,
    });
  const computerScope = (
    selection: { binding: string; instanceId: ProviderInstanceId },
    sessionId: string,
    taskId: string,
  ) => ({ binding: selection.binding, sessionId, taskId });
  const computerStream = Effect.fnUntraced(function* (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionId: string;
    readonly taskId: string;
    readonly takeoverId: string;
  }) {
    const selection = yield* selected(input.providerInstanceId);
    const stream = yield* computer
      .openStream(computerScope(selection, input.sessionId, input.taskId), input.takeoverId)
      .pipe(Effect.mapError(computerFailure));
    if ((yield* selected(input.providerInstanceId)).binding !== selection.binding)
      return yield* new NativeAgentError({ reason: "account_changed" });
    return {
      events: stream.events.pipe(Stream.mapError(computerFailure)),
      send: (data: Uint8Array) =>
        Effect.gen(function* () {
          if ((yield* selected(input.providerInstanceId)).binding !== selection.binding)
            return yield* new NativeAgentError({ reason: "account_changed" });
          yield* stream.send(data).pipe(Effect.mapError(computerFailure));
        }),
      close: stream.close,
    };
  });
  const computerPreview = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
    sessionId: string,
    taskId: string,
  ) {
    const selection = yield* selected(instanceId);
    const scope = computerScope(selection, sessionId, taskId);
    const result = yield* computer.preview(scope).pipe(Effect.mapError(computerFailure));
    if (
      result.bytes.byteLength === 0 ||
      result.bytes.byteLength > 20 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(result.contentType)
    )
      return yield* new NativeAgentError({
        reason: "provider_unavailable",
        detail: "Muse returned an unsupported computer preview.",
      });
    if ((yield* selected(instanceId)).binding !== selection.binding)
      return yield* new NativeAgentError({ reason: "account_changed" });
    return result;
  });
  const historyPage = Effect.fnUntraced(
    function* (
      selection: { binding: string; instanceId: ProviderInstanceId },
      threadId: ThreadId,
      beforeSeq?: number,
    ) {
      const identity = yield* canonicalIdentity(selection);
      const shell = yield* projections.getThreadShell(threadId);
      if (
        museIdentityOfThread(threadId) !== identity ||
        !shell ||
        shell.deletedAt !== null ||
        shell.archivedAt !== null ||
        shell.providerInstanceId !== selection.instanceId ||
        shell.modelSelection.instanceId !== selection.instanceId ||
        shell.modelSelection.model !== "muse"
      )
        return yield* new NativeAgentError({ reason: "thread_changed" });
      const records = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
      const boundSessionId = records.providerThreads.find(
        (thread) =>
          thread.driver === "muse-agent" &&
          thread.providerInstanceId === selection.instanceId &&
          thread.appThreadId === threadId,
      )?.providerSessionId;
      let live = Option.none<ProviderAdapter.ProviderAdapterV2SessionRuntime>();
      for (const sessionId of new Set([boundSessionId, observed.get(threadId)])) {
        if (!sessionId) continue;
        live = yield* providerSessions
          .get(sessionId)
          .pipe(Effect.mapError(() => new NativeAgentError({ reason: "provider_unavailable" })));
        if (Option.isSome(live)) break;
      }
      if (
        Option.isNone(live) ||
        live.value.driver !== "muse-agent" ||
        live.value.instanceId !== selection.instanceId ||
        !live.value.loadHistoryPage
      )
        return yield* new NativeAgentError({ reason: "provider_unavailable" });
      const data = yield* live.value
        .loadHistoryPage({
          threadId,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        })
        .pipe(
          Effect.mapError(
            () =>
              new NativeAgentError({
                reason: "provider_unavailable",
                detail:
                  "Muse could not load this history page. Refresh the history cursor and try again.",
              }),
          ),
        );
      if ((yield* selected(selection.instanceId)).binding !== selection.binding)
        return yield* new NativeAgentError({ reason: "account_changed" });

      return data;
    },
    Effect.mapError((cause) =>
      isNativeAgentError(cause) ? cause : new NativeAgentError({ reason: "provider_unavailable" }),
    ),
  );
  const featureRead = Effect.fnUntraced(function* (input: typeof NativeAgentFeatureReadInput.Type) {
    const selection = yield* selected(input.providerInstanceId);
    const { binding } = selection;
    switch (input.operation) {
      case "credential_requests": {
        const session = yield* native
          .resolveSession(binding, input.sessionId)
          .pipe(Effect.mapError(nativeFailure));
        const connectorRequests = Option.isSome(credentialInbox)
          ? credentialInbox.value.pendingConnectors(binding, session.session_id)
          : [];
        // A get performs a full catalog read too; reconcile all cards with one native request.
        const connected = connectorRequests.length
          ? yield* features.connectors(binding).pipe(
              Effect.map(
                (catalog) =>
                  new Set(
                    catalog.filter((item) => item.state === "connected").map((item) => item.id),
                  ),
              ),
              Effect.catchTags({ MuseAgentFeatureError: () => Effect.succeed(new Set<string>()) }),
            )
          : new Set<string>();
        const pendingConnectors = connectorRequests.filter((request) => {
          if (!connected.has(request.connectorId)) return true;
          if (Option.isSome(credentialInbox))
            credentialInbox.value.complete(binding, request.sessionId, request.requestId);
          return false;
        });
        if ((yield* selected(selection.instanceId)).binding !== binding)
          return yield* new NativeAgentError({ reason: "account_changed" });
        return {
          operation: input.operation,
          data: {
            sessionId: session.session_id,
            requests: Option.isSome(credentialInbox)
              ? credentialInbox.value.pending(binding, session.session_id)
              : [],
            ...(pendingConnectors.length ? { connectorRequests: pendingConnectors } : {}),
          },
        };
      }
      case "history_page":
        return { operation: input.operation, data: yield* historyPage(selection, input.threadId) };
      case "dictation":
        return { operation: input.operation, data: yield* dictation.status };
      case "computer_task": {
        const scope = computerScope(selection, input.sessionId, input.taskId);
        const data = yield* computer.readTask(scope).pipe(Effect.mapError(computerFailure));
        if ((yield* selected(selection.instanceId)).binding !== binding)
          return yield* new NativeAgentError({ reason: "account_changed" });
        return { operation: input.operation, data };
      }
      case "pending_deliveries": {
        const session = yield* native
          .resolveSession(binding, input.sessionId)
          .pipe(Effect.mapError(nativeFailure));
        if (input.sessionId !== undefined && session.session_id !== input.sessionId)
          return yield* new NativeAgentError({ reason: "thread_changed" });
        const pending = yield* native
          .pendingDeliveries({ binding, sessionId: session.session_id })
          .pipe(Effect.mapError(nativeFailure));
        return {
          operation: input.operation,
          data: {
            sessionId: session.session_id,
            deliveries: yield* Effect.forEach(pending.slice(0, 100), (delivery) =>
              assessDelivery(selection, session.session_id, delivery).pipe(
                Effect.map((assessment) => ({
                  deliveryKey: delivery.deliveryKey,
                  status: delivery.status,
                  threadId: delivery.context?.threadId ?? null,
                  runId: delivery.context?.runId ?? null,
                  releasable: assessment.blockedReason === null,
                  blockedReason: assessment.blockedReason,
                })),
              ),
            ),
          },
        };
      }
      case "connector_info": {
        const session = yield* native.resolveSession(binding).pipe(Effect.mapError(nativeFailure));
        return {
          operation: input.operation,
          data: yield* connectors
            .connectInfo(binding, input.connectorId, session.session_id)
            .pipe(Effect.mapError(featureFailure)),
        };
      }
      case "connector_accounts":
        return {
          operation: input.operation,
          data: yield* connectors
            .accounts(binding, input.connectorId)
            .pipe(Effect.mapError(featureFailure)),
        };
      case "profile_document":
        return {
          operation: input.operation,
          data: yield* features
            .readProfileDocument(binding, input.document)
            .pipe(Effect.mapError(featureFailure)),
        };
      case "profile_themes":
        return {
          operation: input.operation,
          data: yield* features.themes(binding).pipe(Effect.mapError(featureFailure)),
        };
      case "inventory":
        return {
          operation: input.operation,
          data: yield* features.inventory(binding).pipe(Effect.mapError(featureFailure)),
        };
      case "tasks":
        return {
          operation: input.operation,
          data: yield* features.tasks(binding).pipe(Effect.mapError(featureFailure)),
        };
      case "task_runs":
        return {
          operation: input.operation,
          data: yield* features
            .taskRuns(binding, input.jobId)
            .pipe(Effect.mapError(featureFailure)),
        };
      case "connectors":
        return {
          operation: input.operation,
          data: yield* features.connectors(binding).pipe(Effect.mapError(featureFailure)),
        };
      case "skills":
        return {
          operation: input.operation,
          data: yield* features.skills(binding).pipe(Effect.mapError(featureFailure)),
        };
      case "sessions":
        return {
          operation: input.operation,
          data: yield* features.sessions(binding, input.view).pipe(Effect.mapError(featureFailure)),
        };
      case "computer":
        return {
          operation: input.operation,
          data: yield* features.computerStatus(binding).pipe(Effect.mapError(featureFailure)),
        };
      case "memory_search":
        return {
          operation: input.operation,
          data: yield* features
            .searchMemory(binding, input.query)
            .pipe(Effect.mapError(featureFailure)),
        };
      case "memory_read":
        return {
          operation: input.operation,
          data: yield* features
            .readMemory(binding, input.uri)
            .pipe(Effect.mapError(featureFailure)),
        };
    }
  });
  const featureUpdate = Effect.fnUntraced(function* (
    input: typeof NativeAgentFeatureUpdateInput.Type,
  ) {
    const selection = yield* selected(input.providerInstanceId);
    const { binding } = selection;
    switch (input.operation) {
      case "connector_auth":
        yield* connectors
          .authenticate(binding, input.connectorId, input.authType, input.key)
          .pipe(Effect.mapError(featureFailure));
        if (Option.isSome(credentialInbox))
          credentialInbox.value.completeConnector(binding, input.connectorId);
        break;
      case "credential_submit": {
        if (Option.isNone(credentialInbox))
          return yield* new NativeAgentError({ reason: "provider_unavailable" });
        const session = yield* native
          .resolveSession(binding, input.sessionId)
          .pipe(Effect.mapError(nativeFailure));
        const inbox = credentialInbox.value;
        const pendingRequest = inbox
          .pending(binding, session.session_id)
          .find((item) => item.requestId === input.requestId);
        if (!pendingRequest)
          return yield* new NativeAgentError({
            reason: "thread_changed",
            detail:
              "This credential request is no longer pending. Refresh Muse before trying again.",
          });
        const values =
          pendingRequest.capture === "verification_code"
            ? [{ name: "verification_code", value: input.verificationCode, protected: true }]
            : [
                { name: "username", value: input.username, protected: true },
                { name: "password", value: input.password, protected: true },
              ];
        if (
          values.some(
            (field) =>
              !field.value ||
              Buffer.byteLength(field.value, "utf8") > (field.name === "password" ? 1024 : 256),
          )
        )
          return yield* new NativeAgentError({
            reason: "provider_unavailable",
            detail: "The credential fields are invalid.",
          });
        const target = inbox.take(binding, session.session_id, input.requestId);
        if (!target) return yield* new NativeAgentError({ reason: "thread_changed" });
        const result = yield* transport
          .request(
            binding,
            "credentials.capture",
            {
              page_url: target.request.pageUrl,
              idempotency_key: target.idempotencyKey,
              label: null,
              fields: values,
              lifetime: target.request.capture === "verification_code" ? "on_read" : "persist",
              session_id: session.session_id,
              ...(target.authorization === undefined
                ? {}
                : { capture_authorization: target.authorization }),
            },
            true,
          )
          .pipe(
            Effect.mapError(
              () =>
                new NativeAgentError({
                  reason: "provider_unavailable",
                  detail:
                    "Muse could not confirm credential storage. The value was not sent again.",
                }),
            ),
          );
        if (
          typeof result !== "object" ||
          result === null ||
          !("id" in result) ||
          typeof result.id !== "string" ||
          !result.id
        )
          return yield* new NativeAgentError({
            reason: "provider_unavailable",
            detail: "Muse did not confirm credential storage.",
          });
        inbox.complete(binding, session.session_id, input.requestId);
        break;
      }
      case "history_page":
        return {
          updated: true as const,
          historyPage: yield* historyPage(selection, input.threadId, input.beforeSeq),
        };
      case "computer_action": {
        const scope = computerScope(selection, input.sessionId, input.taskId);
        const result = yield* computer
          .operate(scope, input.command)
          .pipe(Effect.mapError(computerFailure));
        return {
          updated: true as const,
          ...("state" in result ? { computerState: result.state } : {}),
        };
      }
      case "delivery_release":
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* selected(selection.instanceId);
            if (current.binding !== binding)
              return yield* new NativeAgentError({ reason: "account_changed" });
            const session = yield* native
              .resolveSession(binding, input.sessionId)
              .pipe(Effect.mapError(nativeFailure));
            if (session.session_id !== input.sessionId)
              return yield* new NativeAgentError({ reason: "thread_changed" });
            const pending = yield* native
              .pendingDeliveries({ binding, sessionId: session.session_id })
              .pipe(Effect.mapError(nativeFailure));
            const delivery = pending.find((delivery) => delivery.deliveryKey === input.deliveryKey);
            if (!delivery)
              return yield* new NativeAgentError({
                reason: "thread_changed",
                detail: "This Muse delivery is no longer pending.",
              });
            const assessment = yield* assessDelivery(current, session.session_id, delivery);
            if (assessment.blockedReason !== null)
              return yield* new NativeAgentError({
                reason:
                  assessment.blockedReason === "run_active" ? "thread_active" : "thread_changed",
                detail:
                  assessment.blockedReason === "run_active"
                    ? "Finish or stop the exact T3 run before releasing local tracking."
                    : "This Muse delivery has no verified terminal T3 ownership.",
              });
            if (assessment.context === null || assessment.runOrdinal === null)
              return yield* new NativeAgentError({ reason: "thread_changed" });
            if (assessment.providerSessionId !== null) {
              const live = yield* providerSessions
                .get(assessment.providerSessionId)
                .pipe(Effect.mapError(failure("storage_failed")));
              if (Option.isSome(live)) {
                if (
                  live.value.driver !== "muse-agent" ||
                  live.value.instanceId !== selection.instanceId ||
                  !(yield* providerSessions
                    .closeNativeDeliverySession({
                      runtime: live.value,
                      providerThreadId: assessment.context.providerThreadId,
                      runOrdinal: assessment.runOrdinal,
                    })
                    .pipe(Effect.mapError(failure("storage_failed"))))
                )
                  return yield* new NativeAgentError({
                    reason: "thread_active",
                    detail: "The local Muse session changed. Refresh before releasing tracking.",
                  });
              }
            }
            const reselected = yield* selected(selection.instanceId);
            if (reselected.binding !== binding)
              return yield* new NativeAgentError({ reason: "account_changed" });
            const latest = (yield* native
              .pendingDeliveries({ binding, sessionId: session.session_id })
              .pipe(Effect.mapError(nativeFailure))).find(
              (candidate) => candidate.deliveryKey === input.deliveryKey,
            );
            if (
              !latest ||
              latest.context?.threadId !== delivery.context?.threadId ||
              latest.context?.providerInstanceId !== delivery.context?.providerInstanceId ||
              latest.context?.runId !== delivery.context?.runId ||
              latest.context?.nodeId !== delivery.context?.nodeId ||
              latest.context?.providerThreadId !== delivery.context?.providerThreadId ||
              latest.context?.providerTurnId !== delivery.context?.providerTurnId ||
              latest.context?.userMessageId !== delivery.context?.userMessageId ||
              (yield* assessDelivery(reselected, session.session_id, latest)).blockedReason !== null
            )
              return yield* new NativeAgentError({
                reason: "thread_changed",
                detail: "The Muse delivery changed. Refresh before releasing tracking.",
              });
            yield* native
              .releaseLocalOwnership({
                binding,
                sessionId: session.session_id,
                deliveryKey: input.deliveryKey,
              })
              .pipe(Effect.mapError(nativeFailure));
            if (delivery.context) observed.delete(delivery.context.threadId);
            return { updated: true as const };
          }),
        );
      case "connector_link": {
        const { authorizationUrl } = yield* connectors
          .linkAccount(binding, input.connectorId)
          .pipe(Effect.mapError(featureFailure));
        return { updated: true as const, authorizationUrl };
      }
      case "connector_scope_link": {
        const { authorizationUrl } = yield* connectors
          .scopeLink(binding, input.connectorId, input.method, input.accountId)
          .pipe(Effect.mapError(featureFailure));
        return { updated: true as const, authorizationUrl };
      }
      case "connector_unlink":
        yield* connectors
          .unlinkAccount(binding, input.connectorId, input.accountId)
          .pipe(Effect.mapError(featureFailure));
        break;
      case "connector_disconnect": {
        const session = yield* native.resolveSession(binding).pipe(Effect.mapError(nativeFailure));
        yield* connectors
          .disconnect(binding, input.connectorId, session.session_id)
          .pipe(Effect.mapError(featureFailure));
        break;
      }
      case "profile_save":
        yield* features
          .saveProfileDocument(binding, input.document, input.content, input.expectedRevision)
          .pipe(Effect.mapError(featureFailure));
        break;
      case "profile_set_theme":
        yield* features.setTheme(binding, input.themeId).pipe(Effect.mapError(featureFailure));
        break;
      case "task_delete":
        yield* features.deleteTask(binding, input.jobId).pipe(Effect.mapError(featureFailure));
        break;
      case "session_archive": {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const sessions = yield* native.sessions(binding).pipe(Effect.mapError(nativeFailure));
            const session = sessions.find((entry) => entry.session_id === input.sessionId);
            if (input.archived && (!session || session.is_primary))
              return yield* new NativeAgentError({
                reason: "thread_changed",
                detail: session?.is_primary
                  ? "Muse's main conversation cannot be archived."
                  : "The Muse conversation could not be found. Refresh and try again.",
              });
            const identity = yield* canonicalIdentity(selection);
            const threadId = ThreadId.make(
              museThreadIdForSession(identity, session?.is_primary ? undefined : input.sessionId),
            );
            const before = yield* projections
              .getThreadShell(threadId)
              .pipe(Effect.mapError(failure("storage_failed")));
            const assertOwned = (shell: typeof before) =>
              shell === null ||
              (shell.deletedAt === null &&
                shell.providerInstanceId === selection.instanceId &&
                shell.modelSelection.instanceId === selection.instanceId &&
                shell.modelSelection.model === "muse");
            if (!assertOwned(before))
              return yield* new NativeAgentError({ reason: "thread_changed" });
            if ((yield* selected(selection.instanceId)).binding !== binding)
              return yield* new NativeAgentError({ reason: "account_changed" });
            const priorArchived =
              session?.archived ?? (before === null ? !input.archived : before.archivedAt !== null);
            const setArchived = (archived: boolean) =>
              features.setSessionArchived(binding, input.sessionId, archived).pipe(
                Effect.catch((error) => {
                  if (error.code !== "write_uncertain") return Effect.fail(error);
                  // A lost response does not imply a failed write. Read the destination view
                  // before deciding whether the paired shell update (or compensation) can finish.
                  return features.sessions(binding, archived ? "archived" : "active").pipe(
                    Effect.flatMap((sessions) => {
                      const confirmed = sessions.find(
                        (entry) => entry.sessionId === input.sessionId,
                      );
                      return confirmed && (confirmed.archived ?? archived) === archived
                        ? Effect.void
                        : Effect.fail(error);
                    }),
                  );
                }),
                Effect.mapError(featureFailure),
              );
            // Once native state changes, finish or compensate even if the requesting client leaves.
            return yield* Effect.gen(function* () {
              yield* setArchived(input.archived);
              const synchronized = yield* Effect.gen(function* () {
                if ((yield* selected(selection.instanceId)).binding !== binding)
                  return yield* new NativeAgentError({ reason: "account_changed" });
                const shell = yield* projections
                  .getThreadShell(threadId)
                  .pipe(Effect.mapError(failure("storage_failed")));
                if (!assertOwned(shell))
                  return yield* new NativeAgentError({ reason: "thread_changed" });
                if (shell !== null && (shell.archivedAt !== null) !== input.archived) {
                  const nonce = yield* crypto.randomUUIDv4.pipe(
                    Effect.mapError(failure("storage_failed")),
                  );
                  yield* orchestrator
                    .dispatch({
                      type: input.archived ? "thread.archive" : "thread.unarchive",
                      commandId: CommandId.make(`muse-agent:archive:${nonce}`),
                      threadId,
                    })
                    .pipe(
                      Effect.provideService(Orchestrator.MuseThreadMutation, {
                        threadId,
                        operation: "archive",
                      }),
                      Effect.mapError(failure("storage_failed")),
                    );
                }
              }).pipe(Effect.exit);
              if (synchronized._tag === "Failure") {
                const recovered = yield* setArchived(priorArchived).pipe(Effect.exit);
                return yield* new NativeAgentError({
                  reason: "storage_failed",
                  detail:
                    recovered._tag === "Success"
                      ? "Muse restored the previous archive state because T3 could not update its thread. Try again."
                      : "Muse's archive state changed, but T3 could not update its thread or restore Muse. Refresh and retry the archive action to synchronize them.",
                });
              }
              return { updated: true as const };
            }).pipe(Effect.uninterruptible);
          }),
        );
      }
      case "session_rename": {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const sessions = yield* native.sessions(binding).pipe(Effect.mapError(nativeFailure));
            const session = sessions.find((entry) => entry.session_id === input.sessionId);
            if (!session)
              return yield* new NativeAgentError({
                reason: "thread_changed",
                detail: "The Muse conversation could not be found. Refresh and try again.",
              });
            if ((yield* selected(selection.instanceId)).binding !== binding)
              return yield* new NativeAgentError({ reason: "account_changed" });
            return yield* Effect.gen(function* () {
              const { title } = yield* features
                .renameSession(binding, input.sessionId, input.title)
                .pipe(
                  Effect.catch((error) => {
                    if (error.code !== "write_uncertain") return Effect.fail(featureFailure(error));
                    return native.sessions(binding).pipe(
                      Effect.mapError(nativeFailure),
                      Effect.flatMap((sessions) => {
                        const confirmed = sessions.find(
                          (entry) => entry.session_id === input.sessionId,
                        );
                        return confirmed?.title === input.title.trim()
                          ? Effect.succeed({ title: confirmed.title })
                          : Effect.fail(featureFailure(error));
                      }),
                    );
                  }),
                );
              // Muse has committed the rename. Report a partial success if local synchronization fails,
              // so callers refresh native data and can retry the same title without claiming it was lost.
              const synchronized = yield* Effect.gen(function* () {
                if ((yield* selected(selection.instanceId)).binding !== binding)
                  return yield* new NativeAgentError({ reason: "account_changed" });
                const identity = yield* canonicalIdentity(selection);
                const threadId = ThreadId.make(
                  museThreadIdForSession(
                    identity,
                    session.is_primary ? undefined : input.sessionId,
                  ),
                );
                const shell = yield* projections
                  .getThreadShell(threadId)
                  .pipe(Effect.mapError(failure("storage_failed")));
                if (
                  shell &&
                  shell.deletedAt === null &&
                  shell.providerInstanceId === selection.instanceId &&
                  shell.modelSelection.instanceId === selection.instanceId &&
                  shell.modelSelection.model === "muse"
                ) {
                  const nonce = yield* crypto.randomUUIDv4.pipe(
                    Effect.mapError(failure("storage_failed")),
                  );
                  yield* orchestrator
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`muse-agent:rename:${nonce}`),
                      threadId,
                      title,
                    })
                    .pipe(
                      Effect.provideService(Orchestrator.MuseThreadMutation, {
                        threadId,
                        operation: "rename",
                      }),
                      Effect.mapError(failure("storage_failed")),
                    );
                }
              }).pipe(Effect.exit);
              if (synchronized._tag === "Failure")
                return { updated: true as const, title, titleSyncPending: true as const };
              return { updated: true as const, title };
            }).pipe(Effect.uninterruptible);
          }),
        );
      }
    }
    return { updated: true as const };
  });
  return NativeAgentService.of({
    status,
    setup,
    profile,
    avatar,
    computerPreview,
    computerStream,
    dictationTranscribe,
    open,
    openAuthorized,
    featureRead,
    featureUpdate,
  });
});

export const layer = Layer.effect(NativeAgentService, make);
