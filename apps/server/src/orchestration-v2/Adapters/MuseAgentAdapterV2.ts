// @effect-diagnostics-next-line nodeBuiltinImport:off -- Muse device-backed client IDs use the paired-device UUID format.
import * as NodeCrypto from "node:crypto";
import {
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type { MuseAgentProviderSettings } from "@t3tools/contracts/museAgent";
import type { ProviderDriverCreateInput } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import { museAgentHistoryPage } from "../../museAgent/MuseAgentHistoryPage.ts";
import * as Native from "../../museAgent/MuseAgentNativeRuntimeService.ts";
import * as Transport from "../../museAgent/MuseAgentTransport.ts";
import { importMuseAttachmentPresentation } from "../../museAgent/MuseAgentAttachmentImport.ts";
import * as DirectToolsPort from "../../museAgent/MuseAgentDirectToolsPort.ts";
import {
  museSessionOfThread,
  museThreadIdForSession,
  museThreadIdentity,
} from "../../museAgent/MuseAgentThreadIds.ts";
import { NativeAgentDirectToolsError } from "../../mcp/direct/NativeAgentDirectTools.ts";
import {
  MUSE_AGENT_DRIVER_KIND,
  makeMuseAgentProjection,
  museHistoryFrame,
} from "./MuseAgentAdapterV2Projection.ts";

export { MUSE_AGENT_DRIVER_KIND };
const managedMusePrompt = (text: string) =>
  `${text}\n\n[T3 Code: use this message's T3 node for tools; call the user Monke.]`;

export type MuseAgentAdapterV2DriverEnv =
  | Native.MuseAgentNativeRuntimeService
  | DirectToolsPort.MuseAgentDirectToolsPort
  | ProviderHost.ProviderHost;
export const MuseAgentCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: false,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: false,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "client-boundary" },
} satisfies OrchestrationV2ProviderCapabilities;

export const createMuseAgentAdapterV2 = Effect.fnUntraced(function* (
  options: ProviderDriverCreateInput<MuseAgentProviderSettings>,
) {
  const native = yield* Native.MuseAgentNativeRuntimeService;
  const toolsPort = yield* DirectToolsPort.MuseAgentDirectToolsPort;
  const host = yield* ProviderHost.ProviderHost;
  const attachmentImports = yield* Semaphore.make(2);
  const capabilities = MuseAgentCapabilitiesV2;
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: MUSE_AGENT_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: ({ current, target }) =>
      Effect.succeed(
        current.instanceId === target.instanceId &&
          current.model === target.model &&
          !target.options?.length
          ? { type: "apply_on_next_turn" as const }
          : {
              type: "reject" as const,
              reason: "A native Muse conversation cannot change account or accept model options.",
            },
      ),
    openSession: (input) =>
      Effect.gen(function* () {
        const binding = options.config.accountBinding;
        const validateSelection = (
          selection: typeof input.modelSelection,
          policy: typeof input.runtimePolicy,
        ) =>
          options.enabled &&
          binding &&
          selection.instanceId === options.instanceId &&
          selection.model === "muse" &&
          !selection.options?.length &&
          policy.runtimeMode === "full-access" &&
          policy.interactionMode === "default"
            ? Effect.void
            : Effect.fail(new Native.MuseAgentRuntimeError({ kind: "unsupported" }));
        yield* validateSelection(input.modelSelection, input.runtimePolicy);
        if (!binding || (yield* native.accountBinding) !== binding)
          return yield* new Native.MuseAgentRuntimeError({ kind: "account_changed" });
        const sessionId = yield* Effect.try({
          try: () => {
            const sessionId = museSessionOfThread(input.threadId);
            const identity = museThreadIdentity(binding, options.instanceId);
            if (input.threadId !== museThreadIdForSession(identity, sessionId))
              throw new Error("noncanonical_muse_thread");
            return sessionId;
          },
          catch: () => new Native.MuseAgentRuntimeError({ kind: "unsupported" }),
        });
        const session = yield* native.resolveSession(binding, sessionId);
        const ownership = yield* native.historyOwnership({
          binding,
          sessionId: session.session_id,
          threadId: input.threadId,
          providerInstanceId: options.instanceId,
        });
        const projection = makeMuseAgentProjection({
          binding,
          providerInstanceId: options.instanceId,
          sessionId: session.session_id,
          threadId: input.threadId,
          ownership,
        });
        const now = yield* DateTime.now;
        const thread: OrchestrationV2ProviderThread = {
          id: IdAllocator.derive.providerThread({
            driver: MUSE_AGENT_DRIVER_KIND,
            providerInstanceId: options.instanceId,
            nativeThreadId: projection.nativeThreadId,
          }),
          driver: MUSE_AGENT_DRIVER_KIND,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          appThreadId: input.threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: MUSE_AGENT_DRIVER_KIND,
            nativeId: projection.nativeThreadId,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const assertThread = (candidate: OrchestrationV2ProviderThread) =>
          candidate.driver === MUSE_AGENT_DRIVER_KIND &&
          candidate.providerInstanceId === options.instanceId &&
          candidate.appThreadId === input.threadId &&
          candidate.nativeThreadRef?.nativeId === projection.nativeThreadId &&
          candidate.nativeThreadRef.driver === MUSE_AGENT_DRIVER_KIND
            ? Effect.void
            : Effect.fail(new Native.MuseAgentRuntimeError({ kind: "account_changed" }));
        const providerSession = {
          id: input.providerSessionId,
          driver: MUSE_AGENT_DRIVER_KIND,
          providerInstanceId: options.instanceId,
          status: "ready" as const,
          cwd: input.runtimePolicy.cwd ?? ".",
          model: "muse",
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const inbox = yield* Queue.unbounded<
          ProviderAdapter.ProviderAdapterV2Event,
          ProviderAdapter.ProviderAdapterV2Error | Cause.Done
        >();
        yield* Effect.addFinalizer(() => Queue.shutdown(inbox));
        yield* Queue.offerAll(inbox, projection.restore());
        let watch = yield* native.watch({ binding, sessionId: session.session_id });
        const ownerScope = yield* Effect.scope;
        yield* Effect.addFinalizer(() => watch.close);
        let turnRelease: Effect.Effect<void> | undefined;
        let toolCleanup = Effect.void;
        let toolLifetime:
          | {
              readonly scope: Scope.Closeable;
              readonly clientId: string;
              close: Effect.Effect<void>;
              revoke: Effect.Effect<void>;
            }
          | undefined;
        const closeTools = Effect.gen(function* () {
          const current = toolLifetime;
          toolLifetime = undefined;
          if (!current) return;
          const cleaned = Deferred.makeUnsafe<void>();
          toolCleanup = Deferred.await(cleaned);
          yield* current.revoke.pipe(
            Effect.ensuring(
              current.close.pipe(
                Effect.ensuring(Scope.close(current.scope, Exit.void)),
                Effect.ensuring(Deferred.succeed(cleaned, undefined)),
                Effect.forkDetach,
              ),
            ),
          );
        });
        const releaseTurn = Effect.gen(function* () {
          yield* closeTools;
          const release = turnRelease;
          turnRelease = undefined;
          if (release) yield* toolCleanup.pipe(Effect.ensuring(release), Effect.forkDetach);
        });
        yield* Effect.addFinalizer(() => releaseTurn);
        const publish = (batch: readonly ProviderAdapter.ProviderAdapterV2Event[]) =>
          Effect.gen(function* () {
            for (const event of batch) {
              if (
                event.type === "turn_item.updated" &&
                event.turnItem.type === "assistant_message" &&
                event.turnItem.nativeItemRef?.driver === MUSE_AGENT_DRIVER_KIND &&
                event.turnItem.nativeItemRef.nativeId
              ) {
                const key = projection.deliveryForMessage(event.turnItem.nativeItemRef.nativeId);
                if (!key) continue;
                const item = event.turnItem;
                const message = batch.find(
                  (candidate) =>
                    candidate.type === "message.updated" && candidate.message.id === item.messageId,
                );
                if (message?.type === "message.updated")
                  yield* native.recordManagedMessage({
                    binding,
                    sessionId: session.session_id,
                    deliveryKey: key,
                    nativeMessageId: event.turnItem.nativeItemRef.nativeId,
                    snapshot: { message: message.message, turnItem: event.turnItem },
                  });
              }
            }
            // Native terminal proof is persisted before publishing terminal to orchestration.
            if (batch.some((event) => event.type === "turn.terminal")) {
              const key = projection.deliveryKey();
              if (key) yield* native.settleDelivery(key);
              yield* releaseTurn;
            }
            yield* Queue.offerAll(inbox, batch);
          });
        const projectFrame = (
          frame: Transport.MuseAgentNativeEvent,
          captured = projection.capturePresentation(frame),
        ) =>
          Effect.gen(function* () {
            const refreshOwnership = () =>
              Effect.gen(function* () {
                const nativeMessageId = projection.unknownAssistantIdentity(frame);
                if (frame.event !== "message.user" && nativeMessageId === undefined) return;
                const fresh = yield* native.historyOwnership(
                  {
                    binding,
                    sessionId: session.session_id,
                    threadId: input.threadId,
                    providerInstanceId: options.instanceId,
                  },
                  {
                    awaitAdmissions: true,
                    ...(nativeMessageId === undefined
                      ? { receiptsOnly: true }
                      : { nativeMessageId }),
                  },
                );
                yield* Effect.try({
                  try: () => projection.retainOwnedAssistantAssociations(fresh),
                  catch: (cause) => new Native.MuseAgentRuntimeError({ kind: "protocol", cause }),
                });
                // Receipts can precede the sibling's first assistant snapshot.
                projection.unknownAssistantIdentity(frame);
              });
            yield* refreshOwnership();
            if (!projection.canImportPresentation(frame, captured)) return 0;
            const imported = yield* frame.event === "delta.presentation"
              ? importMuseAttachmentPresentation({
                  binding,
                  sessionId: session.session_id,
                  threadId: input.threadId,
                  attachmentsDir: host.paths.attachmentsDir,
                  frame,
                  readAttachment: native.readAttachment,
                }).pipe(attachmentImports.withPermits(1))
              : Effect.succeed(null);
            // Attachment IO can outlive a sibling's durable ownership write.
            if (imported) yield* refreshOwnership();
            if (!projection.canImportPresentation(frame, captured)) return 0;
            const batch = yield* Effect.try({
              try: () => {
                const attached = imported
                  ? projection.attach(imported.nativeMessageId, imported.attachments)
                  : [];
                return [
                  ...attached,
                  ...projection.project(frame, captured),
                  ...(imported?.failed
                    ? projection.attachmentFailed(imported.nativeMessageId)
                    : []),
                ];
              },
              catch: (cause) => new Native.MuseAgentRuntimeError({ kind: "protocol", cause }),
            });
            yield* publish(batch);
            return batch.filter((event) => event.type === "message.updated").length;
          });
        // The native route has one observer. Retire displaced runtimes so reopening
        // their conversation subscribes again and repairs history through a fresh session.
        let retired = false;
        const runWatch = (currentWatch: typeof watch) => {
          let superseded = false;
          return currentWatch.events.pipe(
            Stream.runForEach((frame) =>
              Effect.gen(function* () {
                if (frame.event === "transport.session_superseded") {
                  superseded = true;
                  return;
                }
                if (frame.event === "transport.turn_superseded") {
                  const batch = projection.project(frame);
                  if (!batch.some((event) => event.type === "turn.terminal")) return;
                  yield* publish(batch);
                  yield* Queue.offer(inbox, {
                    type: "provider_session.updated",
                    driver: MUSE_AGENT_DRIVER_KIND,
                    providerSession: {
                      ...providerSession,
                      status: "waiting",
                      updatedAt: yield* DateTime.now,
                      lastError: "Another native Muse message interrupted this managed turn.",
                    },
                  });
                  return;
                }
                if (
                  frame.event === "transport.disconnected" ||
                  frame.event === "transport.reconnected"
                ) {
                  // Reconnecting cannot inherit an earlier connection's tool authority.
                  yield* closeTools;
                  yield* Queue.offer(inbox, {
                    type: "provider_session.updated",
                    driver: MUSE_AGENT_DRIVER_KIND,
                    providerSession: {
                      ...providerSession,
                      status: frame.event === "transport.disconnected" ? "waiting" : "ready",
                      updatedAt: yield* DateTime.now,
                      lastError:
                        frame.event === "transport.disconnected"
                          ? "Muse connection lost. The native turn remains unsettled."
                          : null,
                    },
                  });
                  const receipt = projection.receipt();
                  if (
                    frame.event === "transport.reconnected" &&
                    receipt &&
                    !projection.isTerminal()
                  ) {
                    for (const raw of yield* native.replay({ binding, receipt })) {
                      const replayed = museHistoryFrame(raw, session.session_id);
                      if (replayed) yield* projectFrame(replayed);
                    }
                  }
                  return;
                }
                if (frame.event === "delta.presentation") {
                  // A file transfer must not hold up turn ownership or stop events.
                  // Imported metadata joins its stable message only after persistence.
                  yield* projectFrame(frame).pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Muse attachment presentation could not be projected."),
                    ),
                    Effect.forkScoped,
                  );
                } else yield* projectFrame(frame);
              }),
            ),
            Effect.andThen(
              Effect.suspend(() =>
                superseded
                  ? Effect.gen(function* () {
                      retired = true;
                      yield* releaseTurn;
                      yield* Queue.offer(inbox, {
                        type: "provider_session.updated",
                        driver: MUSE_AGENT_DRIVER_KIND,
                        providerSession: {
                          ...providerSession,
                          status: "stopped",
                          updatedAt: yield* DateTime.now,
                        },
                      });
                      yield* Queue.end(inbox);
                    })
                  : Effect.fail(new Native.MuseAgentRuntimeError({ kind: "protocol" })),
              ),
            ),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEventStreamError({
                  driver: MUSE_AGENT_DRIVER_KIND,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                ? releaseTurn
                : Effect.void,
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : Queue.failCause(inbox, cause),
            ),
            Effect.provideService(Scope.Scope, ownerScope),
            Effect.forkIn(ownerScope),
          );
        };
        let watchFiber = yield* runWatch(watch);
        // Subscribe first; history then repairs gaps without losing events between read and watch.
        const historyLock = yield* Semaphore.make(1);
        const importPage = (
          page: { readonly events: readonly unknown[]; readonly hasMore: boolean },
          beforeSeq?: number,
        ) =>
          Effect.gen(function* () {
            const parsed = yield* Effect.try({
              try: () => museAgentHistoryPage(page, session.session_id, beforeSeq),
              catch: (cause) => new Native.MuseAgentRuntimeError({ kind: "protocol", cause }),
            });
            let importedMessages = 0;
            for (const frame of parsed.frames) importedMessages += yield* projectFrame(frame);
            return {
              nextBeforeSeq: parsed.nextBeforeSeq,
              hasMore: parsed.hasMore,
              importedMessages,
            };
          });
        let historyCursor = yield* importPage(
          yield* native.read({ binding, sessionId: session.session_id }),
        );
        return {
          instanceId: options.instanceId,
          driver: MUSE_AGENT_DRIVER_KIND,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromQueue(inbox),
          loadHistoryPage: (request) =>
            historyLock
              .withPermit(
                Effect.gen(function* () {
                  if (
                    request.threadId !== input.threadId ||
                    (yield* native.accountBinding) !== binding
                  )
                    return yield* new Native.MuseAgentRuntimeError({ kind: "account_changed" });
                  if (request.beforeSeq === undefined)
                    return { ...historyCursor, importedMessages: 0 };
                  if (!historyCursor.hasMore || request.beforeSeq !== historyCursor.nextBeforeSeq)
                    return yield* new Native.MuseAgentRuntimeError({ kind: "unsupported" });
                  const page = yield* native.read({
                    binding,
                    sessionId: session.session_id,
                    beforeSeq: request.beforeSeq,
                  });
                  if ((yield* native.accountBinding) !== binding)
                    return yield* new Native.MuseAgentRuntimeError({ kind: "account_changed" });
                  const next = yield* importPage(page, request.beforeSeq);
                  historyCursor = next;
                  return next;
                }),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver: MUSE_AGENT_DRIVER_KIND,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              ),
          ensureThread: (request) =>
            Effect.gen(function* () {
              if (request.threadId !== input.threadId)
                return yield* new Native.MuseAgentRuntimeError({ kind: "account_changed" });
              const existing = request.existingProviderThread;
              if (!existing) return thread;
              if (
                !existing.nativeThreadRef &&
                existing.status === "not_loaded" &&
                existing.driver === MUSE_AGENT_DRIVER_KIND &&
                existing.providerInstanceId === options.instanceId &&
                existing.appThreadId === input.threadId
              )
                return { ...thread, id: existing.id };
              yield* assertThread(existing);
              return { ...existing, providerSessionId: input.providerSessionId };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: MUSE_AGENT_DRIVER_KIND,
                    threadId: request.threadId,
                    cause,
                  }),
              ),
            ),
          resumeThread: (request) =>
            assertThread(request.providerThread).pipe(
              Effect.as({ ...request.providerThread, providerSessionId: input.providerSessionId }),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterResumeThreadError({
                    driver: MUSE_AGENT_DRIVER_KIND,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: request.providerThread.id,
                    cause,
                  }),
              ),
            ),
          injectHistory: () => Effect.succeed(false),
          startTurn: (request) => {
            let admissionAttempted = false;
            return Effect.gen(function* () {
              yield* assertThread(request.providerThread);
              yield* validateSelection(request.modelSelection, request.runtimePolicy);
              if (request.threadId !== input.threadId)
                return yield* new Native.MuseAgentRuntimeError({ kind: "unsupported" });
              yield* Effect.uninterruptibleMask((restore) =>
                restore(native.acquireTurn(binding, session.session_id)).pipe(
                  Effect.map((release) => {
                    turnRelease = release;
                  }),
                ),
              );
              yield* Fiber.interrupt(watchFiber);
              // Admission can wait while another conversation retires this observer.
              // Awaiting interruption fences every old watcher before installing its replacement.
              if (retired) return yield* new Native.MuseAgentRuntimeError({ kind: "busy" });
              yield* watch.close;
              watch = yield* native.watch({ binding, sessionId: session.session_id });
              watchFiber = yield* runWatch(watch);
              const providerTurnId = yield* Effect.try({
                try: () => projection.begin(request),
                catch: (cause) => new Native.MuseAgentRuntimeError({ kind: "busy", cause }),
              });
              if (projection.isTerminal()) {
                yield* releaseTurn;
                return;
              }
              if (!toolLifetime) {
                const access = yield* host.settings.get.pipe(
                  Effect.map(
                    (all) => resolveProjectSettings(all, request.appThread.projectId).settings,
                  ),
                  Effect.map((effective) => ({
                    browser: effective.enableAgentBrowserAccess,
                    device: effective.enableAgentDeviceAccess,
                  })),
                  Effect.orElseSucceed(() => ({ browser: false, device: false })),
                );
                const toolCapabilities = new Set<McpCapability>([
                  "orchestration",
                  "worktree",
                  "pull-requests",
                ]);
                if (access.browser) toolCapabilities.add("preview");
                if (access.device) toolCapabilities.add("device");
                const connectionId = yield* native.connectionId(binding);
                const toolScope = yield* Scope.make();
                const clientId = NodeCrypto.randomUUID();
                const pendingLifetime = {
                  scope: toolScope,
                  clientId,
                  close: Effect.void,
                  revoke: Effect.void,
                };
                toolLifetime = pendingLifetime;
                const starting = yield* toolsPort
                  .start({
                    threadId: input.threadId,
                    providerInstanceId: options.instanceId,
                    remoteRun: { runId: request.runId, attemptId: request.attemptId },
                    accountBinding: binding,
                    nativeSessionId: session.session_id,
                    connectionId,
                    browserToolsAvailable: access.browser,
                    capabilities: toolCapabilities,
                    isCurrent: Effect.gen(function* () {
                      if (
                        toolLifetime !== pendingLifetime ||
                        !projection.matchesTurn(providerTurnId) ||
                        (yield* native.accountBinding) !== binding
                      )
                        return false;
                      const current = yield* native.resolveSession(binding, session.session_id);
                      return (
                        current.session_id === session.session_id &&
                        toolLifetime === pendingLifetime &&
                        projection.matchesTurn(providerTurnId)
                      );
                    }).pipe(Effect.orElseSucceed(() => false)),
                    register: (commands, invoke) =>
                      native
                        .registerTools(binding, {
                          clientId,
                          connectionId,
                          nativeSessionId: session.session_id,
                          commands,
                          invoke: (invocation) =>
                            invoke(invocation).pipe(
                              Effect.mapError(
                                (cause) =>
                                  new Transport.MuseAgentTransportError({
                                    kind: "protocol",
                                    cause,
                                  }),
                              ),
                            ),
                        })
                        .pipe(
                          Effect.map((result) => ({
                            ...result,
                            close: native.unregisterTools(binding, clientId),
                          })),
                          Effect.mapError(
                            () => new NativeAgentDirectToolsError({ code: "registration_failed" }),
                          ),
                          Effect.onExit((exit) =>
                            Exit.isFailure(exit)
                              ? native.unregisterTools(binding, clientId)
                              : Effect.void,
                          ),
                        ),
                  })
                  .pipe(Effect.provideService(Scope.Scope, toolScope), Effect.forkIn(toolScope));
                const tools = yield* Fiber.join(starting);
                if (toolLifetime !== pendingLifetime)
                  return yield* new Native.MuseAgentRuntimeError({ kind: "busy" });
                pendingLifetime.close = tools.close;
                pendingLifetime.revoke = tools.revoke;
              }
              admissionAttempted = true;
              const receipt = yield* native.send({
                binding,
                sessionId: session.session_id,
                deliveryKey: request.attemptId,
                text: managedMusePrompt(request.message.text),
                clientId: toolLifetime.clientId,
                context: {
                  threadId: request.threadId,
                  providerInstanceId: options.instanceId,
                  runId: request.runId,
                  nodeId: request.rootNodeId,
                  providerThreadId: request.providerThread.id,
                  providerTurnId,
                  userMessageId: request.message.messageId,
                },
                ...(request.message.attachments.length
                  ? {
                      attachments: {
                        directory: host.paths.attachmentsDir,
                        items: request.message.attachments,
                      },
                    }
                  : {}),
              });
              yield* publish(projection.admit(receipt));
              if (receipt.replayed && !projection.isTerminal()) {
                for (const raw of yield* native.replay({ binding, receipt })) {
                  const replayed = museHistoryFrame(raw, session.session_id);
                  if (replayed) yield* projectFrame(replayed);
                }
              }
            }).pipe(
              Effect.onError(() =>
                Effect.sync(() => projection.abandonAdmission()).pipe(Effect.andThen(releaseTurn)),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: MUSE_AGENT_DRIVER_KIND,
                    threadId: request.threadId,
                    providerThreadId: request.providerThread.id,
                    runId: request.runId,
                    cause: admissionAttempted
                      ? cause
                      : new ProviderAdapter.ProviderPromptNotSubmittedError({ cause }),
                  }),
              ),
            );
          },
          steerTurn: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                driver: MUSE_AGENT_DRIVER_KIND,
                providerThreadId: request.providerThread.id,
              }),
            ),
          interruptTurn: (request) =>
            Effect.gen(function* () {
              yield* assertThread(request.providerThread);
              const deliveryKey = projection.deliveryKey();
              if (!deliveryKey || !projection.matchesTurn(request.providerTurnId))
                return yield* new Native.MuseAgentRuntimeError({ kind: "unsupported" });
              yield* closeTools;
              yield* native.stop({ binding, sessionId: session.session_id, deliveryKey });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: MUSE_AGENT_DRIVER_KIND,
                    providerThreadId: request.providerThread.id,
                    providerTurnId: request.providerTurnId,
                    cause,
                  }),
              ),
            ),
          respondToRuntimeRequest: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: MUSE_AGENT_DRIVER_KIND,
                requestId: request.requestId,
              }),
            ),
          readThreadSnapshot: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                driver: MUSE_AGENT_DRIVER_KIND,
                providerThreadId: request.providerThread.id,
              }),
            ),
          rollbackThread: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: MUSE_AGENT_DRIVER_KIND,
                providerThreadId: request.providerThread.id,
              }),
            ),
          forkThread: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: MUSE_AGENT_DRIVER_KIND,
                providerThreadId: request.sourceProviderThread.id,
              }),
            ),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: MUSE_AGENT_DRIVER_KIND,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  });
});
