import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { MessageId, ThreadId } from "@t3tools/contracts";
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
            getThreadShell: () => Effect.succeed({ projectId: "bot-project" }),
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
