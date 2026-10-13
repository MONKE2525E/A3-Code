import { assert, it } from "@effect/vitest";
import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  makeMuseAgentProjection,
  museHistoryFrame,
  stripMuseInlineMarkers,
} from "./MuseAgentAdapterV2Projection.ts";
import { instanceId, binding, threadId, makeTurn, receipt } from "./MuseAgentAdapterV2.testkit.ts";

const frame = (event: string, seq: number, payload: Record<string, unknown> = {}) => ({
  event,
  payload: {
    session_id: "primary",
    message_id: "assistant-1",
    reply_to_message_id: "user-1",
    ...payload,
  },
  meta: { seq, ts_ms: 1234 },
});
const attachment: ChatAttachment = {
  type: "file",
  id: "muse-file",
  name: "Report.txt",
  mimeType: "text/plain",
  sizeBytes: 16,
};

it("keeps an answer streaming when a presentation arrives before its remaining text", () => {
  const projection = makeMuseAgentProjection({
    binding,
    sessionId: "primary",
    threadId,
    providerInstanceId: instanceId,
  });
  projection.project(frame("delta.text_append", 1, { text: "Draft" }));
  projection.attach("assistant-1", [attachment]);
  projection.project(
    frame("delta.presentation", 2, {
      host_message_id: "assistant-1",
      display_text: "Report preview",
    }),
  );
  assert.strictEqual(projection.snapshot()[0]?.text, "Draft");
  assert.strictEqual(projection.snapshot()[0]?.streaming, true);
  projection.project(frame("delta.text_append", 3, { text: " continues" }));
  assert.strictEqual(projection.snapshot()[0]?.text, "Draft continues");
  assert.deepStrictEqual(projection.snapshot()[0]?.attachments, [attachment]);
});

it.effect(
  "adds persisted native attachments to one linked assistant item without losing text",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const projection = makeMuseAgentProjection({
        binding,
        sessionId: "primary",
        threadId,
        providerInstanceId: instanceId,
      });
      projection.begin(turn);
      projection.admit(receipt);
      const initial = projection
        .project(frame("message.assistant", 1, { display_text: "Here is the report." }))
        .find((event) => event.type === "turn_item.updated");
      const attached = projection.attach("assistant-1", [attachment]);
      const item = attached.find((event) => event.type === "turn_item.updated");
      assert.ok(initial && item && item.turnItem.type === "assistant_message");
      assert.strictEqual(item.turnItem.id, initial.turnItem.id);
      assert.strictEqual(item.turnItem.runId, turn.runId);
      assert.strictEqual(item.turnItem.providerTurnId, initial.turnItem.providerTurnId);
      assert.strictEqual(item.turnItem.text, "Here is the report.");
      assert.deepStrictEqual(item.turnItem.attachments, [attachment]);
      assert.deepStrictEqual(projection.attach("assistant-1", [attachment]), []);
      projection.project(
        frame("message.assistant", 2, { display_text: "Updated report caption." }),
      );
      assert.deepStrictEqual(projection.snapshot()[0]?.attachments, [attachment]);
    }),
);

it.effect(
  "buffers attachment metadata before its native message and links an attachment-only answer to its receipt",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const projection = makeMuseAgentProjection({
        binding,
        sessionId: "primary",
        threadId,
        providerInstanceId: instanceId,
      });
      projection.begin(turn);
      projection.admit(receipt);
      assert.deepStrictEqual(projection.attach("assistant-1", [attachment]), []);
      const batch = projection.project(
        frame("delta.presentation", 2, {
          message_id: "presentation-1",
          host_message_id: "assistant-1",
          kind: "file",
        }),
      );
      const item = batch.find((event) => event.type === "turn_item.updated");
      assert.ok(item && item.turnItem.type === "assistant_message");
      assert.strictEqual(item.turnItem.nativeItemRef?.nativeId, "assistant-1");
      assert.strictEqual(item.turnItem.runId, turn.runId);
      assert.deepStrictEqual(item.turnItem.attachments, [attachment]);
      const corrected = projection
        .project(frame("message.assistant", 3, { display_text: "Report caption." }))
        .find((event) => event.type === "turn_item.updated");
      assert.ok(corrected);
      assert.strictEqual(corrected.turnItem.id, item.turnItem.id);
    }),
);

it("never accepts T3 attachment metadata from arbitrary native JSON and reports unavailable media once", () => {
  const projection = makeMuseAgentProjection({
    binding,
    sessionId: "primary",
    threadId,
    providerInstanceId: instanceId,
  });
  assert.deepStrictEqual(
    projection.project(
      frame("delta.presentation", 1, { host_message_id: "assistant-1", attachments: [attachment] }),
    ),
    [],
  );
  projection.project(
    frame("message.assistant", 2, { display_text: "Text survives.", attachments: [attachment] }),
  );
  assert.deepStrictEqual(projection.snapshot()[0]?.attachments, []);
  const notice = projection.attachmentFailed("assistant-1");
  assert.strictEqual(notice.length, 1);
  assert.ok(notice[0]?.type === "turn_item.updated" && notice[0].turnItem.type === "system_notice");
  assert.deepStrictEqual(projection.attachmentFailed("assistant-1"), []);
  assert.strictEqual(projection.snapshot()[0]?.text, "Text survives.");
});

it.effect(
  "buffers early admission events, deduplicates replay, and keeps partial output on native failure",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const projection = makeMuseAgentProjection({
        binding,
        sessionId: "primary",
        threadId,
        providerInstanceId: instanceId,
      });
      projection.begin(turn);
      const first = frame("delta.text_append", 2, {
        parent_message_id: "assistant-1",
        text: "Partial",
      });
      assert.deepStrictEqual(projection.project(first), []);
      projection.admit(receipt);
      assert.strictEqual(projection.snapshot()[0]?.text, "Partial");
      assert.deepStrictEqual(projection.project(first), []);
      assert.deepStrictEqual(
        projection.project(frame("delta.text_append", 1, { text: "old" })),
        [],
      );
      const batch = projection.project(frame("delta.turn_done", 3, { status: "failed" }));
      assert.strictEqual(projection.snapshot()[0]?.streaming, false);
      assert.strictEqual(projection.snapshot()[0]?.text, "Partial");
      assert.strictEqual(batch.filter((event) => event.type === "turn.terminal").length, 1);
      assert.deepStrictEqual(
        projection.project(frame("delta.turn_done", 3, { status: "failed" })),
        [],
      );
    }),
);

it.effect(
  "requires an owned turn_done and never settles on message completion, idle, foreign replies or subagents",
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
      const canonical = projection.project(
        frame("message.assistant", 100, {
          display_text: "Answer",
          display_text_ready: true,
          status: "completed",
        }),
      );
      assert.strictEqual(
        canonical.some((event) => event.type === "turn.terminal"),
        false,
      );
      for (const payload of [
        { reply_to_message_id: "unrelated", status: "completed" },
        { session_id: "side", status: "completed" },
        { stream_lane: "subagent", status: "completed" },
        { status: "idle" },
      ]) {
        assert.deepStrictEqual(projection.project(frame("delta.turn_done", 10, payload)), []);
      }
      const terminal = projection.project(frame("delta.turn_done", 11, { status: "cancelled" }));
      assert.strictEqual(
        terminal.find((event) => event.type === "turn.terminal")?.status,
        "cancelled",
      );
      assert.deepStrictEqual(
        projection.project(frame("delta.text_append", 12, { text: "Late" })),
        [],
      );
      assert.strictEqual(projection.snapshot()[0]?.text, "Answer");
    }),
);

it.effect(
  "keeps stream and canonical sequence spaces separate and accepts nullable history envelopes",
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
      projection.project(frame("delta.text_append", 1000, { text: "Draft" }));
      const history = museHistoryFrame(
        {
          event_name: "message.assistant",
          seq: 5,
          occurred_at_ms: 1234,
          message_id: "assistant-1",
          reply_to_message_id: null,
          display_text: "Canonical",
          display_text_ready: true,
          payload: { session_id: "primary" },
        },
        "primary",
      );
      assert.ok(history);
      projection.project(history);
      assert.strictEqual(projection.snapshot()[0]?.text, "Canonical");
      assert.strictEqual(projection.snapshot()[0]?.runId, (yield* makeTurn).runId);
      assert.deepStrictEqual(
        projection.project(frame("delta.text_append", 1001, { text: "Duplicate" })),
        [],
      );
    }),
);

it("projects runless native history into stable, linked chat items", () => {
  const projection = makeMuseAgentProjection({
    binding,
    sessionId: "primary",
    threadId,
    providerInstanceId: instanceId,
  });
  const rows = [
    frame("message.user", 1, {
      message_id: "historic-user",
      reply_to_message_id: null,
      display_text: "Earlier question",
    }),
    frame("message.assistant", 2, {
      message_id: "historic-answer",
      reply_to_message_id: "historic-user",
      display_text: "Earlier answer",
    }),
  ];
  const events = rows.flatMap((row) => projection.project(row));
  const items = events
    .filter((event) => event.type === "turn_item.updated")
    .map((event) => event.turnItem);
  assert.deepStrictEqual(
    items.map((item) => item.type),
    ["user_message", "assistant_message"],
  );
  assert.deepStrictEqual(
    items.map((item) => item.runId),
    [null, null],
  );
  assert.deepStrictEqual(
    items.map((item) => item.providerTurnId),
    [null, null],
  );
  assert.strictEqual(items[0]?.providerThreadId, items[1]?.providerThreadId);
  assert.notStrictEqual(items[0]?.id, items[1]?.id);
  for (const item of items) {
    const message = events.find(
      (event) =>
        event.type === "message.updated" &&
        event.message.id ===
          (item.type === "user_message" || item.type === "assistant_message"
            ? item.messageId
            : null),
    );
    assert.ok(message?.type === "message.updated");
    assert.strictEqual(item.startedAt, message.message.createdAt);
    assert.strictEqual(item.status, "completed");
  }
  assert.deepStrictEqual(
    rows.flatMap((row) => projection.project(row)),
    [],
  );
  const refreshed = makeMuseAgentProjection({
    binding,
    sessionId: "primary",
    threadId,
    providerInstanceId: instanceId,
  });
  assert.deepStrictEqual(
    rows
      .flatMap((row) => refreshed.project(row))
      .filter((event) => event.type === "turn_item.updated")
      .map((event) => event.turnItem.id),
    items.map((item) => item.id),
  );
});

it("gives unchanged canonical history its own stable order without using stream sequence or reverting text", () => {
  const projection = makeMuseAgentProjection({
    binding,
    sessionId: "primary",
    threadId,
    providerInstanceId: instanceId,
  });
  projection.project(frame("delta.text_append", 1000, { text: "Current" }));
  projection.project(frame("delta.message_done", 1001, { display_text: "Current" }));
  const canonical = projection.project(frame("message.assistant", 20, { display_text: "Current" }));
  const canonicalItem = canonical.find((event) => event.type === "turn_item.updated");
  assert.strictEqual(
    canonicalItem?.type === "turn_item.updated"
      ? canonicalItem.turnItem.canonicalNativeSequence
      : undefined,
    20,
  );
  const older = projection.project(frame("message.assistant", 5, { display_text: "Outdated" }));
  const olderItem = older.find((event) => event.type === "turn_item.updated");
  assert.strictEqual(
    olderItem?.type === "turn_item.updated"
      ? olderItem.turnItem.canonicalNativeSequence
      : undefined,
    5,
  );
  assert.strictEqual(projection.snapshot()[0]?.text, "Current");
});

it.effect(
  "updates one managed answer item through streaming, canonical replacement and terminal",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const projection = makeMuseAgentProjection({
        binding,
        sessionId: "primary",
        threadId,
        providerInstanceId: instanceId,
      });
      const providerTurnId = projection.begin(turn);
      projection.admit(receipt);
      assert.deepStrictEqual(
        projection.project(
          frame("message.user", 1, {
            message_id: receipt.messageId,
            display_text: "Synthetic task",
          }),
        ),
        [],
      );
      const batches = [
        projection.project(frame("delta.message_start", 1)),
        projection.project(
          frame("delta.text_append", 2, { parent_message_id: "assistant-1", text: "Draft" }),
        ),
        projection.project(frame("message.assistant", 3, { display_text: "Final answer" })),
      ];
      const items = batches.flatMap((batch) =>
        batch.filter((event) => event.type === "turn_item.updated").map((event) => event.turnItem),
      );
      assert.strictEqual(items.length, 3);
      assert.strictEqual(new Set(items.map((item) => item.id)).size, 1);
      assert.strictEqual(new Set(items.map((item) => item.startedAt)).size, 1);
      assert.deepStrictEqual(
        items.map((item) => item.status),
        ["running", "running", "completed"],
      );
      assert.deepStrictEqual(
        items.map((item) => (item.type === "assistant_message" ? item.text : null)),
        ["", "Draft", "Final answer"],
      );
      for (const item of items) {
        assert.strictEqual(item.runId, turn.runId);
        assert.strictEqual(item.nodeId, turn.rootNodeId);
        assert.strictEqual(item.providerThreadId, turn.providerThread.id);
        assert.strictEqual(item.providerTurnId, providerTurnId);
        assert.strictEqual(item.nativeItemRef?.nativeId, "assistant-1");
      }
      assert.deepStrictEqual(
        projection.project(frame("delta.text_append", 4, { text: "late" })),
        [],
      );
      assert.strictEqual(
        projection
          .project(frame("delta.turn_done", 5, { status: "completed" }))
          .filter((event) => event.type === "turn_item.updated").length,
        0,
      );
    }),
);

it.effect("finalizes partial chat items before failure and preserves their managed link", () =>
  Effect.gen(function* () {
    const projection = makeMuseAgentProjection({
      binding,
      sessionId: "primary",
      threadId,
      providerInstanceId: instanceId,
    });
    projection.begin(yield* makeTurn);
    projection.admit(receipt);
    const initial = projection
      .project(frame("delta.text_append", 1, { text: "Partial answer" }))
      .find((event) => event.type === "turn_item.updated");
    const failed = projection.project(frame("delta.turn_done", 2, { status: "failed" }));
    assert.deepStrictEqual(
      failed.map((event) => event.type),
      ["message.updated", "turn_item.updated", "provider_turn.updated", "turn.terminal"],
    );
    const final = failed.find((event) => event.type === "turn_item.updated");
    assert.ok(initial && final);
    assert.strictEqual(initial.turnItem.id, final.turnItem.id);
    assert.strictEqual(initial.turnItem.providerTurnId, final.turnItem.providerTurnId);
    assert.ok(final.turnItem.type === "assistant_message");
    assert.strictEqual(final.turnItem.text, "Partial answer");
    assert.strictEqual(final.turnItem.streaming, false);
    assert.strictEqual(final.turnItem.completedAt, final.turnItem.updatedAt);
  }),
);

it.effect("associates earlier canonical history without duplicating or moving its chat item", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const projection = makeMuseAgentProjection({
      binding,
      sessionId: "primary",
      threadId,
      providerInstanceId: instanceId,
    });
    const historical = frame("message.assistant", 2, { display_text: "Replayed owned answer" });
    const before = projection
      .project(historical)
      .find((event) => event.type === "turn_item.updated");
    const providerTurnId = projection.begin(turn);
    const admitted = projection.admit(receipt).find((event) => event.type === "turn_item.updated");
    assert.ok(before && admitted);
    assert.strictEqual(admitted.turnItem.id, before.turnItem.id);
    assert.strictEqual(admitted.turnItem.startedAt, before.turnItem.startedAt);
    assert.strictEqual(admitted.turnItem.runId, turn.runId);
    assert.strictEqual(admitted.turnItem.providerTurnId, providerTurnId);
    assert.deepStrictEqual(projection.project(historical), []);
    assert.strictEqual(projection.snapshot().length, 1);
    const corrected = projection
      .project(
        frame("message.assistant", 3, {
          display_text: "Corrected answer",
          reply_to_message_id: null,
        }),
      )
      .find((event) => event.type === "turn_item.updated");
    assert.ok(corrected);
    assert.strictEqual(corrected.turnItem.id, before.turnItem.id);
    assert.strictEqual(corrected.turnItem.providerTurnId, providerTurnId);
  }),
);

it.effect("interrupts superseded delivery without borrowing the replacement root answer", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const projection = makeMuseAgentProjection({
      binding,
      sessionId: "primary",
      threadId,
      providerInstanceId: instanceId,
    });
    projection.begin(turn);
    projection.admit(receipt);
    projection.project(frame("delta.text_append", 1, { text: "Owned partial" }));
    const interrupted = projection.project({
      event: "transport.turn_superseded",
      payload: {
        session_id: receipt.sessionId,
        message_id: receipt.messageId,
        reply_to_message_id: receipt.replyToMessageId,
      },
    });
    assert.deepStrictEqual(
      interrupted.map((event) => event.type),
      ["message.updated", "turn_item.updated", "provider_turn.updated", "turn.terminal"],
    );
    assert.strictEqual(
      interrupted.find((event) => event.type === "turn.terminal")?.status,
      "interrupted",
    );
    assert.strictEqual(projection.isTerminal(), true);
    assert.deepStrictEqual(
      projection.project({
        event: "transport.turn_superseded",
        payload: {
          session_id: receipt.sessionId,
          message_id: receipt.messageId,
          reply_to_message_id: receipt.replyToMessageId,
        },
      }),
      [],
    );
    assert.deepStrictEqual(
      projection.project(
        frame("delta.text_append", 2, { text: "Replacement text", reply_to_message_id: "" }),
      ),
      [],
    );
    assert.deepStrictEqual(
      projection.project(
        frame("delta.message_done", 3, {
          display_text: "Replacement answer",
          reply_to_message_id: "",
        }),
      ),
      [],
    );
    assert.strictEqual(projection.snapshot()[0]?.text, "Owned partial");
    const foreign = projection.project(
      frame("message.assistant", 4, {
        message_id: "foreign-answer",
        reply_to_message_id: "foreign-user",
        display_text: "Different conversation",
      }),
    );
    const item = foreign.find((event) => event.type === "turn_item.updated")?.turnItem;
    assert.ok(item);
    assert.strictEqual(item.runId, null);
    assert.strictEqual(item.providerTurnId, null);
    assert.strictEqual(item.nodeId, null);
  }),
);

it.effect("buffers authenticated supersession until receipt admission", () =>
  Effect.gen(function* () {
    const projection = makeMuseAgentProjection({
      binding,
      sessionId: "primary",
      threadId,
      providerInstanceId: instanceId,
    });
    assert.deepStrictEqual(
      projection.project({
        event: "transport.turn_superseded",
        payload: {
          session_id: receipt.sessionId,
          message_id: receipt.messageId,
          reply_to_message_id: receipt.replyToMessageId,
        },
      }),
      [],
    );
    projection.begin(yield* makeTurn);
    assert.deepStrictEqual(
      projection.project({
        event: "transport.turn_superseded",
        payload: {
          session_id: receipt.sessionId,
          message_id: receipt.messageId,
          reply_to_message_id: receipt.replyToMessageId,
        },
      }),
      [],
    );
    const admitted = projection.admit(receipt);
    assert.strictEqual(
      admitted.find((event) => event.type === "turn.terminal")?.status,
      "interrupted",
    );
    assert.strictEqual(projection.isTerminal(), true);
  }),
);

it.effect("rejects blank, foreign and delayed prior-delivery supersession notices", () =>
  Effect.gen(function* () {
    const projection = makeMuseAgentProjection({
      binding,
      sessionId: "primary",
      threadId,
      providerInstanceId: instanceId,
    });
    projection.begin(yield* makeTurn);
    const currentReceipt = { ...receipt, messageId: "new-user", replyToMessageId: "new-carrier" };
    const oldNotice = {
      event: "transport.turn_superseded",
      payload: {
        session_id: "primary",
        message_id: receipt.messageId,
        reply_to_message_id: receipt.replyToMessageId,
      },
    };
    projection.project(oldNotice);
    assert.strictEqual(
      projection.admit(currentReceipt).some((event) => event.type === "turn.terminal"),
      false,
    );
    for (const payload of [
      undefined,
      {},
      oldNotice.payload,
      {
        session_id: "side",
        message_id: currentReceipt.messageId,
        reply_to_message_id: currentReceipt.replyToMessageId,
      },
      {
        session_id: "primary",
        message_id: currentReceipt.messageId,
        reply_to_message_id: "foreign-carrier",
      },
    ]) {
      assert.deepStrictEqual(
        projection.project({ event: "transport.turn_superseded", ...(payload ? { payload } : {}) }),
        [],
      );
      assert.strictEqual(projection.isTerminal(), false);
    }
    assert.strictEqual(
      projection
        .project({
          event: "transport.turn_superseded",
          payload: {
            session_id: currentReceipt.sessionId,
            message_id: currentReceipt.messageId,
            reply_to_message_id: currentReceipt.replyToMessageId,
          },
        })
        .find((event) => event.type === "turn.terminal")?.status,
      "interrupted",
    );
  }),
);

it("drops Muse inline markers and keeps the words around them", () => {
  assert.strictEqual(
    stripMuseInlineMarkers("On it. Which model?\n[[hatch_widget:widget-5419bf8d]]"),
    "On it. Which model?",
  );
  assert.strictEqual(
    stripMuseInlineMarkers(
      "Now they're giving this guy tips.\n[image:image/jpeg workspace/user/files/screenshot.png]",
    ),
    "Now they're giving this guy tips.",
  );
  assert.strictEqual(stripMuseInlineMarkers("plain reply"), "plain reply");
});
