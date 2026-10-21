import { assert, it } from "@effect/vitest";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { MuseAgentNativeEvent } from "../../museAgent/MuseAgentTransport.ts";
import { makeMuseAgentProjection } from "./MuseAgentAdapterV2Projection.ts";
import { instanceId, binding, makeTurn, receipt, threadId } from "./MuseAgentAdapterV2.testkit.ts";

const root = "native-root-task";
const frame = (
  event: string,
  payload: Record<string, unknown>,
  time = 1200,
): MuseAgentNativeEvent => ({
  event,
  payload: { session_id: "primary", ...payload },
  meta: { seq: time, ts_ms: time },
});
const user = (messageId = receipt.messageId, time = 1000) =>
  frame("message.user", { message_id: messageId, parent_agent_id: root }, time);
const task = (payload: Record<string, unknown> = {}, time = 1200) =>
  frame(
    "task.status",
    {
      task_id: root,
      agent_id: root,
      root_agent_id: root,
      active_subagent_count: 0,
      status: "completed",
      ...payload,
    },
    time,
  );
const answer = (payload: Record<string, unknown> = {}, time = 1150) =>
  frame(
    "delta.message_done",
    {
      message_id: "assistant-1",
      agent_id: root,
      reply_to_message_id: "",
      display_text: "Answer",
      ...payload,
    },
    time,
  );
const started = Effect.gen(function* () {
  const projection = makeMuseAgentProjection({
    binding,
    sessionId: "primary",
    threadId,
    providerInstanceId: instanceId,
  });
  projection.begin(yield* makeTurn);
  projection.admit(receipt);
  projection.project(user());
  projection.project(task({ status: "running" }, 1050));
  return projection;
});

it.effect(
  "finishes the fenced root task once after canonical output, although task and receipt IDs differ",
  () =>
    Effect.gen(function* () {
      const projection = yield* started;
      projection.project(answer());
      const events = projection.project(task());
      assert.strictEqual(
        events.find((event) => event.type === "turn.terminal")?.status,
        "completed",
      );
      assert.strictEqual(projection.snapshot()[0]?.runId, (yield* makeTurn).runId);
      assert.strictEqual(projection.snapshot()[0]?.text, "Answer");
      assert.strictEqual(projection.isTerminal(), true);
      assert.deepStrictEqual(projection.project(task()), []);
    }),
);

it.effect("pins reordered running evidence by native timestamp and buffers before admission", () =>
  Effect.gen(function* () {
    const projection = makeMuseAgentProjection({
      binding,
      sessionId: "primary",
      threadId,
      providerInstanceId: instanceId,
    });
    projection.begin(yield* makeTurn);
    for (const event of [task({ status: "running" }, 1050), user(), answer(), task()])
      assert.deepStrictEqual(projection.project(event), []);
    assert.strictEqual(
      projection.admit(receipt).filter((event) => event.type === "turn.terminal").length,
      1,
    );
  }),
);

it.effect("holds root completion until the canonical assistant arrives", () =>
  Effect.gen(function* () {
    const projection = yield* started;
    assert.deepStrictEqual(projection.project(task()), []);
    assert.strictEqual(projection.isTerminal(), false);
    assert.deepStrictEqual(
      projection.project(answer({}, 1250)).map((event) => event.type),
      ["message.updated", "turn_item.updated", "provider_turn.updated", "turn.terminal"],
    );
  }),
);

it.effect("newer root running evidence invalidates a pending completion", () =>
  Effect.gen(function* () {
    const projection = yield* started;
    projection.project(task());
    projection.project(task({ status: "running" }, 1250));
    const answerEvents = projection.project(answer({}, 1300));
    assert.strictEqual(
      answerEvents.some((event) => event.type === "turn.terminal"),
      false,
    );
    assert.strictEqual(projection.isTerminal(), false);
    assert.strictEqual(
      projection.project(task({}, 1400)).find((event) => event.type === "turn.terminal")?.status,
      "completed",
    );
  }),
);

it.effect("rejects foreign, child, old and incomplete terminal evidence", () =>
  Effect.gen(function* () {
    const projection = yield* started;
    projection.project(answer());
    for (const payload of [
      { session_id: "side" },
      { task_id: "foreign" },
      { agent_id: "child" },
      { root_agent_id: "foreign" },
      { root_agent_id: undefined },
      { active_subagent_count: 1 },
      { active_subagent_count: undefined },
      { active_subagent_count: -1 },
      { active_subagent_count: "0" },
      { stream_lane: "subagent" },
      { transcript_surface: "subagent" },
      { status: "idle" },
      { status: "waiting" },
    ]) {
      assert.deepStrictEqual(projection.project(task(payload)), []);
      assert.strictEqual(projection.isTerminal(), false);
    }
    assert.deepStrictEqual(projection.project(task({}, 900)), []);
    assert.strictEqual(
      projection.project(task()).find((event) => event.type === "turn.terminal")?.status,
      "completed",
    );
  }),
);

it.effect("requires the exact owned user boundary and its root running event", () =>
  Effect.gen(function* () {
    for (const frames of [
      [task({ status: "running" }, 1050), answer()],
      [user(), answer()],
      [task({ status: "running" }, 900), user(), answer()],
      [
        user(),
        task(
          { status: "running", task_id: "foreign", agent_id: "foreign", root_agent_id: "foreign" },
          1050,
        ),
        answer(),
      ],
    ]) {
      const projection = makeMuseAgentProjection({
        binding,
        sessionId: "primary",
        threadId,
        providerInstanceId: instanceId,
      });
      projection.begin(yield* makeTurn);
      projection.admit(receipt);
      for (const event of frames) projection.project(event);
      assert.deepStrictEqual(projection.project(task()), []);
      assert.strictEqual(projection.isTerminal(), false);
    }
  }),
);

it.effect("new foreign users revoke ownership while historical users cannot", () =>
  Effect.gen(function* () {
    const historical = yield* started;
    historical.project(user("historical", 900));
    historical.project(answer());
    assert.strictEqual(
      historical.project(task()).find((event) => event.type === "turn.terminal")?.status,
      "completed",
    );
    const superseded = yield* started;
    superseded.project(user("foreign", 1100));
    superseded.project(answer());
    assert.deepStrictEqual(superseded.project(task()), []);
    assert.strictEqual(superseded.isTerminal(), false);
    assert.strictEqual(
      superseded.snapshot().find((message) => message.role === "assistant")?.runId,
      null,
    );
  }),
);

it.effect(
  "message completion and agent idle do not settle, and root failure preserves partial output",
  () =>
    Effect.gen(function* () {
      const projection = yield* started;
      projection.project(answer());
      assert.strictEqual(projection.isTerminal(), false);
      assert.deepStrictEqual(
        projection.project(
          frame("agent.status", { agent_id: root, activity_code: "idle", count: 0 }),
        ),
        [],
      );
      const partial = yield* started;
      partial.project(
        frame(
          "delta.text_append",
          { message_id: "partial", agent_id: root, text: "Partial answer" },
          1100,
        ),
      );
      assert.strictEqual(
        partial.project(task({ status: "failed" })).find((event) => event.type === "turn.terminal")
          ?.status,
        "failed",
      );
      assert.strictEqual(partial.snapshot()[0]?.text, "Partial answer");
      assert.strictEqual(partial.snapshot()[0]?.streaming, false);
    }),
);

it.effect(
  "a previous attempt's delayed terminal cannot settle the next attempt on the reused root",
  () =>
    Effect.gen(function* () {
      const projection = yield* started;
      const turn = yield* makeTurn;
      projection.project(answer());
      projection.project(task());
      projection.begin({
        ...turn,
        runId: RunId.make("next-run"),
        attemptId: RunAttemptId.make("next-attempt"),
        runOrdinal: 2,
      });
      projection.admit({ ...receipt, messageId: "next-user", replyToMessageId: "next-carrier" });
      projection.project(user("next-user", 2000));
      projection.project(task({ status: "running" }, 2050));
      projection.project(answer({ message_id: "next-assistant" }, 2100));
      assert.deepStrictEqual(projection.project(task()), []);
      assert.strictEqual(projection.isTerminal(), false);
      assert.strictEqual(
        projection.project(task({}, 2200)).find((event) => event.type === "turn.terminal")
          ?.runOrdinal,
        2,
      );
    }),
);

it.effect(
  "settles the captured reordered root trace as interrupted after a foreign user supersedes admission",
  () =>
    Effect.gen(function* () {
      const projection = makeMuseAgentProjection({
        binding,
        sessionId: "primary",
        threadId,
        providerInstanceId: instanceId,
      });
      projection.begin(yield* makeTurn);
      projection.admit(receipt);
      // Native task sequence and canonical history sequence differ, and running arrives first.
      projection.project({
        ...task({ status: "running" }, 1791881772132),
        meta: { seq: 34438, ts_ms: 1791881772132 },
      });
      projection.project({
        ...user(receipt.messageId, 1791881772049),
        meta: { seq: 34135, ts_ms: 1791881772049 },
      });
      const interrupted = projection.project({
        event: "transport.turn_superseded",
        payload: {
          session_id: receipt.sessionId,
          message_id: receipt.messageId,
          reply_to_message_id: receipt.replyToMessageId,
        },
      });
      projection.project({
        ...user("foreign-user", 1791881819298),
        meta: { seq: 34137, ts_ms: 1791881819298 },
      });
      projection.project(
        frame(
          "delta.message_start",
          {
            message_id: "replacement-answer",
            agent_id: root,
            parent_agent_id: root,
            reply_to_message_id: "",
            seq: 1,
          },
          1791881827541,
        ),
      );
      // Append events identify the parent root instead of including agent_id.
      projection.project(
        frame(
          "delta.text_append",
          {
            message_id: "replacement-answer",
            parent_agent_id: root,
            reply_to_message_id: "",
            text: "Replacement text",
            seq: 2,
          },
          1791881827557,
        ),
      );
      const done = projection.project(
        answer({ message_id: "replacement-answer", parent_agent_id: root, seq: 20 }, 1791881828599),
      );
      assert.strictEqual(
        interrupted.find((event) => event.type === "turn.terminal")?.status,
        "interrupted",
      );
      assert.strictEqual(
        done.some((event) => event.type === "turn.terminal"),
        false,
      );
      assert.deepStrictEqual(projection.project(task({}, 1791881828637)), []);
      const reply = projection.snapshot().find((message) => message.role === "assistant");
      assert.ok(reply);
      assert.strictEqual(reply.runId, null);
      assert.strictEqual(reply.nodeId, null);
      assert.strictEqual(projection.isTerminal(), true);
    }),
);
