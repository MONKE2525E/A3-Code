import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GrokBotThreadService from "../GrokBotThreadService.ts";
import * as Bridge from "./GrokBotVoiceT3Bridge.ts";

const sent: Array<{ input: unknown; caller: unknown }> = [];

const harness = Bridge.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(GrokBotThreadService.GrokBotThreadService, {
        send: (input: unknown, caller: unknown) =>
          Effect.sync(() => {
            sent.push({ input, caller });
            return { accepted: true, delivery: "started" as const };
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
    "t3_run_task",
    "t3_project_list",
    "t3_task_progress",
  ]);
  assert.isTrue(Bridge.isRoutedLocally("send_task"));
  assert.isTrue(Bridge.isRoutedLocally("t3_run_task"));
  assert.isFalse(Bridge.isRoutedLocally("recall_text_messages"));
  assert.isTrue(Bridge.isNativeControl("recall_text_messages"));
  assert.isFalse(Bridge.isNativeControl("delegate_task"));
});

it.effect("run_task sends under the call's bot and ignores any model-supplied authority", () =>
  Effect.gen(function* () {
    sent.length = 0;
    const outcome = yield* call("t3_run_task", {
      task: "fix the build",
      projectId: "p1",
      botId: "evil",
      binding: "other",
    });
    assert.strictEqual(outcome.kind, "served");
    const [only] = sent as any[];
    assert.strictEqual(only.input.botId, "bot-1");
    assert.strictEqual(only.input.clientRequestId, "voice:call-1:tc-1");
    assert.include(only.input.message, "Project: p1");
    assert.strictEqual(only.caller.requestNamespace, "grok-bot-voice:acct:bot-1");
    assert.strictEqual(only.caller.voiceRequest, true);
    assert.strictEqual(only.caller.creationSource, undefined);
    assert.isUndefined(only.caller.senderThreadId);
  }),
);

it.effect("run_task is refused for a read-only principal and for bad input", () =>
  Effect.gen(function* () {
    sent.length = 0;
    yield* call("t3_run_task", { task: "x" }, "read");
    assert.strictEqual(sent.length, 0);
    const bad = yield* call("t3_run_task", { task: "" });
    assert.strictEqual(bad.kind, "invalid_input");
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

it.effect("project list hides deleted projects; progress reports the latest run", () =>
  Effect.gen(function* () {
    const list = yield* call("t3_project_list", {}, "read");
    assert.deepStrictEqual((list.output as any).projects, [{ projectId: "p1", title: "One" }]);
    const progress = yield* call("t3_task_progress", {}, "read");
    assert.deepStrictEqual(progress.output, { spoken: "The latest T3 run is running." });
  }),
);
