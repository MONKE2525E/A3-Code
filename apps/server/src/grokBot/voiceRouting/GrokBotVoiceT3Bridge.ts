import {
  MessageId,
  RunId,
  ThreadId,
  type GrokBotVoiceChatContext,
  type GrokBotVoiceToolResult,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as GrokBotThreadService from "../GrokBotThreadService.ts";
import * as Direct from "./GrokBotVoiceOrchestration.ts";

/**
 * Tools the native voice harness defines itself, read from the official desktop bundle
 * (`yB.all()` in the main-process harness). `send_task` relays work to the bot's native agent
 * on the desktop, which is the execution path voice calls must not use; the rest only steer
 * the conversation and stay native.
 */
const NATIVE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(["send_task"]);
const NATIVE_CONTROL_TOOLS: ReadonlySet<string> = new Set(["end_the_call", "stay_silent"]);

const T3_RUN_TASK = "t3_run_task";
export const T3_TASK_PROGRESS = "t3_task_progress";
export const T3_CHAT_UPDATES = "t3_chat_updates";

interface VoiceToolDescriptor {
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** The T3 tools a voice session gets. Shapes mirror the native descriptors: a JSON-schema object. */
export const T3_VOICE_TOOLS: ReadonlyArray<VoiceToolDescriptor> = [
  {
    type: "function",
    name: "recall_text_messages",
    description:
      "Read recent written messages in this bot's canonical T3 chat, including messages imported from its native chat. This reads current history, including messages sent during this call.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "search_conversations",
    description:
      "Search this bot's canonical T3 chat history, including imported native chat. Returns actual matching messages. Only this bot's chat in this T3 environment is searched.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, index: { type: "integer", minimum: 0 } },
      required: ["query"],
    },
  },
  ...Direct.tools,
];

/** Execution belongs to this call; independent threads still require an explicit request. */
export const T3_VOICE_INSTRUCTIONS =
  "Use the T3 orchestration functions on this call directly. Delegate work with delegate_task, choosing models from orchestrator_capabilities; use task_status and task_cancel for this call’s tasks. Completed delegated work is delivered back to this live call automatically. This call has approval-required permissions. send_task and t3_run_task are disabled. Use t3_thread_launch only when the caller requests independent work in a new thread. Recall and search read this bot’s canonical chat in this T3 environment.";

/**
 * A session's tools are an allowlist: only native conversation controls (plain `function` tools by
 * name) survive, then the T3 tools are appended. Anything else native returns is dropped, notably
 * `mcp`-type entries (a connector the realtime model would call directly, outside this server,
 * e.g. another T3 install) and any other T3-looking or execution tool.
 */
export const routeSessionTools = (
  native: ReadonlyArray<VoiceToolDescriptor>,
): ReadonlyArray<VoiceToolDescriptor> => [
  ...native.filter(
    (tool) =>
      tool.type === "function" &&
      NATIVE_CONTROL_TOOLS.has(tool.name) &&
      !T3_VOICE_TOOLS.some((local) => local.name === tool.name),
  ),
  ...T3_VOICE_TOOLS,
];

export const withT3Instructions = (instructions: string) =>
  `${instructions}\n\n${T3_VOICE_INSTRUCTIONS}`;

/**
 * Whether the voice service must answer a tool locally. `send_task` is included so a model that
 * still calls it is refused here instead of reaching native execution.
 */
export const isRoutedLocally = (name: string) =>
  Direct.isTool(name) ||
  name === T3_TASK_PROGRESS ||
  name === T3_RUN_TASK ||
  name === T3_CHAT_UPDATES ||
  NATIVE_EXECUTION_TOOLS.has(name) ||
  T3_VOICE_TOOLS.some((tool) => tool.name === name);

/** The only names forwarded to native; every other name is refused locally as an unknown tool. */
export const isNativeControl = (name: string) => NATIVE_CONTROL_TOOLS.has(name);

/** What the voice RPC's own principal allows; the model never supplies it. */
export type VoiceAccess = "read" | "operate";

export interface VoiceToolCall {
  /** The account binding and bot the call was opened for. */
  readonly binding: string;
  readonly botId: string;
  /** The T3 call id, so a reused realtime tool call id in another call is not deduplicated. */
  readonly callId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
  readonly access: VoiceAccess;
}

export type VoiceToolOutcome = typeof GrokBotVoiceToolResult.Type;

const decodeCompletionRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    requestToolCallId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
);
const decodeChatWait = Schema.decodeUnknownEffect(
  Schema.Struct({
    afterSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
);
const decodeSearch = Schema.decodeUnknownEffect(
  Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    index: Schema.optionalKey(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
);
type ChatContext = typeof GrokBotVoiceChatContext.Type;

// Transcripts are already stripped of managed prompt footers by the adapter. Keep only visible
// conversation text; never expose system messages, runtime requests, notifications, or tool data.
const chatMessage = (
  message: OrchestrationV2ConversationMessage,
): ChatContext["messages"][number] | undefined => {
  if (
    (message.role !== "user" && message.role !== "assistant") ||
    message.grokBotPeer !== undefined ||
    message.senderThreadId !== undefined ||
    (message.role === "user" &&
      (message.createdBy !== "user" || message.creationSource === "mcp")) ||
    message.voiceRequest === true ||
    message.grokBotVoiceUtterance === true ||
    message.scheduledTaskId !== undefined ||
    message.notification !== undefined ||
    message.streaming ||
    !message.text.trim()
  )
    return undefined;
  return { id: message.id, role: message.role, text: message.text.slice(0, 4_000) };
};
const boundedChat = (messages: readonly OrchestrationV2ConversationMessage[]) => {
  const visible: ChatContext["messages"][number][] = [];
  let remaining = 16_000;
  for (const message of messages.toReversed()) {
    const row = chatMessage(message);
    if (row === undefined) continue;
    if (remaining === 0 || visible.length === 40) break;
    const text = row.text.slice(0, remaining);
    remaining -= text.length;
    visible.unshift({ ...row, text });
  }
  return visible;
};

const spoken = (text: string) => ({ kind: "served", output: { spoken: text } }) as const;

export class GrokBotVoiceT3Bridge extends Context.Service<
  GrokBotVoiceT3Bridge,
  {
    readonly activate: (input: {
      readonly binding: string;
      readonly botId: string;
      readonly callId: string;
    }) => Effect.Effect<void>;
    readonly call: (input: VoiceToolCall) => Effect.Effect<VoiceToolOutcome>;
    readonly forget: (callId: string) => Effect.Effect<void>;
    readonly context: (botId: string) => Effect.Effect<ChatContext | undefined>;
  }
>()("t3/grokBot/voiceRouting/GrokBotVoiceT3Bridge") {}

const progressText = (run: { status: string } | undefined) =>
  run === undefined
    ? "No T3 work has been started for this bot yet."
    : `The latest T3 run is ${run.status}.`;

const make = Effect.gen(function* () {
  const threads = yield* GrokBotThreadService.GrokBotThreadService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const direct = yield* Effect.serviceOption(Direct.GrokBotVoiceOrchestration);
  const callThreads = new Map<string, { binding: string; botId: string; threadId: ThreadId }>();
  const launchReceipts = new Map<string, { callId: string; result: VoiceToolOutcome }>();
  // Targets come only from accepted MCP results, never from model-supplied ids.
  const pending = new Map<
    string,
    {
      callId: string;
      target: Direct.VoiceWorkTarget;
      at: number;
      receipt: VoiceToolOutcome;
    }
  >();
  const key = (input: VoiceToolCall, toolCallId = input.toolCallId) =>
    JSON.stringify([input.binding, input.botId, input.callId, toolCallId]);

  const canonical = (botId: string) =>
    threads.open({ botId }).pipe(Effect.map((opened) => ThreadId.make(opened.threadId)));
  const canonicalForCall = (input: { binding: string; botId: string; callId: string }) => {
    const prior = callThreads.get(input.callId);
    return prior?.binding === input.binding && prior.botId === input.botId
      ? Effect.succeed(prior.threadId)
      : canonical(input.botId).pipe(
          Effect.tap((threadId) =>
            Effect.sync(() => {
              callThreads.set(input.callId, {
                binding: input.binding,
                botId: input.botId,
                threadId,
              });
            }),
          ),
        );
  };
  const context = (botId: string) =>
    Effect.gen(function* () {
      const threadId = yield* canonical(botId);
      yield* threadManagement.ensureLegacyTranscript(threadId);
      const snapshot = yield* threadManagement.getThreadSnapshotWindow(threadId, {
        rowLimit: 40,
        userTurnLimit: 20,
      });
      return {
        afterSequence: snapshot.snapshotSequence,
        messages: boundedChat(snapshot.projection.messages),
      };
    }).pipe(Effect.orElseSucceed(() => undefined));

  const recall = (input: VoiceToolCall) =>
    context(input.botId).pipe(
      Effect.map((chat) =>
        chat === undefined
          ? spoken("T3 chat history is unavailable right now.")
          : ({ kind: "served", output: { messages: chat.messages } } as const),
      ),
    );

  const search = (input: VoiceToolCall) =>
    Effect.gen(function* () {
      const parsed = yield* decodeSearch(input.input).pipe(Effect.option);
      if (parsed._tag === "None")
        return { kind: "invalid_input", output: { error: "invalid search arguments" } } as const;
      const threadId = yield* canonical(input.botId);
      const found = yield* threadManagement.searchThread({
        threadId,
        query: parsed.value.query,
        ...(parsed.value.index === undefined ? {} : { index: parsed.value.index }),
      });
      if (found.match === null)
        return {
          kind: "served",
          output: { messages: [], totalMatches: found.totalMatches },
        } as const;
      const records = yield* threadManagement.getThreadRecords(threadId, ["messages"], {
        messageIds: [MessageId.make(found.match.entryId)],
        messageRoles: ["user", "assistant"],
      });
      const messages = records.messages.flatMap((message) => {
        const visible = chatMessage(message);
        return visible === undefined ? [] : [visible];
      });
      return {
        kind: "served",
        output: { messages, totalMatches: found.totalMatches, index: found.activeIndex },
      } as const;
    }).pipe(Effect.orElseSucceed(() => spoken("T3 chat search is unavailable right now.")));

  const chatUpdates = (input: VoiceToolCall) =>
    Effect.gen(function* () {
      const parsed = yield* decodeChatWait(input.input).pipe(Effect.option);
      if (parsed._tag === "None")
        return { kind: "invalid_input", output: { error: "invalid chat cursor" } } as const;
      const threadId = yield* canonical(input.botId);
      const event = yield* threadManagement
        .streamStoredEventsFrom({
          threadId,
          afterSequence: parsed.value.afterSequence,
          eventType: "message.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "message.updated" &&
              stored.event.payload.role === "user" &&
              stored.event.payload.createdBy === "user" &&
              stored.event.payload.creationSource !== "mcp" &&
              stored.event.payload.voiceRequest !== true &&
              chatMessage(stored.event.payload) !== undefined,
          ),
          Stream.runHead,
          Effect.timeoutOption(Duration.seconds(20)),
          Effect.map(Option.flatten),
        );
      const stored = Option.getOrUndefined(event);
      return {
        kind: "served",
        output: null,
        chatContext: {
          afterSequence: stored?.sequence ?? parsed.value.afterSequence,
          messages:
            stored?.event.type === "message.updated" ? [chatMessage(stored.event.payload)!] : [],
        },
      } as const;
    }).pipe(
      Effect.orElseSucceed(
        () => ({ kind: "invalid_input", output: { error: "chat updates unavailable" } }) as const,
      ),
    );

  /** Reads only run status from the bot's own canonical thread; no MCP scope is involved. */
  const progress = (input: VoiceToolCall) =>
    Effect.gen(function* () {
      // This branch is the client's long wait over the existing voice RPC. It is not a
      // model tool or a new dispatch; normal progress calls still report status below.
      const requested = yield* decodeCompletionRequest(input.input).pipe(Effect.option);
      if (requested._tag === "Some") {
        const requestToolCallId = requested.value.requestToolCallId;
        const target = pending.get(key(input, requestToolCallId));
        if (target === undefined)
          return { kind: "invalid_input", output: { error: "unknown voice request" } } as const;
        if ("taskId" in target.target) {
          if (Option.isNone(direct))
            return {
              kind: "invalid_input",
              output: { error: "voice request unavailable" },
            } as const;
          const result = yield* direct.value.wait({ ...input, taskId: target.target.taskId });
          // Ending a call removes the entry while its wait is in flight.
          if (pending.get(key(input, requestToolCallId)) !== target)
            return { kind: "invalid_input", output: { error: "unknown voice request" } } as const;
          return {
            ...result.result,
            ...(result.result.kind === "served"
              ? { completion: { requestToolCallId, pending: result.pending } }
              : {}),
          };
        }
        const threadId = ThreadId.make(target.target.threadId);
        const shell = yield* threadManagement.getThreadShell(threadId).pipe(Effect.option);
        if (shell._tag === "None" || shell.value === null)
          return { kind: "invalid_input", output: { error: "voice request unavailable" } } as const;
        const waited = yield* threadManagement
          .waitForThread({
            projectId: shell.value.projectId,
            threadId,
            runId: RunId.make(target.target.runId),
            timeoutMs: 20_000,
          })
          .pipe(Effect.option);
        if (waited._tag === "None")
          return { kind: "invalid_input", output: { error: "voice request unavailable" } } as const;
        if (pending.get(key(input, requestToolCallId)) !== target)
          return { kind: "invalid_input", output: { error: "unknown voice request" } } as const;
        if (waited.value.timedOut)
          return {
            kind: "served",
            output: null,
            completion: { requestToolCallId, pending: true },
          } as const;
        const records = yield* threadManagement
          .getThreadRecords(threadId, ["messages"], {
            messageRunIds: [RunId.make(target.target.runId)],
          })
          .pipe(Effect.option);
        if (records._tag === "None")
          return { kind: "invalid_input", output: { error: "voice result unavailable" } } as const;
        // Only the selected launch run's final text is its result. Other requests and native
        // chat updates must not be delivered as completion of this work.
        const runId = target.target.runId;
        const final = records.value.messages.findLast(
          (message) =>
            message.runId === runId &&
            message.role === "assistant" &&
            !message.streaming &&
            message.text.trim().length > 0,
        );
        return {
          kind: "served",
          output: {
            status: "landed",
            runStatus: waited.value.run?.status,
            updates: final === undefined ? [] : [final.text.slice(0, 16_000)],
          },
          completion: { requestToolCallId, pending: false },
        } as const;
      }
      const opened = yield* threads.open({ botId: input.botId }).pipe(Effect.option);
      if (opened._tag === "None") return spoken("T3 is not ready for this bot.");
      const read = yield* threadManagement
        .getThreadRecords(ThreadId.make(opened.value.threadId), ["runs"])
        .pipe(Effect.option);
      if (read._tag === "None") return spoken("T3 progress is unavailable right now.");
      const latest = read.value.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      return spoken(progressText(latest));
    });

  return GrokBotVoiceT3Bridge.of({
    context,
    activate: (input) =>
      Effect.gen(function* () {
        if (Option.isNone(direct)) return;
        const canonicalThreadId = yield* canonicalForCall(input);
        yield* direct.value.activate({ ...input, canonicalThreadId });
      }).pipe(Effect.orElseSucceed(() => undefined)),
    forget: (callId) =>
      Effect.sync(() => {
        callThreads.delete(callId);
        for (const [id, entry] of launchReceipts)
          if (entry.callId === callId) launchReceipts.delete(id);
        for (const [id, entry] of pending) if (entry.callId === callId) pending.delete(id);
      }).pipe(Effect.andThen(Option.isSome(direct) ? direct.value.forget(callId) : Effect.void)),
    call: (input) => {
      if (Direct.isTool(input.name))
        return Effect.gen(function* () {
          if (Option.isNone(direct))
            return {
              kind: "invalid_input",
              output: { error: "direct voice orchestration unavailable" },
            } as const;
          const prior = pending.get(key(input));
          if (prior !== undefined) return prior.receipt;
          const launched = launchReceipts.get(key(input));
          if (launched !== undefined) return launched.result;
          if (input.name === "t3_thread_launch" && launchReceipts.size >= 1_000)
            return spoken(
              "Too many thread launches are retained by active calls. End an unused call to continue.",
            );
          const now = yield* Clock.currentTimeMillis;
          for (const [id, entry] of pending)
            if (now - entry.at > 4 * 60 * 60 * 1000) pending.delete(id);
          if (pending.size >= 1_000) return spoken("Too many voice requests are awaiting results.");
          const threadId = yield* canonicalForCall(input).pipe(Effect.option);
          if (threadId._tag === "None")
            return {
              kind: "invalid_input",
              output: {
                tool: input.name,
                code: "provider_not_ready",
                error:
                  "This bot's T3 provider is not ready. Check GrokBot in Settings → Providers, then try again.",
              },
            } as const;
          // A failed first activation must be recoverable while the call remains live.
          yield* direct.value.activate({ ...input, canonicalThreadId: threadId.value });
          const outcome = yield* direct.value.call({ ...input, canonicalThreadId: threadId.value });
          if (input.name === "t3_thread_launch" && outcome.result.kind === "served")
            launchReceipts.set(key(input), { callId: input.callId, result: outcome.result });
          if (outcome.target === undefined) return outcome.result;
          const receipt: VoiceToolOutcome = {
            ...outcome.result,
            completion: { requestToolCallId: input.toolCallId, pending: true },
          };
          const at = yield* Clock.currentTimeMillis;
          pending.set(key(input), { callId: input.callId, target: outcome.target, at, receipt });
          return receipt;
        });
      if (NATIVE_EXECUTION_TOOLS.has(input.name))
        return Effect.succeed(
          spoken("Use direct T3 orchestration tools; native task execution is off."),
        );
      switch (input.name) {
        case "recall_text_messages":
          return recall(input);
        case "search_conversations":
          return search(input);
        case T3_CHAT_UPDATES:
          return chatUpdates(input);
        case T3_RUN_TASK:
          return Effect.succeed(
            spoken("Use direct T3 orchestration tools; voice chat relays are disabled."),
          );
        case T3_TASK_PROGRESS:
          return progress(input);
        default:
          return Effect.succeed({
            kind: "invalid_input",
            output: { error: `${input.name} is not a T3 voice tool` },
          } as const);
      }
    },
  });
});

export const layer = Layer.effect(GrokBotVoiceT3Bridge, make);
