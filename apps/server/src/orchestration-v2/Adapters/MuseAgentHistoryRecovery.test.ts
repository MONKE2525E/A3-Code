import { assert, it } from "@effect/vitest";
import {
  RunId,
  RunAttemptId,
  NodeId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { MuseAgentHistoryOwnership } from "../../museAgent/MuseAgentDeliveryOwnership.ts";
import { makeMuseAgentProjection } from "./MuseAgentAdapterV2Projection.ts";
import { binding, instanceId, makeTurn, receipt, threadId } from "./MuseAgentAdapterV2.testkit.ts";

const makeProjection = (ownership?: MuseAgentHistoryOwnership) =>
  makeMuseAgentProjection({
    binding,
    providerInstanceId: instanceId,
    sessionId: "primary",
    threadId,
    ...(ownership ? { ownership } : {}),
  });

const user = {
  event: "message.user",
  payload: {
    session_id: "primary",
    message_id: receipt.messageId,
    display_text: "Synthetic task",
  },
  meta: { seq: 1, ts_ms: 1_000 },
};
const answer = {
  event: "message.assistant",
  payload: {
    session_id: "primary",
    message_id: "assistant-restart-test",
    reply_to_message_id: receipt.replyToMessageId,
    display_text: "Synthetic answer",
  },
  meta: { seq: 2, ts_ms: 2_000 },
};

it.effect("keeps terminal owned output unchanged when the native message ID is reused later", () =>
  Effect.gen(function* () {
    const projection = makeProjection();
    projection.begin(yield* makeTurn);
    projection.admit(receipt);
    projection.project(answer);
    projection.project({
      event: "delta.turn_done",
      payload: {
        session_id: "primary",
        reply_to_message_id: receipt.messageId,
        status: "completed",
      },
      meta: { seq: 3, ts_ms: 3_000 },
    });
    assert.strictEqual(projection.isTerminal(), true);
    const turn = yield* makeTurn;
    projection.begin({
      ...turn,
      runId: RunId.make("next-run"),
      attemptId: RunAttemptId.make("next-attempt"),
      rootNodeId: NodeId.make("next-node"),
      runOrdinal: 2,
    });
    projection.admit({
      sessionId: "primary",
      messageId: "next-user",
      replyToMessageId: "next-carrier",
    });
    assert.deepStrictEqual(
      projection.project({
        ...answer,
        payload: {
          ...answer.payload,
          display_text: "Foreign replacement",
          reply_to_message_id: "",
        },
        meta: { seq: 4, ts_ms: 4_000 },
      }),
      [],
    );
    assert.strictEqual(projection.snapshot()[0]?.text, "Synthetic answer");
  }),
);

it.effect("does not import a managed user echo as a second message after reopening", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const before = makeProjection();
    const providerTurnId = before.begin(turn);
    before.admit(receipt);
    assert.deepStrictEqual(before.project(user), []);

    const reopened = makeProjection({
      receipts: [
        {
          ...receipt,
          context: {
            threadId,
            providerInstanceId: instanceId,
            runId: turn.runId,
            nodeId: turn.rootNodeId,
            providerThreadId: turn.providerThread.id,
            providerTurnId,
            userMessageId: turn.message.messageId,
          },
        },
      ],
      messages: [],
    });
    const replayed = reopened.project(user).filter((event) => event.type === "message.updated");
    // The native receipt identifies the already-persisted T3 user message. A restart
    // must either suppress its echo or update that original identity, never insert another.
    assert.ok(replayed.every((event) => event.message.id === turn.message.messageId));
  }),
);

it.effect("preserves a managed assistant's run association when reopening native history", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const persisted = new Map<string, OrchestrationV2ConversationMessage>();
    const write = (events: ReturnType<ReturnType<typeof makeProjection>["project"]>) => {
      for (const event of events)
        if (event.type === "message.updated") persisted.set(event.message.id, event.message);
    };
    const before = makeProjection();
    const providerTurnId = before.begin(turn);
    before.admit(receipt);
    const original = before.project(answer);
    write(original);
    const owned = [...persisted.values()][0];
    assert.ok(owned);
    assert.strictEqual(owned.runId, turn.runId);

    // ProjectionStore's message upsert replaces run_id and node_id, including null.
    // The reopened adapter must therefore carry the durable ownership into its replay.
    const item = original.find((event) => event.type === "turn_item.updated");
    assert.ok(item);
    const reopened = makeProjection({
      receipts: [],
      messages: [
        {
          nativeMessageId: answer.payload.message_id,
          deliveryKey: turn.attemptId,
          context: {
            threadId,
            providerInstanceId: instanceId,
            runId: turn.runId,
            nodeId: turn.rootNodeId,
            providerThreadId: turn.providerThread.id,
            providerTurnId,
            userMessageId: turn.message.messageId,
          },
          snapshot: { message: owned, turnItem: item.turnItem },
          frozen: true,
        },
      ],
    });
    write(reopened.restore());
    write(reopened.project(answer));
    write(
      reopened.project({
        ...answer,
        payload: {
          ...answer.payload,
          display_text: "Foreign replacement",
          reply_to_message_id: "foreign-user",
        },
        meta: { seq: 3, ts_ms: 3_000 },
      }),
    );
    assert.strictEqual(persisted.size, 1);
    assert.strictEqual(persisted.get(owned.id)?.runId, turn.runId);
    assert.strictEqual(persisted.get(owned.id)?.nodeId, turn.rootNodeId);
    assert.strictEqual(persisted.get(owned.id)?.text, "Synthetic answer");
  }),
);

it.effect(
  "a preexisting observer suppresses receipt-linked output before its snapshot and rejects later foreign ID reuse",
  () =>
    Effect.gen(function* () {
      const observer = makeProjection();
      const managed = makeProjection();
      const turn = yield* makeTurn;
      const providerTurnId = managed.begin(turn);
      managed.admit(receipt);
      const context = {
        threadId,
        providerInstanceId: instanceId,
        runId: turn.runId,
        nodeId: turn.rootNodeId,
        providerThreadId: turn.providerThread.id,
        providerTurnId,
        userMessageId: turn.message.messageId,
      };
      observer.retainOwnedUserReceipts([{ ...receipt, context }]);
      assert.strictEqual(observer.unknownAssistantIdentity(answer), undefined);
      assert.deepStrictEqual(observer.project(answer), []);
      const original = managed.project(answer);
      assert.ok(
        original.some(
          (event) => event.type === "message.updated" && event.message.runId === turn.runId,
        ),
      );
      const foreign = {
        ...answer,
        payload: {
          ...answer.payload,
          reply_to_message_id: "foreign-receipt",
          display_text: "Foreign replacement",
        },
        meta: { seq: 9, ts_ms: 9000 },
      };
      assert.deepStrictEqual(observer.project(foreign), []);
      const unrelated = {
        ...foreign,
        payload: { ...foreign.payload, message_id: "foreign-assistant" },
      };
      assert.strictEqual(
        observer.project(unrelated).filter((event) => event.type === "message.updated").length,
        1,
      );
    }),
);

it.effect(
  "targeted association refresh blocks an empty-reply assistant reuse without publishing stale snapshots",
  () =>
    Effect.gen(function* () {
      const observer = makeProjection();
      const managed = makeProjection();
      const turn = yield* makeTurn;
      const providerTurnId = managed.begin(turn);
      managed.admit(receipt);
      const events = managed.project(answer);
      const message = events.find((event) => event.type === "message.updated");
      const item = events.find((event) => event.type === "turn_item.updated");
      assert.ok(message && item);
      const noReply = { ...answer, payload: { ...answer.payload, reply_to_message_id: "" } };
      assert.strictEqual(observer.unknownAssistantIdentity(noReply), answer.payload.message_id);
      observer.project(noReply);
      const priorText = observer.snapshot()[0]?.text;
      if (item.turnItem.type !== "assistant_message") throw new Error("expected assistant_message");
      const ownership: MuseAgentHistoryOwnership = {
        receipts: [],
        messages: [
          {
            nativeMessageId: answer.payload.message_id,
            deliveryKey: turn.attemptId,
            context: {
              threadId,
              providerInstanceId: instanceId,
              runId: turn.runId,
              nodeId: turn.rootNodeId,
              providerThreadId: turn.providerThread.id,
              providerTurnId,
              userMessageId: turn.message.messageId,
            },
            snapshot: {
              message: { ...message.message, text: "Older persisted body" },
              turnItem: { ...item.turnItem, text: "Older persisted body" },
            },
            frozen: true,
          },
        ],
      };
      observer.retainOwnedAssistantAssociations(ownership);
      assert.strictEqual(observer.snapshot()[0]?.text, priorText);
      assert.strictEqual(observer.unknownAssistantIdentity(noReply), undefined);
      assert.deepStrictEqual(
        observer.project({
          ...noReply,
          payload: { ...noReply.payload, display_text: "Foreign replacement" },
          meta: { seq: 10, ts_ms: 10000 },
        }),
        [],
      );
      assert.deepStrictEqual(
        observer.project({
          event: "delta.presentation",
          payload: { session_id: "primary", host_message_id: answer.payload.message_id },
          meta: { seq: 11, ts_ms: 11000 },
        }),
        [],
      );
      managed.retainOwnedAssistantAssociations(ownership);
      assert.strictEqual(managed.snapshot()[0]?.text, "Synthetic answer");
    }),
);
