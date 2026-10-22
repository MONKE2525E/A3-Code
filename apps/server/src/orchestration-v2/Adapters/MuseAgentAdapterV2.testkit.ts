import {
  MessageId,
  DEFAULT_SERVER_SETTINGS,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Native from "../../museAgent/MuseAgentNativeRuntimeService.ts";
import * as Stream from "effect/Stream";
import { MUSE_AGENT_DRIVER_KIND } from "./MuseAgentAdapterV2Projection.ts";

export const binding = "a".repeat(64);
export const instanceId = ProviderInstanceId.make("muse-native-test");
export const threadId = ThreadId.make(
  "muse-agent:e95e6ca23067134c5f3a6110b701f50bb658347838651b8a2954ba1fc3dcabd8",
);
export const providerSessionId = ProviderSessionId.make("muse-session-test");
export const host = ProviderHost.ProviderHost.of({
  paths: {
    cwd: "/synthetic",
    baseDir: "/synthetic",
    stateDir: "/synthetic/state",
    providerStatusCacheDir: "/synthetic/cache",
    attachmentsDir: "/synthetic/attachments",
  },
  settings: {
    get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    withSnapshot: () => Effect.die("unused synthetic settings"),
    changes: Stream.empty,
    subscribe: Effect.succeed(Stream.empty),
  },
  shouldRunBackgroundWork: () => Effect.succeed(true),
  resolveAttachmentPath: () => null,
  credentials: () => Effect.die("native Muse must not read T3 credentials"),
});
export const selection = { instanceId, model: "muse" };
export const policy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
} as const;
export const options = {
  instanceId,
  displayName: undefined,
  enabled: true,
  environment: [],
  config: { accountBinding: binding },
};
export const receipt = { sessionId: "primary", messageId: "user-1", replyToMessageId: "carrier-1" };

export const makeTurn = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const providerThread = {
    id: ProviderThreadId.make("muse-provider-thread-test"),
    driver: MUSE_AGENT_DRIVER_KIND,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: MUSE_AGENT_DRIVER_KIND,
      nativeId: `${binding}/primary`,
      strength: "strong" as const,
    },
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    appThread: {
      id: threadId,
      projectId: ProjectId.make("muse-project-test"),
      title: "Synthetic Muse task",
      providerInstanceId: instanceId,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      createdBy: "user",
      creationSource: "web",
    },
    threadId,
    runId: RunId.make("muse-run-test"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("muse-attempt-test"),
    rootNodeId: NodeId.make("muse-node-test"),
    providerThread,
    message: {
      messageId: MessageId.make("muse-app-message-test"),
      text: "Synthetic task",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection,
    runtimePolicy: policy,
  } satisfies ProviderAdapterV2TurnInput;
});

export const makeNative = (
  overrides: Partial<Native.MuseAgentNativeRuntimeService["Service"]> = {},
) =>
  Native.MuseAgentNativeRuntimeService.of({
    historyOwnership: () => Effect.succeed({ receipts: [], messages: [] }),
    recordManagedMessage: () => Effect.void,
    pendingDeliveries: () => Effect.succeed([]),
    reconcilePendingDeliveries: () => Effect.succeed(false),
    releaseLocalOwnership: () => Effect.void,
    status: Effect.succeed({
      installed: true,
      sessionPresent: true,
      ready: true,
      message: "Synthetic session",
    }),
    setup: Effect.succeed({
      installed: true,
      sessionPresent: true,
      ready: true,
      message: "Synthetic session",
      accountBinding: binding,
    }),
    accountBinding: Effect.succeed(binding),
    profile: () => Effect.succeed({ id: "muse", name: "Muse" }),
    sessions: () =>
      Effect.succeed([
        { session_id: "primary", status: "idle", is_primary: true, is_thread: false },
      ]),
    resolveSession: () =>
      Effect.succeed({ session_id: "primary", status: "idle", is_primary: true, is_thread: false }),
    read: () => Effect.succeed({ events: [], hasMore: false }),
    readAttachment: () => Effect.die("Unexpected native attachment read in this fixture."),
    replay: () => Effect.succeed([]),
    send: () => Effect.succeed(receipt),
    watch: () => Effect.succeed({ events: Stream.never, close: Effect.void }),
    settleDelivery: () => Effect.void,
    stop: () => Effect.void,
    acquireTurn: () => Effect.succeed(Effect.void),
    connectionId: () => Effect.succeed("generation-1"),
    registerTools: (_, registration) =>
      Effect.succeed({
        accepted: Object.keys(registration.commands).length,
        connectionId: registration.connectionId,
      }),
    unregisterTools: () => Effect.void,
    ...overrides,
  });
