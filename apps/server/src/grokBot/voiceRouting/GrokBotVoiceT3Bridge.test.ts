import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { makeGrokBotTranscriptProjection } from "../../orchestration-v2/Adapters/GrokBotAdapterV2.ts";
import { nativeSession } from "../../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GrokBotThreadService from "../GrokBotThreadService.ts";
import * as Bridge from "./GrokBotVoiceT3Bridge.ts";
import * as Direct from "./GrokBotVoiceOrchestration.ts";

const sent: Array<{ input: unknown; caller: unknown }> = [];

const harness = Bridge.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(GrokBotThreadService.GrokBotThreadService, {
        send: (input: unknown, caller: unknown) =>
          Effect.sync(() => {
            sent.push({ input, caller });
            return {
              accepted: true,
              delivery: "started" as const,
              threadId: "grok-bot:abc",
              runId: "run-1",
            };
          }),
        open: () => Effect.succeed({ threadId: "grok-bot:abc", providerInstanceId: "grok-bot" }),
      } as never),
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        getThreadRecords: () =>
          Effect.succeed({
            runs: [
              { ordinal: 1, status: "completed" },
              { ordinal: 2, status: "running" },
            ],
          }),
      } as never),
      Layer.succeed(ProjectService.ProjectService, {
        snapshot: Effect.succeed({
          projects: [
            { id: "p1", title: "One", deletedAt: null },
            { id: "p2", title: "Gone", deletedAt: "x" },
          ],
        }),
      } as never),
    ),
  ),
);

const call = (name: string, input: unknown, access: Bridge.VoiceAccess = "operate") =>
  Effect.flatMap(Bridge.GrokBotVoiceT3Bridge, (bridge) =>
    bridge.call({
      binding: "acct",
      botId: "bot-1",
      callId: "call-1",
      toolCallId: "tc-1",
      name,
      input,
      access,
    }),
  ).pipe(Effect.provide(harness));

it("keeps only native conversation controls and drops connectors and stale T3 tools", () => {
  const fn = (name: string, type = "function") => ({
    type,
    name,
    description: "",
    parameters: {},
  });
  const native = [
    fn("send_task"),
    fn("stay_silent"),
    fn("end_the_call"),
    fn("mystery"),
    fn("delegate_task"),
    fn("t3_thread_send"),
    fn("", "mcp"),
    fn("stay_silent", "mcp"),
  ];
  const names = Bridge.routeSessionTools(native).map((tool) => tool.name);
  assert.deepStrictEqual(names, [
    "stay_silent",
    "end_the_call",
    "t3_unwatch_thread",
    "t3_task_progress",
    "recall_text_messages",
    "search_conversations",
    ...Direct.tools.map((tool) => tool.name),
  ]);
  assert.isTrue(Bridge.isRoutedLocally("send_task"));
  assert.isTrue(Bridge.isRoutedLocally("t3_run_task"));
  assert.isTrue(Bridge.isRoutedLocally("recall_text_messages"));
  assert.isFalse(Bridge.isNativeControl("recall_text_messages"));
  assert.isFalse(Bridge.isNativeControl("delegate_task"));
});

it.effect("legacy run_task no longer relays a call request to bot chat", () =>
  Effect.gen(function* () {
    sent.length = 0;
    const outcome = yield* call("t3_run_task", {
      task: "fix the build",
      projectId: "p1",
      botId: "evil",
      binding: "other",
    });
    assert.strictEqual(outcome.kind, "served");
    assert.strictEqual(sent.length, 0);
    assert.isUndefined(outcome.completion);
  }),
);

it.effect("run_task is refused for a read-only principal and for bad input", () =>
  Effect.gen(function* () {
    sent.length = 0;
    yield* call("t3_run_task", { task: "x" }, "read");
    assert.strictEqual(sent.length, 0);
    const bad = yield* call("t3_run_task", { task: "" });
    assert.strictEqual(bad.kind, "served");
    assert.strictEqual(sent.length, 0);
  }),
);

it.effect("native send_task is refused locally and unknown names are invalid", () =>
  Effect.gen(function* () {
    sent.length = 0;
    const refused = yield* call("send_task", { request: {} });
    assert.strictEqual(refused.kind, "served");
    assert.strictEqual(sent.length, 0);
    assert.strictEqual((yield* call("nope", {})).kind, "invalid_input");
  }),
);

it.effect("call progress does not mistake a canonical chat turn for call work", () =>
  Effect.gen(function* () {
    const progress = yield* call("t3_task_progress", {}, "read");
    assert.deepStrictEqual(progress.output, {
      pending: 0,
      message: "This call has no work awaiting a result.",
    });
  }),
);

it.effect.each([
  { kind: "user_input_request", title: "Question", prompt: undefined },
  { kind: "approval_request", title: null, prompt: "Allow reading /workspace/package.json?" },
  {
    kind: "approval_request",
    title: "Permission to continue",
    prompt: "Allow running `vp test run src/call.test.ts` in /workspace?",
  },
  { kind: "approval_request", title: "Run focused tests", prompt: "Allow test execution?" },
  { kind: "approval_request", title: null, prompt: undefined },
  { kind: "approval_request", title: "Approval required", prompt: "Allow command: ".repeat(200) },
] as const)(
  "persistent watches deliver the request details for %o and remain active until stopped",
  ({ kind, title, prompt }) =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const inputs: unknown[] = [];
      const layer = Bridge.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Direct.GrokBotVoiceOrchestration, {
              activate: () => Effect.void,
              forget: () => Effect.void,
              wait: () => Effect.die("unexpected task"),
              call: () =>
                Effect.succeed({
                  result: { kind: "served", output: { watching: true } },
                  target: { threadId: "watched-thread", runId: "watched-run", watch: true },
                }),
            }),
            Layer.succeed(GrokBotThreadService.GrokBotThreadService, {
              open: () => Effect.succeed({ threadId: "bot-thread" }),
            } as never),
            Layer.succeed(ProjectService.ProjectService, {} as never),
            Layer.succeed(ThreadManagementService.ThreadManagementService, {
              getThreadShell: () =>
                Effect.succeed({ projectId: "watched-project", title: "Watched work" }),
              waitForThread: (input: unknown) =>
                Effect.gen(function* () {
                  inputs.push(input);
                  if (inputs.length === 1)
                    return {
                      timedOut: false,
                      run: { id: "watched-run", ordinal: 1, status: "running" },
                      pendingRequests: [
                        {
                          type: kind,
                          requestId: "request",
                          title,
                          prompt,
                          questions: [{ question: "May I continue?" }],
                        },
                      ],
                    };
                  if (inputs.length === 2)
                    return {
                      timedOut: false,
                      run: { id: "watched-run", ordinal: 1, status: "completed" },
                    };
                  yield* Deferred.succeed(waiting, undefined);
                  yield* Deferred.await(released);
                  return {
                    timedOut: true,
                    run: { id: "watched-run", ordinal: 1, status: "completed" },
                  };
                }),
              getThreadRecords: (_threadId: unknown, fields: string[]) =>
                Effect.succeed(
                  fields.includes("runs")
                    ? {
                        runs: [{ id: "watched-run", ordinal: 1, status: "running" }],
                      }
                    : {
                        messages: [
                          {
                            role: "assistant",
                            runId: "watched-run",
                            streaming: false,
                            text: "Finished verification.",
                          },
                        ],
                      },
                ),
            } as never),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        const caller = {
          binding: "account",
          botId: "bot",
          callId: "call",
          toolCallId: "watch",
          access: "operate" as const,
        };
        yield* bridge.call({
          ...caller,
          name: "t3_watch_thread",
          input: { threadId: "watched-thread" },
        });
        const progress = (seenApprovalIds: string[]) =>
          bridge.call({
            ...caller,
            toolCallId: "progress",
            name: Bridge.T3_TASK_PROGRESS,
            input: { requestToolCallId: "watch", seenApprovalIds },
          });
        const notice = yield* progress([]);
        assert.equal(
          (notice.output as { status: string }).status,
          kind === "user_input_request" ? "input_required" : "approval_required",
        );
        assert.equal(notice.completion?.pending, true);
        if (kind === "approval_request") {
          const expectedTitle =
            title === "Run focused tests" ? title : (prompt ?? "Permission to continue");
          assert.deepStrictEqual((notice.output as { approvals: unknown[] }).approvals, [
            {
              requestId: "request",
              title: expectedTitle.slice(0, 500),
              ...(prompt === undefined ? {} : { prompt: prompt.slice(0, 1_000) }),
            },
          ]);
        }
        const finished = yield* progress(["request"]);
        assert.equal((finished.output as { status: string }).status, "landed");
        assert.equal(finished.completion?.pending, true);
        const next = yield* progress(["request", "run:watched-run"]).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        const stop = yield* bridge.call({
          ...caller,
          toolCallId: "stop",
          name: Bridge.T3_UNWATCH_THREAD,
          input: { threadId: "watched-thread" },
        });
        assert.equal((stop.output as { stopped: number }).stopped, 1);
        yield* Deferred.succeed(released, undefined);
        const stopped = yield* Fiber.join(next);
        assert.equal((stopped.output as { status: string }).status, "watch_stopped");
        assert.equal(stopped.completion?.pending, false);
        assert.deepStrictEqual(inputs[2], {
          projectId: "watched-project",
          threadId: "watched-thread",
          followThread: true,
          completionAfterOrdinal: 1,
          timeoutMs: 20_000,
          seenRequestIds: ["request", "run:watched-run"],
        });
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("waits for the accepted managed run and returns only its final text", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const waits: unknown[] = [];
    const layer = Bridge.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Direct.GrokBotVoiceOrchestration, {
            activate: () => Effect.void,
            forget: () => Effect.void,
            wait: () => Effect.die("unexpected task wait"),
            call: () =>
              Effect.succeed({
                result: {
                  kind: "served",
                  output: { threadId: "bot-thread", runId: "managed-run" },
                },
                target: { threadId: "bot-thread", runId: "managed-run" },
              }),
          }),
          Layer.succeed(GrokBotThreadService.GrokBotThreadService, {
            open: () => Effect.succeed({ threadId: "bot-thread" }),
            send: () =>
              Effect.succeed({
                accepted: true,
                delivery: "queued",
                threadId: "bot-thread",
                runId: "managed-run",
              }),
          } as never),
          Layer.succeed(ThreadManagementService.ThreadManagementService, {
            getThreadShell: () =>
              Effect.succeed({ projectId: "bot-project", title: "Fix project icons" }),
            waitForThread: (input: unknown) =>
              Effect.gen(function* () {
                waits.push(input);
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(completed);
                return { timedOut: false, run: { id: "managed-run", status: "completed" } };
              }),
            getThreadRecords: () =>
              Effect.succeed({
                messages: [
                  {
                    role: "assistant",
                    runId: "managed-run",
                    streaming: false,
                    text: "The requested fix passed its tests.",
                  },
                  {
                    role: "assistant",
                    runId: "another-run",
                    streaming: false,
                    text: "Unrelated result",
                  },
                  { role: "assistant", runId: "managed-run", streaming: true, text: "Partial" },
                ],
              }),
          } as never),
          Layer.succeed(ProjectService.ProjectService, {} as never),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
      const request = {
        binding: "account",
        botId: "bot",
        callId: "call",
        toolCallId: "tool",
        access: "operate" as const,
      };
      const receipt = yield* bridge.call({
        ...request,
        name: "t3_thread_launch",
        input: { task: "fix it" },
      });
      assert.deepStrictEqual(receipt.completion, { requestToolCallId: "tool", pending: true });
      const wait = yield* bridge
        .call({
          ...request,
          toolCallId: "wait",
          name: Bridge.T3_TASK_PROGRESS,
          input: { requestToolCallId: "tool", threadId: "evil", runId: "evil" },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.deepStrictEqual(waits, [
        {
          projectId: "bot-project",
          threadId: "bot-thread",
          runId: "managed-run",
          timeoutMs: 20_000,
        },
      ]);
      const wrong = yield* bridge.call({
        ...request,
        callId: "new-call",
        name: Bridge.T3_TASK_PROGRESS,
        input: { requestToolCallId: "tool" },
      });
      assert.strictEqual(wrong.kind, "invalid_input");
      const wrongBot = yield* bridge.call({
        ...request,
        botId: "other-bot",
        name: Bridge.T3_TASK_PROGRESS,
        input: { requestToolCallId: "tool" },
      });
      assert.strictEqual(wrongBot.kind, "invalid_input");
      const wrongAccount = yield* bridge.call({
        ...request,
        binding: "other-account",
        name: Bridge.T3_TASK_PROGRESS,
        input: { requestToolCallId: "tool" },
      });
      assert.strictEqual(wrongAccount.kind, "invalid_input");
      yield* Deferred.succeed(completed, undefined);
      const result = yield* Fiber.join(wait);
      assert.deepStrictEqual(result, {
        kind: "served",
        output: {
          status: "landed",
          runStatus: "completed",
          title: "Fix project icons",
          updates: ["The requested fix passed its tests."],
        },
        completion: { requestToolCallId: "tool", pending: false },
      });
      yield* bridge.forget("call");
      assert.strictEqual(
        (yield* bridge.call({
          ...request,
          name: Bridge.T3_TASK_PROGRESS,
          input: { requestToolCallId: "tool" },
        })).kind,
        "invalid_input",
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("recall and search read the canonical bot chat including imported native messages", () =>
  Effect.gen(function* () {
    const reads: unknown[] = [];
    const messages = [
      {
        id: "t3-user",
        role: "user",
        createdBy: "user",
        text: "The launch date is Friday.",
        streaming: false,
      },
      {
        id: "native-user",
        role: "user",
        createdBy: "user",
        text: "Earlier native chat: use the blue icon.",
        streaming: false,
      },
      {
        id: "screenshot-only",
        role: "user",
        createdBy: "user",
        text: "",
        streaming: false,
        attachments: [
          {
            type: "image",
            id: "chat-screenshot",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 42,
          },
        ],
      },
      {
        id: "internal",
        role: "system",
        text: "Internal managed instructions and secret",
        streaming: false,
      },
      {
        id: "notification",
        role: "user",
        text: "Internal wake",
        streaming: false,
        notification: {},
      },
    ];
    const testLayer = Bridge.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(GrokBotThreadService.GrokBotThreadService, {
            open: ({ botId }: { botId: string }) =>
              Effect.succeed({ threadId: `canonical:${botId}` }),
          } as never),
          Layer.succeed(ThreadManagementService.ThreadManagementService, {
            ensureLegacyTranscript: () => Effect.void,
            getThreadSnapshotWindow: (threadId: string) =>
              Effect.sync(() => {
                reads.push(threadId);
                return { snapshotSequence: 42, projection: { messages } };
              }),
            searchThread: (input: unknown) =>
              Effect.sync(() => {
                reads.push(input);
                return { totalMatches: 1, activeIndex: 0, match: { entryId: "native-user" } };
              }),
            getThreadRecords: (
              threadId: string,
              _fields: unknown,
              filter: { messageIds: string[] },
            ) =>
              Effect.sync(() => {
                reads.push({ threadId, filter });
                return {
                  messages: messages.filter((message) => filter.messageIds.includes(message.id)),
                };
              }),
          } as never),
          Layer.succeed(ProjectService.ProjectService, {} as never),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
      const context = yield* bridge.context("bot-1");
      assert.deepStrictEqual(context, {
        afterSequence: 42,
        messages: [
          { id: "t3-user", role: "user", text: "The launch date is Friday." },
          { id: "native-user", role: "user", text: "Earlier native chat: use the blue icon." },
          {
            id: "screenshot-only",
            role: "user",
            text: "",
            attachments: [{ type: "image", id: "chat-screenshot", name: "screen.png" }],
          },
        ],
      });
      const result = yield* bridge.call({
        binding: "account",
        botId: "bot-1",
        callId: "call",
        toolCallId: "read",
        name: "search_conversations",
        access: "read",
        input: { query: "blue", botId: "evil", threadId: "wrong-environment" },
      });
      assert.deepStrictEqual(result.output, {
        messages: [
          { id: "native-user", role: "user", text: "Earlier native chat: use the blue icon." },
        ],
        totalMatches: 1,
        index: 0,
      });
      assert.deepStrictEqual(reads, [
        "canonical:bot-1",
        { threadId: "canonical:bot-1", query: "blue" },
        {
          threadId: "canonical:bot-1",
          filter: { messageIds: ["native-user"], messageRoles: ["user", "assistant"] },
        },
      ]);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect(
  "waits for a call's accepted delegated task and refuses foreign or forgotten requests",
  () =>
    Effect.gen(function* () {
      const watching = yield* Deferred.make<void>();
      const landed = yield* Deferred.make<void>();
      const waits: string[] = [];
      const testLayer = Bridge.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(GrokBotThreadService.GrokBotThreadService, {
              open: () => Effect.succeed({ threadId: "bot-thread" }),
            } as never),
            Layer.succeed(ThreadManagementService.ThreadManagementService, {} as never),
            Layer.succeed(Direct.GrokBotVoiceOrchestration, {
              activate: () => Effect.void,
              forget: () => Effect.void,
              call: () =>
                Effect.succeed({
                  result: { kind: "served", output: { taskId: "accepted-task" } },
                  target: { taskId: "accepted-task" },
                }),
              wait: ({ taskId }) =>
                Effect.gen(function* () {
                  waits.push(taskId);
                  yield* Deferred.succeed(watching, undefined);
                  yield* Deferred.await(landed);
                  return {
                    result: {
                      kind: "served",
                      output: { status: "landed", updates: ["Actual child result"] },
                    },
                    pending: false,
                  } as const;
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        const identity = {
          binding: "account",
          botId: "bot",
          callId: "call",
          toolCallId: "tool",
          access: "operate" as const,
        };
        const receipt = yield* bridge.call({
          ...identity,
          name: "delegate_task",
          input: { task: "work" },
        });
        assert.deepStrictEqual(receipt.completion, { requestToolCallId: "tool", pending: true });
        const progress = {
          ...identity,
          name: Bridge.T3_TASK_PROGRESS,
          input: { requestToolCallId: "tool", taskId: "unrelated-task" },
        };
        for (const foreign of [{ callId: "other" }, { binding: "other" }, { botId: "other" }])
          assert.strictEqual(
            (yield* bridge.call({ ...progress, ...foreign })).kind,
            "invalid_input",
          );
        const completion = yield* bridge.call(progress).pipe(Effect.forkChild);
        yield* Deferred.await(watching);
        yield* Deferred.succeed(landed, undefined);
        assert.deepStrictEqual((yield* Fiber.join(completion)).completion, {
          requestToolCallId: "tool",
          pending: false,
        });
        assert.deepStrictEqual(waits, ["accepted-task"]);
        yield* bridge.forget("call");
        assert.strictEqual((yield* bridge.call(progress)).kind, "invalid_input");
      }).pipe(Effect.provide(testLayer));
    }),
);

it.effect(
  "native peer and MCP provenance stays stored but never speaks as this caller or bot",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const transcript = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      yield* transcript.project({
        _tag: "Rows",
        generation: 0,
        replay: true,
        deletes: [],
        entries: [
          {
            seq: "1",
            updatedSeq: "1",
            value: {
              id: "peer-in",
              kind: "message",
              role: "user",
              content: "External peer request",
              fromAgent: { id: "other-bot", name: "Other Bot" },
              toAgent: { id: nativeSession.botId },
            },
          },
          {
            seq: "2",
            updatedSeq: "2",
            value: {
              id: "peer-out",
              kind: "message",
              role: "assistant",
              content: "Reply to external peer",
              fromAgent: { id: nativeSession.botId },
              toAgent: { id: "other-bot", name: "Other Bot" },
            },
          },
          {
            seq: "3",
            updatedSeq: "3",
            value: {
              id: "written-user",
              kind: "message",
              role: "user",
              content: "My written question",
            },
          },
          {
            seq: "4",
            updatedSeq: "4",
            value: {
              id: "bot-reply",
              kind: "message",
              role: "assistant",
              content: "This bot's answer",
            },
          },
          {
            seq: "5",
            updatedSeq: "5",
            value: {
              id: "native-spoken-user",
              kind: "message",
              role: "user",
              content: "My spoken words",
              channel: "voice:call",
            },
          },
        ],
      });
      const imported = transcript.messages();
      const written = imported.find((message) => message.role === "user")!;
      // GrokBotThreadService.send creates this agent/MCP request, including its sender thread.
      const agentRequest = {
        ...written,
        id: MessageId.make("mcp-request"),
        text: "Agent request",
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        senderThreadId: ThreadId.make("coordinating-agent"),
      };
      const voiceRequest = {
        ...agentRequest,
        id: MessageId.make("spoken-request"),
        voiceRequest: true as const,
        text: "Spoken execution",
      };
      const scheduled = {
        ...written,
        id: MessageId.make("scheduled-request"),
        createdBy: "agent" as const,
        text: "Scheduled task request",
      };
      const stored = [...imported, agentRequest, voiceRequest, scheduled];
      const testLayer = Bridge.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(GrokBotThreadService.GrokBotThreadService, {
              open: () => Effect.succeed({ threadId: nativeSession.threadId }),
            } as never),
            Layer.succeed(ThreadManagementService.ThreadManagementService, {
              ensureLegacyTranscript: () => Effect.void,
              getThreadSnapshotWindow: () =>
                Effect.succeed({ snapshotSequence: 10, projection: { messages: stored } }),
              searchThread: () =>
                Effect.succeed({
                  totalMatches: 1,
                  activeIndex: 0,
                  match: { entryId: imported[0]!.id },
                }),
              getThreadRecords: () => Effect.succeed({ messages: [imported[0]!] }),
              streamStoredEventsFrom: () =>
                Stream.fromIterable(
                  [...stored.filter((message) => message.id !== written.id), written].map(
                    (message, index) => ({
                      sequence: index + 11,
                      event: { type: "message.updated", payload: message },
                    }),
                  ),
                ),
            } as never),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        const input = {
          binding: "account",
          botId: nativeSession.botId,
          callId: "call",
          toolCallId: "tool",
          access: "read" as const,
        };
        const expected = [
          written,
          imported.find((message) => message.text === "This bot's answer")!,
        ].map(({ id, role, text }) => ({
          id,
          role: role === "user" ? ("user" as const) : ("assistant" as const),
          text,
        }));
        assert.deepStrictEqual((yield* bridge.context(nativeSession.botId))?.messages, expected);
        assert.deepStrictEqual(
          (yield* bridge.call({ ...input, name: "recall_text_messages", input: {} })).output,
          { messages: expected },
        );
        assert.deepStrictEqual(
          (yield* bridge.call({ ...input, name: "search_conversations", input: { query: "peer" } }))
            .output,
          { messages: [], totalMatches: 1, index: 0 },
        );
        const update = yield* bridge.call({
          ...input,
          name: Bridge.T3_CHAT_UPDATES,
          input: { afterSequence: 10 },
        });
        assert.deepStrictEqual(update.chatContext?.messages, [expected[0]!]);
        assert.strictEqual(transcript.messages().length, 5);
        assert.isTrue(
          transcript.messages().find((message) => message.text === "My spoken words")
            ?.grokBotVoiceUtterance,
        );
        assert.strictEqual(stored.length, 8);
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.provide(IdAllocator.layer)),
);

const voiceCaller = {
  binding: "account",
  botId: "bot",
  callId: "call",
  toolCallId: "launch",
  access: "operate" as const,
};
const isolatedBridge = (management: object, direct?: Direct.GrokBotVoiceOrchestration["Service"]) =>
  Bridge.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GrokBotThreadService.GrokBotThreadService, {
          open: () => Effect.succeed({ threadId: "bot-thread" }),
        } as never),
        Layer.succeed(ThreadManagementService.ThreadManagementService, management as never),
        ...(direct === undefined ? [] : [Layer.succeed(Direct.GrokBotVoiceOrchestration, direct)]),
      ),
    ),
  );
const watchedThread: Direct.GrokBotVoiceOrchestration["Service"] = {
  activate: () => Effect.void,
  forget: () => Effect.void,
  wait: () => Effect.die("unexpected delegated wait"),
  call: () =>
    Effect.succeed({
      result: { kind: "served", output: { watching: true } },
      target: { threadId: "watched-thread", runId: "watched-run", watch: true },
    }),
};

it.effect(
  "marks a failed written-chat read retryable and resumes messages and attachments at its saved cursor",
  () =>
    Effect.gen(function* () {
      const cursors: number[] = [];
      const message = {
        id: "written",
        role: "user",
        createdBy: "user",
        creationSource: "web",
        text: "Please inspect this screenshot.",
        streaming: false,
        attachments: [{ id: "image", name: "screen.png", type: "image" as const }],
      };
      const layer = isolatedBridge({
        streamStoredEventsFrom: ({ afterSequence }: { afterSequence: number }) => {
          cursors.push(afterSequence);
          return cursors.length === 1
            ? Stream.fail(
                new ThreadManagementService.ThreadManagementProjectionLoadError({
                  projectId: ProjectId.make("project"),
                  threadId: ThreadId.make("bot-thread"),
                  cause: new Error("read interrupted"),
                }),
              )
            : Stream.fromIterable(
                afterSequence < 44
                  ? [{ sequence: 44, event: { type: "message.updated", payload: message } }]
                  : [],
              );
        },
      });
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        const read = (afterSequence: number) =>
          bridge.call({ ...voiceCaller, name: Bridge.T3_CHAT_UPDATES, input: { afterSequence } });
        const failure = yield* read(42);
        assert.strictEqual(failure.kind, "invalid_input");
        assert.deepStrictEqual(failure.output, {
          error: "T3 could not read written chat updates. Retry from the last received message.",
          retryable: true,
        });
        assert.isUndefined(failure.chatContext);
        const resumed = yield* read(42);
        assert.deepStrictEqual(resumed.chatContext, {
          afterSequence: 44,
          messages: [
            {
              id: "written",
              role: "user",
              text: message.text,
              attachments: message.attachments,
            },
          ],
        });
        assert.deepStrictEqual((yield* read(44)).chatContext, { afterSequence: 44, messages: [] });
        assert.deepStrictEqual(cursors, [42, 42, 44]);
        const invalid = yield* bridge.call({
          ...voiceCaller,
          name: Bridge.T3_CHAT_UPDATES,
          input: { afterSequence: -1 },
        });
        assert.deepStrictEqual(invalid.output, { error: "invalid chat cursor" });
        assert.strictEqual(cursors.length, 3);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "retries missing initial chat context through a bounded snapshot before watching its cursor",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      let streams = 0;
      const layer = isolatedBridge({
        ensureLegacyTranscript: () => Effect.void,
        getThreadSnapshotWindow: (_threadId: unknown, options: unknown) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(options, { rowLimit: 40, userTurnLimit: 20 });
            if (++reads === 1)
              return yield* new ThreadManagementService.ThreadManagementProjectionLoadError({
                projectId: ProjectId.make("project"),
                threadId: ThreadId.make("bot-thread"),
                cause: new Error("snapshot interrupted"),
              });
            return { snapshotSequence: 42, projection: { messages: [] } };
          }),
        streamStoredEventsFrom: (input: unknown) => {
          assert.deepStrictEqual(input, {
            threadId: "bot-thread",
            afterSequence: 42,
            eventType: "message.updated",
          });
          streams++;
          return Stream.empty;
        },
      });
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        const read = (input: unknown) =>
          bridge.call({ ...voiceCaller, name: Bridge.T3_CHAT_UPDATES, input });
        assert.deepStrictEqual((yield* read({})).output, {
          error: "T3 could not read written chat updates. Retry from the last received message.",
          retryable: true,
        });
        assert.deepStrictEqual((yield* read({})).chatContext, { afterSequence: 42, messages: [] });
        assert.strictEqual(streams, 0);
        yield* read({ afterSequence: 42 });
        assert.deepStrictEqual([reads, streams], [2, 1]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["success", "failure", "forget"] as const)(
  "shares concurrent identical launches and releases the reservation on %s",
  (ending) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let launches = 0;
      let fail = ending === "failure";
      const layer = isolatedBridge(
        {},
        {
          ...watchedThread,
          call: () =>
            Effect.gen(function* () {
              launches++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              if (fail) return yield* Effect.die("launch failed");
              return {
                result: { kind: "served", output: { threadId: "new-thread" } },
              } as const;
            }),
        },
      );
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        const invoke = bridge.call({
          ...voiceCaller,
          name: "t3_thread_launch",
          input: { title: "Inspect project", projectId: "project" },
        });
        const first = yield* invoke.pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(entered);
        const second = yield* invoke.pipe(Effect.exit, Effect.forkChild);
        yield* Effect.yieldNow;
        assert.strictEqual(launches, 1);
        if (ending === "forget") yield* bridge.forget(voiceCaller.callId);
        yield* Deferred.succeed(release, undefined);
        const outcome = yield* Fiber.join(first);
        assert.deepStrictEqual(yield* Fiber.join(second), outcome);
        if (ending === "failure") {
          assert.strictEqual(outcome._tag, "Failure");
          fail = false;
          assert.strictEqual((yield* invoke).kind, "served");
          assert.strictEqual(launches, 2);
        } else {
          assert.strictEqual(outcome._tag, "Success");
          if (outcome._tag !== "Success") return;
          assert.strictEqual(outcome.value.kind, ending === "forget" ? "invalid_input" : "served");
          if (ending === "success") {
            assert.deepStrictEqual(yield* invoke, outcome.value);
            assert.strictEqual(launches, 1);
          }
        }
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["unwatch", "duplicate"] as const)(
  "rechecks a pending watch registration after %s during its baseline read",
  (ending) =>
    Effect.gen(function* () {
      const entered = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const release = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      let reads = 0;
      const layer = isolatedBridge(
        {
          getThreadRecords: () =>
            Effect.gen(function* () {
              const index = reads++;
              yield* Deferred.succeed(entered[index]!, undefined);
              yield* Deferred.await(release[index]!);
              return { runs: [] };
            }),
        },
        watchedThread,
      );
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        const first = yield* bridge
          .call({ ...voiceCaller, name: "t3_watch_thread", input: { threadId: "watched-thread" } })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered[0]!);
        const second = yield* bridge
          .call({
            ...voiceCaller,
            toolCallId: "second-watch",
            name: "t3_watch_thread",
            input: { threadId: "watched-thread" },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered[1]!);
        yield* Deferred.succeed(release[0]!, undefined);
        const initial = yield* Fiber.join(first);
        if (ending === "unwatch") {
          const stopped = yield* bridge.call({
            ...voiceCaller,
            name: Bridge.T3_UNWATCH_THREAD,
            input: { threadId: "watched-thread" },
          });
          assert.equal((stopped.output as { stopped: number }).stopped, 2);
        }
        yield* Deferred.succeed(release[1]!, undefined);
        const late = yield* Fiber.join(second);
        if (ending === "duplicate") assert.deepStrictEqual(late, initial);
        else assert.deepStrictEqual(late.output, { status: "watch_stopped" });
        const progress = yield* bridge.call({
          ...voiceCaller,
          name: Bridge.T3_TASK_PROGRESS,
          input: {},
        });
        assert.equal(
          (progress.output as { pending: number }).pending,
          ending === "unwatch" ? 0 : 1,
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["unwatch", "forget"] as const)(
  "does not publish a loaded result when %s occurs during the result read",
  (ending) =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const layer = isolatedBridge(
        {
          getThreadShell: () => Effect.succeed({ projectId: "project", title: "Watched work" }),
          waitForThread: () =>
            Effect.succeed({
              timedOut: false,
              run: { id: "watched-run", ordinal: 1, status: "completed" },
            }),
          getThreadRecords: (_threadId: unknown, fields: string[]) =>
            fields.includes("runs")
              ? Effect.succeed({ runs: [{ id: "watched-run", ordinal: 1, status: "completed" }] })
              : Effect.gen(function* () {
                  yield* Deferred.succeed(reading, undefined);
                  yield* Deferred.await(release);
                  return {
                    messages: [
                      {
                        role: "assistant",
                        runId: "watched-run",
                        streaming: false,
                        text: "Finished",
                      },
                    ],
                  };
                }),
        },
        watchedThread,
      );
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        yield* bridge.call({ ...voiceCaller, name: "t3_watch_thread", input: {} });
        const pending = yield* bridge
          .call({
            ...voiceCaller,
            toolCallId: "read",
            name: Bridge.T3_TASK_PROGRESS,
            input: { requestToolCallId: "launch" },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(reading);
        if (ending === "forget") yield* bridge.forget(voiceCaller.callId);
        else {
          const stopped = yield* bridge.call({
            ...voiceCaller,
            name: Bridge.T3_UNWATCH_THREAD,
            input: { threadId: "watched-thread" },
          });
          assert.strictEqual((stopped.output as { stopped: number }).stopped, 1);
        }
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(pending);
        assert.deepStrictEqual(
          result,
          ending === "forget"
            ? { kind: "invalid_input", output: { error: "unknown voice request" } }
            : {
                kind: "served",
                output: { status: "watch_stopped" },
                completion: { requestToolCallId: "launch", pending: false },
              },
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "counts delegated work as pending across a retryable read failure and settles only its completion",
  () =>
    Effect.gen(function* () {
      let waits = 0;
      const layer = isolatedBridge(
        {},
        {
          ...watchedThread,
          call: () =>
            Effect.succeed({
              result: { kind: "served", output: { taskId: "task" } },
              target: { taskId: "task" },
            }),
          wait: () =>
            Effect.sync(() => {
              if (++waits === 1)
                return {
                  pending: false,
                  result: {
                    kind: "invalid_input",
                    output: { error: "Read interrupted", retryable: true },
                  },
                } as const;
              return {
                pending: waits === 2,
                result: {
                  kind: "served",
                  output: { status: waits === 2 ? "running" : "completed" },
                },
              } as const;
            }),
        },
      );
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        yield* bridge.call({ ...voiceCaller, name: "delegate_task", input: {} });
        const progress = (input: unknown) =>
          bridge.call({ ...voiceCaller, name: Bridge.T3_TASK_PROGRESS, input });
        const count = Effect.map(
          progress({}),
          (result) => (result.output as { pending: number }).pending,
        );
        assert.strictEqual(yield* count, 1);
        const failed = yield* progress({ requestToolCallId: "launch" });
        assert.strictEqual(failed.kind, "invalid_input");
        assert.strictEqual(yield* count, 1);
        assert.strictEqual(
          (yield* progress({ requestToolCallId: "launch" })).completion?.pending,
          true,
        );
        assert.strictEqual(yield* count, 1);
        assert.strictEqual(
          (yield* progress({ requestToolCallId: "launch" })).completion?.pending,
          false,
        );
        assert.strictEqual(yield* count, 0);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([
  { runs: [], baseline: 0 },
  { runs: [{ ordinal: 7, status: "completed" }], baseline: 6 },
  {
    runs: [
      { ordinal: 3, status: "waiting" },
      { ordinal: 4, status: "completed" },
      { ordinal: 5, status: "queued" },
    ],
    baseline: 2,
  },
] as const)("initializes a persistent watch completion baseline from %o", ({ runs, baseline }) =>
  Effect.gen(function* () {
    const inputs: unknown[] = [];
    const layer = isolatedBridge(
      {
        getThreadShell: () => Effect.succeed({ projectId: "project", title: "Watched work" }),
        getThreadRecords: () => Effect.succeed({ runs }),
        waitForThread: (input: unknown) => {
          inputs.push(input);
          return Effect.succeed({ timedOut: true, run: null });
        },
      },
      watchedThread,
    );
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
      yield* bridge.call({ ...voiceCaller, name: "t3_watch_thread", input: {} });
      yield* bridge.call({
        ...voiceCaller,
        name: Bridge.T3_TASK_PROGRESS,
        input: { requestToolCallId: "launch", seenApprovalIds: [] },
      });
      assert.deepStrictEqual(inputs, [
        {
          projectId: "project",
          threadId: "watched-thread",
          followThread: true,
          completionAfterOrdinal: baseline,
          timeoutMs: 20_000,
          seenRequestIds: [],
        },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "does not flood or repeat 513 historical completions after the client acknowledgement ledger rolls over",
  () =>
    Effect.gen(function* () {
      const runs = Array.from({ length: 513 }, (_, index) => ({
        id: `run-${index + 1}`,
        ordinal: index + 1,
        status: "completed",
      }));
      const cursors: number[] = [];
      const loadedResults: string[] = [];
      let snapshots = 0;
      let future = false;
      const layer = isolatedBridge(
        {
          getThreadShell: () => Effect.succeed({ projectId: "project", title: "Watched work" }),
          getThreadRecords: (
            _threadId: unknown,
            fields: string[],
            filter: { messageRunIds: string[] },
          ) => {
            if (fields.includes("runs")) {
              snapshots++;
              return Effect.succeed({ runs });
            }
            const runId = filter.messageRunIds[0]!;
            loadedResults.push(runId);
            return Effect.succeed({
              messages: [{ role: "assistant", runId, streaming: false, text: `Finished ${runId}` }],
            });
          },
          waitForThread: ({ completionAfterOrdinal }: { completionAfterOrdinal: number }) => {
            cursors.push(completionAfterOrdinal);
            const next = runs.find((run) => run.ordinal > completionAfterOrdinal);
            const run =
              next ??
              (future ? { id: "run-514", ordinal: 514, status: "completed" } : runs.at(-1)!);
            return Effect.succeed({ run, timedOut: run.ordinal <= completionAfterOrdinal });
          },
        },
        watchedThread,
      );
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.GrokBotVoiceT3Bridge;
        yield* bridge.call({ ...voiceCaller, name: "t3_watch_thread", input: {} });
        const read = (seenApprovalIds: string[]) =>
          bridge.call({
            ...voiceCaller,
            name: Bridge.T3_TASK_PROGRESS,
            input: { requestToolCallId: "launch", seenApprovalIds },
          });
        const latest = yield* read([]);
        assert.strictEqual((latest.output as { runId: string }).runId, "run-513");
        const ledger = Array.from({ length: 511 }, (_, index) => `approval-${index}`);
        assert.isNull((yield* read([...ledger, "run:run-513"])).output);
        future = true;
        const next = yield* read([...ledger, "run:run-513"]);
        assert.strictEqual((next.output as { runId: string }).runId, "run-514");
        assert.isNull((yield* read([...ledger, "run:run-514"])).output);
        // Even the latest run acknowledgement can leave the bounded client ledger later.
        assert.isNull((yield* read([...ledger, "different-approval"])).output);
        assert.deepStrictEqual(cursors, [512, 513, 513, 514, 514]);
        assert.deepStrictEqual(loadedResults, ["run-513", "run-514"]);
        assert.strictEqual(snapshots, 1);
      }).pipe(Effect.provide(layer));
    }),
);
