import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  GrokBotNativeRuntimeService,
  NativeRuntimeError,
  type RuntimeFrame,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import {
  GrokBotManagedBinding,
  type GrokBotBoundSession,
  type GrokBotManagedTurn,
} from "./GrokBotManagedBinding.ts";
import { GROK_BOT_DRIVER_KIND, grokBotNativeThreadId } from "./GrokBotAdapterV2.ts";

export const accountBinding = "a".repeat(64);
export const instanceId = ProviderInstanceId.make("grok-bot-test");
export const threadId = ThreadId.make("bot-thread-test");
export const providerSessionId = ProviderSessionId.make("bot-session-test");
export const selection = { instanceId, model: "durable-bot-1" };
export const policy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
} as const;
export const nativeSession: GrokBotBoundSession = {
  binding: accountBinding,
  botId: selection.model,
  sessionId: "",
  generation: 0,
  afterUpdatedSeq: "0",
  threadId,
  providerInstanceId: instanceId,
};
export const options = {
  instanceId,
  displayName: undefined,
  enabled: true,
  environment: [],
  config: { accountBinding },
};

export const makeTurn = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const providerThread = {
    id: ProviderThreadId.make("provider-thread-fixture"),
    driver: GROK_BOT_DRIVER_KIND,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: GROK_BOT_DRIVER_KIND,
      nativeId: grokBotNativeThreadId(nativeSession),
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
  const input: ProviderAdapterV2TurnInput = {
    appThread: {
      id: threadId,
      projectId: ProjectId.make("project-test"),
      title: "Bot test",
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
    runId: RunId.make("run-test"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt-test"),
    rootNodeId: NodeId.make("root-test"),
    providerThread,
    message: {
      messageId: MessageId.make("app-message-test"),
      text: "delegate this task",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection,
    runtimePolicy: policy,
  };
  const turn: GrokBotManagedTurn = {
    native: nativeSession,
    input,
    providerTurnId: ProviderTurnId.make("provider-turn-test"),
    messageId: "persisted-native-message",
    sentAtMs: 1234,
    nativePrompt: input.message.text,
    mcpConfig: {
      mcpServers: {
        t3: {
          type: "http",
          url: "https://fixture.invalid/mcp",
          headers: { Authorization: "Bearer fixture-run-credential" },
          placement: "server",
          enabledTools: ["delegate_task", "task_status", "task_cancel"],
        },
      },
    },
  };
  return turn;
});

export const makeNative = (overrides: Partial<GrokBotNativeRuntimeService["Service"]> = {}) =>
  GrokBotNativeRuntimeService.of({
    accountBinding: Effect.succeed(accountBinding),
    usageLimits: (_binding, checkedAt) => Effect.succeed({ checkedAt, windows: [] }),
    accountInfo: () => Effect.succeed({}),
    roster: () =>
      Effect.succeed([{ agentId: selection.model, name: "Bot One", viewerIsOwner: true }]),
    sessionContext: () =>
      Effect.succeed({ bot: { agentId: selection.model, viewerIsOwner: true }, sessions: [] }),
    tasks: () => Effect.succeed([]),
    startTurn: () => Effect.succeed({ delivery: "accepted" }),
    receiveAttachments: () => Effect.die("Received attachments must be provided by the fixture."),
    uploadAttachments: () => Effect.die("Attachment uploads must be provided by the fixture."),
    sendStatus: () => Effect.succeed({ status: "not_found" }),
    interrupt: () => Effect.succeed({ hadActiveRun: true }),
    resolveAutoReviewApproval: () =>
      Effect.die("Approval responses must be provided by the fixture."),
    resolveLocalToolPermission: () =>
      Effect.die("Permission responses must be provided by the fixture."),
    resolveConnectorGrant: () => Effect.die("Connector grants must be provided by the fixture."),
    respondToWidget: () => Effect.die("Widget answers must be provided by the fixture."),
    dismissWidget: () => Effect.die("Widget dismissals must be provided by the fixture."),
    submitSecret: () => Effect.die("Secret submissions must be provided by the fixture."),
    secretRequests: () => Effect.die("Secret requests must be provided by the fixture."),
    recreateComputer: () => Effect.die("Computer recreation must be provided by the fixture."),
    resetComputer: () => Effect.die("Computer resets must be provided by the fixture."),
    computerUpgradeSchedule: () => Effect.die("Upgrade schedules must be provided by the fixture."),
    settlementSnapshot: () => Effect.succeed([]),
    watchSettlements: () => Stream.empty,
    openSettlementWatch: () => Effect.succeed({ events: Stream.never }),
    watch: () => Stream.never,
    plugins: () => Effect.die("not used"),
    upsertPlugin: () => Effect.die("not used"),
    restorePlugin: () => Effect.die("not used"),
    ensureSkill: () => Effect.fail(new NativeRuntimeError({ kind: "refused" })),
    ...overrides,
  });

export const makeBindings = (
  turn: GrokBotManagedTurn,
  overrides: Partial<GrokBotManagedBinding["Service"]> = {},
) =>
  GrokBotManagedBinding.of({
    availability: Effect.succeed({ ready: true }),
    resolve: () => Effect.succeed(nativeSession),
    prepareTurn: (request) =>
      Effect.succeed({
        ...turn,
        input: request.turn,
        nativePrompt: request.turn.message.text,
        providerTurnId: request.providerTurnId,
      }),
    accepted: () => Effect.void,
    uncertain: () => Effect.void,
    restoreTurns: () => Effect.succeed([]),
    restoreTranscriptTurns: () => Effect.succeed([]),
    restoreManagedMessageIds: () => Effect.succeed([]),
    lookupCompletion: () => Effect.succeed(undefined),
    openCompletionWatch: () => Effect.succeed(Stream.never),
    verifyInterrupt: () => Effect.void,
    recordCursor: () => Effect.void,
    release: () => Effect.void,
    ...overrides,
  });

export function rows(updatedSeq: string, text: string, streaming = true): RuntimeFrame {
  return {
    _tag: "Rows",
    generation: 0,
    replay: false,
    deletes: [],
    entries: [
      {
        seq: "1",
        updatedSeq,
        entryId: "assistant-1",
        value: {
          id: "assistant-1",
          kind: "send-message",
          message: { type: "text", content: text },
          isStreaming: streaming,
          timestampMs: 1234,
        },
      },
    ],
  };
}
