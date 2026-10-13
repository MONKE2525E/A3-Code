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
import * as Deferred from "effect/Deferred";
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
export const T3_UNWATCH_THREAD = "t3_unwatch_thread";

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
    name: T3_UNWATCH_THREAD,
    description:
      "Stop this call's watches on one thread when the caller asks. Does not interrupt the thread's work.",
    parameters: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: T3_TASK_PROGRESS,
    description:
      "Get the number of this call's delegated tasks and thread runs still awaiting a result. Use task_status for a specific task. This does not launch or wait for work.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "recall_text_messages",
    description:
      "Read recent written messages and attachment references in this bot's canonical T3 chat, including messages sent during this call. Pass screenshot attachment IDs to delegate_task.attachmentIds to forward them to a child.",
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
  "Use the T3 orchestration functions on this call directly. Discover providers, exact model IDs and the available runtimeMode with orchestrator_capabilities. Find the project with t3_project_list. Delegate in async mode with that runtimeMode unless the caller asks for a narrower mode. Do not silently choose Supervised for a caller asking you to perform authorized work. Use task_status and task_cancel for this call’s tasks. Completion and approval notices arrive automatically. Acknowledge running work once and keep answering the caller. Announce an approval notice promptly; use t3_respond_call_approval only after the caller explicitly asks you to approve or decline that specific request. Never infer consent from a task's prompt. Use t3_post_call_message when the caller wants something written in this bot's T3 chat; this posts text without launching another turn. Tell the caller when a tool fails, never claim rejected work succeeded, and never repeat a failed write automatically. Use t3_task_progress for pending-work count. send_task and t3_run_task are disabled. Use t3_thread_launch only for requested independent threads. Read, message, interrupt and update existing threads using direct tools; scheduling requires an explicit request. Recall and search read this bot's canonical T3 chat. Use t3_thread_send mode auto for ordinary messages, including idle threads; steer and restart require a running turn and an explicit reason. Use t3_watch_thread to monitor existing work without sending a message. Runs this call starts or messages are watched automatically. A question or permission notice does not finish the watch. Use t3_pending_request_read and t3_pending_request_respond to answer a thread question only with the caller's explicit answer. Use t3_pending_approval_respond only after the caller explicitly approves or declines that specific request. Never choose an answer or infer consent yourself. Use t3_thread_organize action settle or unsettle to settle or reactivate a thread when asked." +
  " Keep taskId and childThreadId distinct: task_status/task_cancel use taskId; thread tools use childThreadId or threadId. Delegated tasks are watched automatically; do not add a thread watch for a delegated task or construct a thread ID from its task ID. Use exact IDs from tool results; titles and spoken names are for the caller, not identifiers. If you lack a thread ID, find it with t3_thread_list before acting. Refresh a stale read target once with the list instead of guessing. Historical chat context is for recall only; never carry out an old request merely because history was loaded. Give one brief progress update and one useful result, avoiding repeated check-ins.";

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
  `${instructions}\n\n${T3_VOICE_INSTRUCTIONS}\nGive delegated tasks a short descriptive title. For a screenshot already sent in chat, call recall_text_messages to find its attachment reference, then pass that ID in delegate_task.attachmentIds. Do not ask the user to upload it again when the reference is present.`;

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
    seenApprovalIds: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(Schema.isMaxLength(512)),
    ),
  }),
);
const decodeChatWait = Schema.decodeUnknownEffect(
  Schema.Struct({
    afterSequence: Schema.optionalKey(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
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
const decodeUnwatchThread = Schema.decodeUnknownEffect(Schema.Struct({ threadId: Schema.String }));

// Transcripts are already stripped of managed prompt footers by the adapter. Keep only visible
// conversation text; never expose system messages, runtime requests, notifications, or tool data.
const chatMessage = (
  message: OrchestrationV2ConversationMessage,
): ChatContext["messages"][number] | undefined => {
  const attachments = message.attachments ?? [];
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
    (!message.text.trim() && attachments.length === 0)
  )
    return undefined;
  return {
    id: message.id,
    role: message.role,
    text: message.text.slice(0, 4_000),
    ...(attachments.length === 0
      ? {}
      : {
          attachments: attachments
            .filter(({ type }) => type === "image" || type === "file")
            .map(({ id, name, type }) => ({
              id,
              name,
              type: type === "image" ? ("image" as const) : ("file" as const),
            })),
        }),
  };
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

const make = Effect.gen(function* () {
  const threads = yield* GrokBotThreadService.GrokBotThreadService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const direct = yield* Effect.serviceOption(Direct.GrokBotVoiceOrchestration);
  const callThreads = new Map<string, { binding: string; botId: string; threadId: ThreadId }>();
  const launchReceipts = new Map<string, { callId: string; result: VoiceToolOutcome }>();
  const inFlight = new Map<
    string,
    {
      callId: string;
      result: Deferred.Deferred<VoiceToolOutcome>;
      watchThreadId?: string | undefined;
      stopped?: boolean;
    }
  >();
  // Targets come only from accepted MCP results, never from model-supplied ids.
  const pending = new Map<
    string,
    {
      callId: string;
      target: Direct.VoiceWorkTarget;
      at: number;
      receipt: VoiceToolOutcome;
      settled: boolean;
      stopped?: boolean;
      title?: string;
      completionAfterOrdinal?: number;
      deliveredCompletion?: { runId: string; ordinal: number };
    }
  >();
  const key = (input: VoiceToolCall, toolCallId = input.toolCallId) =>
    JSON.stringify([input.binding, input.botId, input.callId, toolCallId]);
  const watchBaseline = (threadId: ThreadId) =>
    threadManagement.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => {
        let firstActive: number | undefined;
        let latestTerminal = 0;
        for (const run of runs) {
          if (ThreadManagementService.isTerminalRunStatus(run.status))
            latestTerminal = Math.max(latestTerminal, run.ordinal);
          else firstActive = Math.min(firstActive ?? run.ordinal, run.ordinal);
        }
        return Math.max(0, (firstActive ?? latestTerminal) - 1);
      }),
      Effect.option,
    );

  const canonical = (botId: string) =>
    threads.open({ botId }).pipe(Effect.map((opened) => ThreadId.make(opened.threadId)));
  const canonicalForCall = (
    input: { binding: string; botId: string; callId: string },
    isCurrent = () => true,
  ) => {
    const prior = callThreads.get(input.callId);
    return prior?.binding === input.binding && prior.botId === input.botId
      ? Effect.succeed(prior.threadId)
      : canonical(input.botId).pipe(
          Effect.tap((threadId) =>
            Effect.sync(() => {
              if (!isCurrent()) return;
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

  const chatUnavailable = () =>
    ({
      kind: "invalid_input",
      output: {
        error: "T3 could not read written chat updates. Retry from the last received message.",
        retryable: true,
      },
    }) as const;
  const chatUpdates = (input: VoiceToolCall) =>
    Effect.gen(function* () {
      const parsed = yield* decodeChatWait(input.input).pipe(Effect.option);
      if (parsed._tag === "None")
        return { kind: "invalid_input", output: { error: "invalid chat cursor" } } as const;
      if (parsed.value.afterSequence === undefined) {
        const chat = yield* context(input.botId);
        return chat === undefined
          ? chatUnavailable()
          : ({ kind: "served", output: null, chatContext: chat } as const);
      }
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
    }).pipe(Effect.orElseSucceed(chatUnavailable));

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
        const stopped = () =>
          ({
            kind: "served",
            output: { status: "watch_stopped" },
            completion: { requestToolCallId, pending: false },
          }) as const;
        if (target.stopped) return stopped();
        if ("taskId" in target.target) {
          if (Option.isNone(direct))
            return {
              kind: "invalid_input",
              output: { error: "voice request unavailable" },
            } as const;
          const result = yield* direct.value.wait({
            ...input,
            taskId: target.target.taskId,
            ...(requested.value.seenApprovalIds === undefined
              ? {}
              : { seenApprovalIds: requested.value.seenApprovalIds }),
          });
          // Ending a call removes the entry while its wait is in flight.
          if (pending.get(key(input, requestToolCallId)) !== target)
            return { kind: "invalid_input", output: { error: "unknown voice request" } } as const;
          if (!result.pending && result.result.kind === "served") target.settled = true;
          return {
            ...result.result,
            ...(result.result.kind === "served" &&
            result.result.output !== null &&
            typeof result.result.output === "object"
              ? {
                  output: {
                    ...result.result.output,
                    ...(target.title === undefined ? {} : { title: target.title }),
                  },
                }
              : {}),
            ...(result.result.kind === "served"
              ? { completion: { requestToolCallId, pending: result.pending } }
              : {}),
          };
        }
        const threadId = ThreadId.make(target.target.threadId);
        const shell = yield* threadManagement.getThreadShell(threadId).pipe(Effect.result);
        if (shell._tag === "Failure")
          return {
            kind: "invalid_input",
            output: {
              error: "T3 could not check the watched thread. Its status is unknown.",
              retryable: true,
            },
          } as const;
        if (shell.success === null)
          return { kind: "invalid_input", output: { error: "voice request unavailable" } } as const;
        if (pending.get(key(input, requestToolCallId)) !== target)
          return { kind: "invalid_input", output: { error: "unknown voice request" } } as const;
        if (target.stopped) return stopped();
        if (target.target.watch) {
          const delivered = target.deliveredCompletion;
          if (delivered && requested.value.seenApprovalIds?.includes(`run:${delivered.runId}`)) {
            target.completionAfterOrdinal = Math.max(
              target.completionAfterOrdinal ?? 0,
              delivered.ordinal,
            );
            delete target.deliveredCompletion;
          }
          if (target.completionAfterOrdinal === undefined) {
            const baseline = yield* watchBaseline(threadId);
            if (pending.get(key(input, requestToolCallId)) !== target)
              return { kind: "invalid_input", output: { error: "unknown voice request" } } as const;
            if (target.stopped) return stopped();
            if (Option.isNone(baseline))
              return {
                kind: "invalid_input",
                output: { error: "T3 could not initialize this thread watch.", retryable: true },
              } as const;
            target.completionAfterOrdinal ??= baseline.value;
          }
        }
        const waited = yield* threadManagement
          .waitForThread({
            projectId: shell.success.projectId,
            threadId,
            ...(target.target.watch
              ? { followThread: true, completionAfterOrdinal: target.completionAfterOrdinal ?? 0 }
              : { runId: RunId.make(target.target.runId) }),
            timeoutMs: 20_000,
            ...(requested.value.seenApprovalIds === undefined
              ? {}
              : { seenRequestIds: requested.value.seenApprovalIds }),
          })
          .pipe(Effect.result);
        if (waited._tag === "Failure")
          return {
            kind: "invalid_input",
            output: {
              error: "T3 could not check the watched run. Its status is unknown.",
              retryable: !waited.failure._tag.includes("NotFound"),
            },
          } as const;
        if (pending.get(key(input, requestToolCallId)) !== target)
          return { kind: "invalid_input", output: { error: "unknown voice request" } } as const;
        if (target.stopped) return stopped();
        if (waited.success.pendingRequests?.length) {
          const approvals = waited.success.pendingRequests.filter(
            (item) => item.type === "approval_request",
          );
          const questions = waited.success.pendingRequests.filter(
            (item) => item.type === "user_input_request",
          );
          return {
            kind: "served",
            output: {
              status: approvals.length ? "approval_required" : "input_required",
              title: shell.success.title,
              threadId,
              runId: waited.success.run?.id ?? target.target.runId,
              ...(approvals.length
                ? {
                    approvals: approvals.map((item) => {
                      const title = item.title?.trim();
                      const prompt = item.prompt?.trim();
                      const generic =
                        !title ||
                        /^(permission to continue|approval( required| request)?|permission( required| request)?)$/i.test(
                          title,
                        );
                      return {
                        requestId: item.requestId,
                        title: (
                          (generic ? prompt || title : title) || "Permission to continue"
                        ).slice(0, 500),
                        ...(prompt ? { prompt: prompt.slice(0, 1_000) } : {}),
                      };
                    }),
                  }
                : {
                    questions: questions.map((item) => ({
                      requestId: item.requestId,
                      questions: item.questions,
                    })),
                  }),
            },
            completion: { requestToolCallId, pending: true },
          } as const;
        }
        if (waited.success.timedOut)
          return {
            kind: "served",
            output: null,
            completion: { requestToolCallId, pending: true },
          } as const;
        const runId = waited.success.run?.id ?? target.target.runId;
        const records = yield* threadManagement
          .getThreadRecords(threadId, ["messages"], {
            messageRunIds: [RunId.make(runId)],
          })
          .pipe(Effect.result);
        if (pending.get(key(input, requestToolCallId)) !== target)
          return { kind: "invalid_input", output: { error: "unknown voice request" } } as const;
        if (target.stopped) return stopped();
        if (records._tag === "Failure")
          return {
            kind: "invalid_input",
            output: {
              error: "T3 could not read the watched result. Its status is unknown.",
              retryable: true,
            },
          } as const;
        // Only the selected launch run's final text is its result. Other requests and native
        // chat updates must not be delivered as completion of this work.
        target.settled = !target.target.watch;
        const final = records.success.messages.findLast(
          (message) =>
            message.runId === runId &&
            message.role === "assistant" &&
            !message.streaming &&
            message.text.trim().length > 0,
        );
        if (target.target.watch && waited.success.run)
          target.deliveredCompletion = { runId, ordinal: waited.success.run.ordinal };
        return {
          kind: "served",
          output: {
            status: "landed",
            ...(target.target.watch ? { runId } : {}),
            title: shell.success.title,
            runStatus: waited.success.run?.status,
            ...(waited.success.run?.status === "failed"
              ? {
                  error:
                    "A thread run from this call failed. Open its T3 thread for the error. That task has not been completed.",
                }
              : {}),
            updates: final === undefined ? [] : [final.text.slice(0, 16_000)],
          },
          completion: { requestToolCallId, pending: target.target.watch === true },
        } as const;
      }
      const count = [...pending.values()].filter(
        (entry) => entry.callId === input.callId && !entry.settled,
      ).length;
      return {
        kind: "served",
        output: {
          pending: count,
          message:
            count === 0
              ? "This call has no work awaiting a result."
              : `${count} operation(s) from this call are still awaiting results. Use task_status for a specific delegated task.`,
        },
      } as const;
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
      Effect.gen(function* () {
        callThreads.delete(callId);
        for (const [id, entry] of launchReceipts)
          if (entry.callId === callId) launchReceipts.delete(id);
        for (const [id, entry] of pending) if (entry.callId === callId) pending.delete(id);
        for (const [id, entry] of inFlight) {
          if (entry.callId !== callId) continue;
          inFlight.delete(id);
          yield* Deferred.succeed(entry.result, {
            kind: "invalid_input",
            output: { error: "unknown voice request" },
          });
        }
      }).pipe(Effect.andThen(Option.isSome(direct) ? direct.value.forget(callId) : Effect.void)),
    call: (input) => {
      if (Direct.isTool(input.name))
        return Effect.gen(function* () {
          if (Option.isNone(direct))
            return {
              kind: "invalid_input",
              output: { error: "direct voice orchestration unavailable" },
            } as const;
          const id = key(input);
          const active = inFlight.get(id);
          if (active !== undefined) return yield* Deferred.await(active.result);
          const entry = {
            callId: input.callId,
            result: Deferred.makeUnsafe<VoiceToolOutcome>(),
            watchThreadId:
              input.name === "t3_watch_thread" &&
              typeof input.input === "object" &&
              input.input !== null &&
              "threadId" in input.input &&
              typeof input.input.threadId === "string"
                ? input.input.threadId
                : undefined,
            stopped: false,
          };
          // Reserve before the first await; concurrent copies share this invocation's outcome.
          inFlight.set(id, entry);
          const isCurrent = () => inFlight.get(id) === entry;
          const forgotten = () =>
            ({ kind: "invalid_input", output: { error: "unknown voice request" } }) as const;
          return yield* Effect.gen(function* () {
            const prior = pending.get(key(input));
            if (prior !== undefined) return prior.receipt;
            const launched = launchReceipts.get(key(input));
            if (launched !== undefined) return launched.result;
            if (input.name === "t3_thread_launch" && launchReceipts.size >= 1_000)
              return spoken(
                "Too many thread launches are retained by active calls. End an unused call to continue.",
              );
            const now = yield* Clock.currentTimeMillis;
            if (!isCurrent()) return forgotten();
            for (const [id, entry] of pending)
              if (now - entry.at > 4 * 60 * 60 * 1000) pending.delete(id);
            if (pending.size >= 1_000)
              return spoken("Too many voice requests are awaiting results.");
            const threadId = yield* canonicalForCall(input, isCurrent).pipe(Effect.option);
            if (!isCurrent()) return forgotten();
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
            if (!isCurrent()) return forgotten();
            const outcome = yield* direct.value.call({
              ...input,
              canonicalThreadId: threadId.value,
            });
            if (!isCurrent()) return forgotten();
            if (input.name === "t3_thread_launch" && outcome.result.kind === "served")
              launchReceipts.set(key(input), { callId: input.callId, result: outcome.result });
            if (outcome.target === undefined) return outcome.result;
            if ("threadId" in outcome.target && outcome.target.watch)
              entry.watchThreadId = outcome.target.threadId;
            if ("threadId" in outcome.target) {
              for (const entry of pending.values()) {
                if (
                  entry.callId !== input.callId ||
                  entry.stopped ||
                  !("threadId" in entry.target) ||
                  entry.target.threadId !== outcome.target.threadId
                )
                  continue;
                if (entry.target.watch)
                  return outcome.target.watch ? entry.receipt : outcome.result;
                if (outcome.target.watch) {
                  entry.stopped = true;
                  entry.settled = true;
                }
              }
            }
            const receipt: VoiceToolOutcome = {
              ...outcome.result,
              completion: { requestToolCallId: input.toolCallId, pending: true },
            };
            const baseline =
              "threadId" in outcome.target && outcome.target.watch
                ? yield* watchBaseline(ThreadId.make(outcome.target.threadId))
                : Option.none();
            const at = yield* Clock.currentTimeMillis;
            if (!isCurrent()) return forgotten();
            if (entry.stopped)
              return {
                kind: "served",
                output: { status: "watch_stopped" },
                completion: { requestToolCallId: input.toolCallId, pending: false },
              } as const;
            // Another watch or unwatch can finish while the baseline read is in flight.
            if ("threadId" in outcome.target && outcome.target.watch) {
              for (const existing of pending.values())
                if (
                  existing.callId === input.callId &&
                  !existing.stopped &&
                  "threadId" in existing.target &&
                  existing.target.threadId === outcome.target.threadId &&
                  existing.target.watch
                )
                  return existing.receipt;
            }
            pending.set(key(input), {
              callId: input.callId,
              target: outcome.target,
              at,
              receipt,
              settled: false,
              ...(Option.isSome(baseline) ? { completionAfterOrdinal: baseline.value } : {}),
              ...(typeof input.input === "object" &&
              input.input !== null &&
              "title" in input.input &&
              typeof input.input.title === "string"
                ? { title: input.input.title.slice(0, 100) }
                : {}),
            });
            return receipt;
          }).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (isCurrent()) inFlight.delete(id);
                yield* Deferred.done(entry.result, exit);
              }),
            ),
          );
        });
      if (NATIVE_EXECUTION_TOOLS.has(input.name))
        return Effect.succeed(
          spoken("Use direct T3 orchestration tools; native task execution is off."),
        );
      switch (input.name) {
        case T3_UNWATCH_THREAD:
          return Effect.gen(function* () {
            const requested = yield* decodeUnwatchThread(input.input);
            let stopped = 0;
            for (const entry of inFlight.values()) {
              if (
                entry.callId === input.callId &&
                entry.watchThreadId === requested.threadId &&
                !entry.stopped
              ) {
                entry.stopped = true;
                stopped++;
              }
            }
            for (const entry of pending.values()) {
              if (
                entry.callId === input.callId &&
                "threadId" in entry.target &&
                entry.target.threadId === requested.threadId &&
                !entry.stopped
              ) {
                entry.stopped = true;
                entry.settled = true;
                stopped++;
              }
            }
            return {
              kind: "served",
              output: {
                stopped,
                spoken: stopped
                  ? "Stopped watching that thread."
                  : "That thread was not being watched.",
              },
            } as const;
          }).pipe(
            Effect.catch(() =>
              Effect.succeed({
                kind: "invalid_input",
                output: { error: "A thread ID is required to stop watching." },
              } as const),
            ),
          );
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
