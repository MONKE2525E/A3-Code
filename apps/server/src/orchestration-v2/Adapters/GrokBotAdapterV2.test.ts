import { assert, it } from "@effect/vitest";
import { ProviderTurnId, OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  GrokBotNativeRuntimeService,
  type RuntimeFrame,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import { grokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";
import {
  createGrokBotAdapterV2,
  GrokBotCapabilitiesV2,
  makeGrokBotTranscriptProjection,
} from "./GrokBotAdapterV2.ts";
import { GrokBotManagedBinding, GrokBotBindingError } from "./GrokBotManagedBinding.ts";
import {
  makeBindings,
  makeNative,
  makeTurn,
  nativeSession,
  options,
  policy,
  providerSessionId,
  rows,
  selection,
  threadId,
} from "./GrokBotProvider.testkit.ts";

const sessionInput = {
  threadId,
  providerSessionId,
  modelSelection: selection,
  runtimePolicy: policy,
};
const encodePersistedTurnItem = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const decodePersistedTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);

const transcript = (
  entries: readonly { seq: string; updatedSeq: string; value: unknown }[],
  replay = false,
): Extract<RuntimeFrame, { readonly _tag: "Rows" }> => ({
  _tag: "Rows",
  generation: 0,
  entries,
  deletes: [],
  replay,
});
const echo = (nonce: string, version = "1") => ({
  seq: "1",
  updatedSeq: version,
  value: {
    id: "native-echo",
    kind: "message",
    role: "user",
    content: "delegated task",
    clientNonce: nonce,
    requestId: "native-request",
  },
});
const answer = (version = "2", text = "native answer") => ({
  seq: "2",
  updatedSeq: version,
  value: {
    id: "native-answer",
    kind: "send-message",
    message: { type: "text", content: text },
    requestId: "native-request",
  },
});

it.effect("projects native bot messages and clickable peer metadata into durable turn items", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    const events = yield* projection.project(
      transcript(
        [
          {
            seq: "1",
            updatedSeq: "1",
            value: {
              id: "peer-incoming",
              kind: "message",
              role: "user",
              content: "Peer request",
              fromAgent: { id: "peer-a", name: "Research Bot" },
              toAgent: { id: nativeSession.botId, name: "This Bot" },
            },
          },
          {
            seq: "2",
            updatedSeq: "2",
            value: {
              id: "peer-outgoing",
              kind: "message",
              role: "assistant",
              content: "Peer reply",
              fromAgent: { id: nativeSession.botId, name: "This Bot" },
              toAgent: { id: "peer-a", name: "Research Bot", kind: "bot" },
            },
          },
          {
            seq: "3",
            updatedSeq: "3",
            value: {
              id: "native-assistant",
              kind: "message",
              role: "assistant",
              content: "Ordinary reply",
            },
          },
        ],
        true,
      ),
    );
    assert.deepStrictEqual(
      projection.messages().map((message) => ({
        role: message.role,
        text: message.text,
        createdBy: message.createdBy,
        peer: message.grokBotPeer,
      })),
      [
        {
          role: "assistant",
          text: "Peer request",
          createdBy: "agent",
          peer: { botId: "peer-a", name: "Research Bot", direction: "from" },
        },
        {
          role: "assistant",
          text: "Peer reply",
          createdBy: "agent",
          peer: { botId: "peer-a", name: "Research Bot", direction: "to" },
        },
        { role: "assistant", text: "Ordinary reply", createdBy: "agent", peer: undefined },
      ],
    );
    const items = events
      .filter((event) => event.type === "turn_item.updated")
      .map((event) => event.turnItem);
    assert.isTrue(items[0]?.type === "assistant_message");
    assert.isTrue(items[1]?.type === "assistant_message");
    if (items[0]?.type === "assistant_message" && items[1]?.type === "assistant_message") {
      assert.deepStrictEqual(items[0].grokBotPeer, projection.messages()[0]?.grokBotPeer);
      assert.deepStrictEqual(items[1].grokBotPeer, projection.messages()[1]?.grokBotPeer);
      // ProjectionStore persists through the JSON union rather than the runtime union.
      const persisted = yield* encodePersistedTurnItem(items[1]);
      const restored = yield* decodePersistedTurnItem(persisted);
      assert.isTrue(restored.type === "assistant_message");
      if (restored.type === "assistant_message")
        assert.deepStrictEqual(restored.grokBotPeer, items[1].grokBotPeer);
    }
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "replaying existing history adds peer metadata to the same persisted message and turn item",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const row = {
        seq: "7",
        updatedSeq: "7",
        value: {
          id: "existing-peer",
          kind: "message",
          role: "user",
          content: "Existing peer request",
        },
      };
      const oldProjection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      const oldEvents = yield* oldProjection.project(transcript([row], true));
      const reattached = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      const refreshedEvents = yield* reattached.project(
        transcript(
          [
            {
              ...row,
              value: { ...row.value, fromAgent: { id: "peer-bot", name: "Research Bot" } },
            },
          ],
          true,
        ),
      );
      assert.equal(reattached.messages()[0]?.id, oldProjection.messages()[0]?.id);
      assert.equal(reattached.messages()[0]?.role, "assistant");
      assert.equal(reattached.messages()[0]?.grokBotPeer?.botId, "peer-bot");
      assert.equal(
        refreshedEvents.find((event) => event.type === "turn_item.updated")?.turnItem.id,
        oldEvents.find((event) => event.type === "turn_item.updated")?.turnItem.id,
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "removes managed instructions from external T3 echoes without altering ordinary user content",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const projection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      const content = "My actual message\n\n[From T3 Code: Use skill t3-code-managed-turn-v1.]";
      const legacyContent =
        "Historical message\n\n[From T3 Code: Use skill t3-code-managed-turn-v1. To discover Grok Bots, call grok_bots_list on the injected t3-code-managed MCP connection. Native peer/session lists do not contain the persistent bot roster. To coordinate, call grok_bot_send with the returned botId, message, and a stable clientRequestId; read replies with t3_thread_read or t3_thread_wait. T3 records the sending agent's identity automatically. If the tool is unavailable, report that T3 connection's missing tool instead of claiming there are no bots.]";
      yield* projection.project(
        transcript(
          [
            {
              seq: "1",
              updatedSeq: "1",
              value: { ...echo("t3-" + "a".repeat(64)).value, id: "managed-external", content },
            },
            {
              seq: "2",
              updatedSeq: "2",
              value: { ...echo("ordinary-native-nonce").value, id: "ordinary-external", content },
            },
            {
              seq: "3",
              updatedSeq: "3",
              value: {
                ...echo("t3-" + "b".repeat(64)).value,
                id: "legacy-external",
                content: legacyContent,
              },
            },
          ],
          true,
        ),
      );
      assert.deepEqual(
        projection.messages().map((message) => message.text),
        ["My actual message", content, "Historical message"],
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("repairs a previously imported owned echo once without introducing another bubble", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const turn = { ...(yield* makeTurn), messageId: "t3-" + "c".repeat(64) };
    const content = "actual user text\n\n[From T3 Code: Use skill t3-code-managed-turn-v1.]";
    const frame = transcript(
      [{ ...echo(turn.messageId), value: { ...echo(turn.messageId).value, content } }],
      true,
    );
    const importer = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    yield* importer.project(frame);
    const old = { ...importer.messages()[0]!, text: content };
    const projection = makeGrokBotTranscriptProjection({
      native: nativeSession,
      idAllocator,
      existingMessage: (id) => Effect.succeed(id === old.id ? old : undefined),
    });
    projection.registerManagedTurn(grokBotTurnIdentity(turn));
    const events = yield* projection.project(frame);
    const updates = events.filter((event) => event.type === "message.updated");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.message.id, old.id);
    assert.equal(updates[0]?.message.text, "actual user text");
    assert.deepEqual(yield* projection.project(frame), []);
    const fresh = makeGrokBotTranscriptProjection({
      native: nativeSession,
      idAllocator,
      existingMessage: () => Effect.succeed(undefined),
    });
    fresh.registerManagedTurn(grokBotTurnIdentity(turn));
    assert.deepEqual(yield* fresh.project(frame), []);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "suppresses every version of an owned echo while preserving external prompts and their replies",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const turn = yield* makeTurn;
      const projection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      projection.registerManagedTurn(grokBotTurnIdentity(turn));
      const events = yield* projection.project(
        transcript(
          [
            answer(),
            echo(turn.messageId),
            {
              seq: "3",
              updatedSeq: "3",
              value: {
                ...echo("external-nonce").value,
                id: "external-user",
                requestId: "external-request",
              },
            },
            {
              seq: "4",
              updatedSeq: "4",
              value: { ...answer().value, id: "external-answer", requestId: "external-request" },
            },
          ],
          true,
        ),
      );
      assert.equal(events.filter((event) => event.type === "message.updated").length, 3);
      const items = events.filter((event) => event.type === "turn_item.updated");
      assert.deepEqual(
        items.map((event) => event.turnItem.type),
        ["assistant_message", "user_message", "assistant_message"],
      );
      assert.equal(items[0]?.turnItem.runId, turn.input.runId);
      assert.equal(items[0]?.turnItem.providerTurnId, turn.providerTurnId);
      assert.isNull(items[1]?.turnItem.runId);
      assert.isNull(items[2]?.turnItem.runId);
      const [ownedReply, externalPrompt, externalReply] = projection.messages();
      assert.equal(ownedReply?.runId, turn.input.runId);
      assert.equal(ownedReply?.nodeId, turn.input.rootNodeId);
      assert.equal(externalPrompt?.role, "user");
      assert.isNull(externalPrompt?.runId);
      assert.isNull(externalReply?.runId);
      assert.deepEqual(
        yield* projection.project(transcript([echo(turn.messageId, "5")], true)),
        [],
      );
      const update = yield* projection.project(transcript([answer("6", "updated answer")]));
      const updatedItem = update.find((event) => event.type === "turn_item.updated");
      assert.equal(updatedItem?.turnItem.id, items[0]?.turnItem.id);
      assert.isTrue(updatedItem?.turnItem.type === "assistant_message");
      if (updatedItem?.turnItem.type === "assistant_message") {
        assert.equal(updatedItem.turnItem.messageId, ownedReply?.id);
        assert.equal(updatedItem.turnItem.text, "updated answer");
      }
      assert.equal(projection.messages()[0]?.id, ownedReply?.id);
      assert.equal(projection.messages()[0]?.text, "updated answer");
      assert.equal(projection.messages()[0]?.runId, turn.input.runId);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("associates an earlier reply only after an owned echo proves its native request", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const turn = yield* makeTurn;
    const projection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    projection.registerManagedTurn(grokBotTurnIdentity(turn));
    const first = yield* projection.project(transcript([answer()], true));
    const beforeItem = first.find((event) => event.type === "turn_item.updated");
    const before = projection.messages()[0];
    assert.isNull(before?.runId);
    const associated = yield* projection.project(transcript([echo(turn.messageId)], true));
    const associatedItem = associated.find((event) => event.type === "turn_item.updated");
    assert.equal(associatedItem?.turnItem.id, beforeItem?.turnItem.id);
    assert.equal(associatedItem?.turnItem.runId, turn.input.runId);
    assert.equal(associatedItem?.turnItem.providerTurnId, turn.providerTurnId);
    assert.equal(projection.messages()[0]?.id, before?.id);
    assert.equal(projection.messages()[0]?.runId, turn.input.runId);
    assert.equal(projection.messages()[0]?.nodeId, turn.input.rootNodeId);
    assert.deepEqual(yield* projection.project(transcript([echo(turn.messageId, "7")], true)), []);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("preserves settled reply ownership on observer restart without reopening execution", () =>
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const turn = yield* makeTurn;
    const identity = grokBotTurnIdentity(turn);
    const settlementReplayed = yield* Deferred.make<void>();
    const replay = transcript([echo(turn.messageId), answer()], true);
    const original = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator: ids });
    original.registerManagedTurn(identity);
    const before = yield* original.project(replay);
    const adapter = yield* createGrokBotAdapterV2(options).pipe(
      Effect.provideService(
        GrokBotNativeRuntimeService,
        makeNative({
          startTurn: () => Effect.die("settled history must never resend"),
          watch: () =>
            Stream.fromEffect(Deferred.await(settlementReplayed)).pipe(
              Stream.flatMap(() => Stream.succeed(replay)),
              Stream.concat(Stream.never),
            ),
          openSettlementWatch: () =>
            Effect.succeed({
              events: Stream.succeed({
                _tag: "Settlement" as const,
                clientNonce: turn.messageId,
                outcome: "success" as const,
                settledAtMs: 2000,
              }).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(settlementReplayed, undefined)).pipe(
                    Stream.drain,
                  ),
                ),
                Stream.concat(Stream.never),
              ),
            }),
        }),
      ),
      Effect.provideService(
        GrokBotManagedBinding,
        makeBindings(turn, {
          restoreManagedMessageIds: () => Effect.succeed([turn.messageId]),
          restoreTranscriptTurns: () => Effect.succeed([identity]),
          restoreTurns: () => Effect.succeed([]),
        }),
      ),
    );
    const session = yield* adapter.openSession(sessionInput);
    const after = yield* session.events.pipe(Stream.take(2), Stream.runCollect);
    assert.deepEqual(
      after.map((event) => event.type),
      ["message.updated", "turn_item.updated"],
    );
    const beforeMessage = before[0];
    const beforeItem = before[1];
    const afterMessage = after[0];
    const afterItem = after[1];
    if (
      beforeMessage?.type !== "message.updated" ||
      beforeItem?.type !== "turn_item.updated" ||
      afterMessage?.type !== "message.updated" ||
      afterItem?.type !== "turn_item.updated"
    )
      return yield* Effect.die("missing replayed native answer");
    assert.equal(afterMessage.message.id, beforeMessage.message.id);
    assert.equal(afterMessage.message.runId, identity.runId);
    assert.equal(afterMessage.message.nodeId, identity.rootNodeId);
    assert.equal(afterItem.turnItem.id, beforeItem.turnItem.id);
    assert.equal(afterItem.turnItem.providerTurnId, identity.providerTurnId);
    assert.equal(afterItem.turnItem.runId, identity.runId);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect.each(["send", "restart"] as const)(
  "registers managed echo ownership before native %s events",
  (scenario) =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const inbox = yield* Queue.unbounded<RuntimeFrame>();
      const adapter = yield* createGrokBotAdapterV2(options).pipe(
        Effect.provideService(
          GrokBotNativeRuntimeService,
          makeNative({
            watch: () =>
              scenario === "restart"
                ? Stream.succeed(
                    transcript(
                      [echo("settled-native-nonce"), echo(turn.messageId), answer()],
                      true,
                    ),
                  ).pipe(Stream.concat(Stream.never))
                : Stream.fromQueue(inbox),
            startTurn: () =>
              scenario === "restart"
                ? Effect.die("restart must never resend")
                : Queue.offer(inbox, transcript([echo(turn.messageId), answer()])).pipe(
                    Effect.as({ delivery: "accepted" as const }),
                  ),
          }),
        ),
        Effect.provideService(
          GrokBotManagedBinding,
          makeBindings(turn, {
            restoreManagedMessageIds: () =>
              Effect.succeed(
                scenario === "restart" ? ["settled-native-nonce", turn.messageId] : [],
              ),
            restoreTurns: () =>
              Effect.succeed(scenario === "restart" ? [grokBotTurnIdentity(turn)] : []),
          }),
        ),
      );
      const session = yield* adapter.openSession(sessionInput);
      const thread = yield* session.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: policy,
      });
      if (scenario === "send") yield* session.startTurn({ ...turn.input, providerThread: thread });
      const events = yield* session.events.pipe(
        Stream.filter((event) => event.type === "message.updated"),
        Stream.take(1),
        Stream.runCollect,
      );
      const event = events[0];
      if (event?.type !== "message.updated") return yield* Effect.die("expected native reply");
      assert.equal(event.message.role, "assistant");
      assert.equal(event.message.text, "native answer");
      assert.equal(event.message.runId, turn.input.runId);
      assert.equal(event.message.nodeId, turn.input.rootNodeId);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect(
  "keeps native row identity across replay and streaming updates without settling a run",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const projection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      const first = yield* projection.project(rows("1", "a"));
      const duplicate = yield* projection.project(rows("1", "a"));
      const update = yield* projection.project(rows("2", "answer", false));
      assert.equal(first.length, 2);
      assert.equal(duplicate.length, 0);
      const previous = first[0];
      const next = update[0];
      assert.isTrue(previous?.type === "message.updated" && next?.type === "message.updated");
      if (previous?.type !== "message.updated" || next?.type !== "message.updated")
        return yield* Effect.die("missing message event");
      assert.equal(previous.message.id, next.message.id);
      assert.equal(next.message.text, "answer");
      assert.isFalse(next.message.streaming);
      assert.isNull(next.message.runId);
      assert.isNull(next.message.nodeId);
      const previousItem = first[1];
      const nextItem = update[1];
      if (
        previousItem?.type !== "turn_item.updated" ||
        nextItem?.type !== "turn_item.updated" ||
        nextItem.turnItem.type !== "assistant_message"
      )
        return yield* Effect.die("missing visible native text item");
      assert.equal(previousItem.turnItem.id, nextItem.turnItem.id);
      assert.equal(nextItem.turnItem.messageId, next.message.id);
      assert.equal(nextItem.turnItem.text, "answer");
      assert.isFalse(nextItem.turnItem.streaming);
      assert.equal(nextItem.turnItem.status, "completed");
      assert.isNull(nextItem.turnItem.runId);
      assert.deepEqual(
        yield* projection.project({
          _tag: "Live",
          state: { agentId: nativeSession.botId, sessionId: "", isRunning: false },
          observedAtMs: 2000,
          snapshot: false,
        }),
        [],
      );
      assert.deepEqual(
        yield* projection.project({ _tag: "TurnFailed", turnId: "unowned-native-turn" }),
        [],
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("requests a verified resync for midstream clear, deletes, and unavailable bodies", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    for (const frame of [
      { _tag: "Cleared" as const, generation: 1 },
      {
        _tag: "Rows" as const,
        generation: 0,
        entries: [],
        deletes: [{ seq: "1", updatedSeq: "2" }],
        replay: false,
      },
      {
        _tag: "Rows" as const,
        generation: 0,
        entries: [{ seq: "1", updatedSeq: "2", bodyOmitted: true }],
        deletes: [],
        replay: false,
      },
    ]) {
      const projection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      if (frame._tag === "Cleared") yield* projection.project(rows("1", "before clear"));
      assert.equal(
        (yield* projection.project(frame).pipe(Effect.flip))._tag,
        "GrokBotBindingError",
      );
    }
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "uses the replay generation for durable message identity across bootstrap reconnects",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const original = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      const reconnect = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      const retained = makeGrokBotTranscriptProjection({
        native: { ...nativeSession, generation: 7 },
        idAllocator,
      });
      for (const projection of [original, reconnect, retained]) {
        yield* projection.project({ _tag: "Cleared", generation: 7 });
        yield* projection.project({ ...transcript([answer("1", "answer")]), generation: 7 });
      }
      assert.equal(original.messages()[0]?.id, reconnect.messages()[0]?.id);
      assert.equal(original.messages()[0]?.id, retained.messages()[0]?.id);
      assert.deepEqual(
        yield* original.project({ ...transcript([answer("1", "answer")]), generation: 7 }),
        [],
      );
      const previous = retained.messages()[0];
      assert.equal(
        (yield* retained.project({ _tag: "Cleared", generation: 8 }).pipe(Effect.flip))._tag,
        "GrokBotBindingError",
      );
      assert.deepEqual(retained.messages(), [previous]);
      const conflicting = makeGrokBotTranscriptProjection({
        native: { ...nativeSession, generation: 7 },
        idAllocator,
      });
      assert.equal(
        (yield* conflicting.project({ _tag: "Cleared", generation: 8 }).pipe(Effect.flip))._tag,
        "GrokBotBindingError",
      );
      // Before any row nothing durable is orphaned: CursorTooOld adopts and asks for a re-attach.
      assert.deepEqual(yield* conflicting.project({ _tag: "CursorTooOld", generation: 7 }), []);
      assert.equal(conflicting.takeRestart(), 7);
      assert.equal(conflicting.takeRestart(), undefined);
      // After rows, a different generation would orphan imported ids and stays a hard failure.
      assert.equal(
        (yield* retained.project({ _tag: "CursorTooOld", generation: 9 }).pipe(Effect.flip))._tag,
        "GrokBotBindingError",
      );
      // The same generation re-attaches; replayed rows dedupe by version.
      assert.deepEqual(yield* retained.project({ _tag: "CursorTooOld", generation: 7 }), []);
      assert.equal(retained.takeRestart(), 7);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "keeps managed completion observable when the initial cursor receives a clear and replay",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const replayed = yield* Deferred.make<void>();
      let sends = 0;
      const adapter = yield* createGrokBotAdapterV2(options).pipe(
        Effect.provideService(
          GrokBotNativeRuntimeService,
          makeNative({
            watch: () =>
              Stream.fromIterable([
                { _tag: "Connected", streamId: "native-stream" } as const,
                { _tag: "Cleared", generation: 1 } as const,
                { ...transcript([echo(turn.messageId), answer()], true), generation: 1 },
              ]).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(replayed, undefined)).pipe(Stream.drain),
                ),
                Stream.concat(Stream.never),
              ),
            startTurn: () =>
              Effect.sync(() => {
                sends++;
                return { delivery: "accepted" as const };
              }),
          }),
        ),
        Effect.provideService(
          GrokBotManagedBinding,
          makeBindings(turn, {
            restoreTurns: () => Effect.succeed([grokBotTurnIdentity(turn)]),
            openCompletionWatch: () =>
              Effect.succeed(
                Stream.fromEffect(Deferred.await(replayed)).pipe(
                  Stream.map(() => ({
                    identity: grokBotTurnIdentity(turn),
                    source: "agent_declaration" as const,
                    finalText: "managed final answer",
                    declaredAtMs: 2000,
                  })),
                  Stream.concat(Stream.never),
                ),
              ),
          }),
        ),
      );
      const session = yield* adapter.openSession(sessionInput);
      const events = yield* session.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const replies = events.filter((event) => event.type === "message.updated");
      assert.deepEqual(
        replies.map((event) => event.message.text),
        ["native answer", "managed final answer"],
      );
      assert.isTrue(replies.every((event) => event.message.runId === turn.input.runId));
      assert.equal(events.at(-1)?.type, "turn.terminal");
      assert.deepEqual(
        events
          .filter((event) => event.type === "turn_item.updated")
          .map((event) =>
            event.turnItem.type === "assistant_message" ? event.turnItem.text : undefined,
          ),
        ["native answer", "managed final answer"],
      );
      assert.equal(sends, 0);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("observes native history without Connect and still refuses a native send", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const watching = yield* Deferred.make<void>();
    const adapter = yield* createGrokBotAdapterV2(options).pipe(
      Effect.provideService(
        GrokBotNativeRuntimeService,
        makeNative({
          startTurn: () => Effect.die("must not send"),
          watch: () =>
            Stream.fromEffect(Deferred.succeed(watching, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
        }),
      ),
      Effect.provideService(
        GrokBotManagedBinding,
        makeBindings(turn, {
          availability: Effect.succeed({ ready: false, reason: "settlement unverified" }),
        }),
      ),
    );
    const session = yield* adapter.openSession(sessionInput);
    assert.isTrue(yield* session.hasPendingBackgroundWork!);
    yield* Deferred.await(watching);
    const thread = yield* session.ensureThread({
      threadId,
      modelSelection: selection,
      runtimePolicy: policy,
    });
    assert.equal(
      (yield* session.startTurn({ ...turn.input, providerThread: thread }).pipe(Effect.flip))._tag,
      "ProviderAdapterTurnStartError",
    );
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("rejects account changes, native model options, and unsupported sandbox policy", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const bindings = makeBindings(turn, { resolve: () => Effect.die("must not resolve") });
    const adapter = yield* createGrokBotAdapterV2(options).pipe(
      Effect.provideService(
        GrokBotNativeRuntimeService,
        makeNative({ accountBinding: Effect.succeed("b".repeat(64)) }),
      ),
      Effect.provideService(GrokBotManagedBinding, bindings),
    );
    for (const request of [
      sessionInput,
      {
        ...sessionInput,
        modelSelection: { ...selection, options: [{ id: "reasoningEffort", value: "high" }] },
      },
      { ...sessionInput, runtimePolicy: { ...policy, runtimeMode: "approval-required" as const } },
    ])
      assert.equal(
        (yield* adapter.openSession(request).pipe(Effect.flip))._tag,
        "ProviderAdapterOpenSessionError",
      );
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("resumes observed history without sending and closes only local authority", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    let released = 0;
    const native = makeNative({
      startTurn: () => Effect.die("history must not be resent"),
      interrupt: () => Effect.die("closing the local session must not stop cloud execution"),
    });
    const bindings = makeBindings(turn, {
      release: () =>
        Effect.sync(() => {
          released++;
        }),
    });
    yield* Effect.gen(function* () {
      const adapter = yield* createGrokBotAdapterV2(options);
      const session = yield* adapter.openSession(sessionInput);
      const thread = yield* session.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: policy,
      });
      const resumed = yield* session.resumeThread({ providerThread: thread });
      assert.equal(resumed.id, thread.id);
      assert.isFalse(
        yield* session.injectHistory!({
          providerThread: thread,
          messages: [],
          context: "old prompt",
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(GrokBotNativeRuntimeService, native),
      Effect.provideService(GrokBotManagedBinding, bindings),
    );
    assert.equal(released, 1);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("requires current owned turn verification before a native session interrupt", () =>
  Effect.gen(function* () {
    const turn = yield* makeTurn;
    const adapter = yield* createGrokBotAdapterV2(options).pipe(
      Effect.provideService(
        GrokBotNativeRuntimeService,
        makeNative({ interrupt: () => Effect.die("ownership failure must not interrupt") }),
      ),
      Effect.provideService(
        GrokBotManagedBinding,
        makeBindings(turn, {
          verifyInterrupt: () =>
            Effect.fail(
              new GrokBotBindingError({ reason: "another native turn replaced this run" }),
            ),
        }),
      ),
    );
    const session = yield* adapter.openSession(sessionInput);
    const thread = yield* session.ensureThread({
      threadId,
      modelSelection: selection,
      runtimePolicy: policy,
    });
    assert.equal(
      (yield* session
        .interruptTurn({ providerThread: thread, providerTurnId: ProviderTurnId.make("old-turn") })
        .pipe(Effect.flip))._tag,
      "ProviderAdapterInterruptError",
    );
    assert.equal(
      (yield* session
        .steerTurn({
          providerThread: thread,
          providerTurnId: ProviderTurnId.make("old-turn"),
          threadId,
          runId: turn.input.runId,
          message: turn.input.message,
        })
        .pipe(Effect.flip))._tag,
      "ProviderAdapterSteerRunUnsupportedError",
    );
    assert.equal(GrokBotCapabilitiesV2.turns.terminalStatusQuality, "weak");
    assert.isTrue(GrokBotCapabilitiesV2.context.acceptsSyntheticUserContext);
    assert.isTrue(GrokBotCapabilitiesV2.turns.emitsTurnCompleted);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect(
  "imports native Teach handoff and its replies outside a managed turn without losing the workflow scope",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const projection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      const references = [
        {
          id: "learn-from-demonstration",
          label: "Learn from demonstration",
          teachQueueScope: "demo-scope",
        },
      ];
      const entries = [
        {
          seq: "20",
          updatedSeq: "20",
          value: {
            id: "native-teach-handoff",
            kind: "message",
            role: "user",
            content: "The recording is finished. Learn the task from it.",
            richText: JSON.stringify({
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "workflowReference", attrs: references[0] }],
                },
              ],
            }),
            clientNonce: "teach-recording:demo-scope:recording.json",
            requestId: "native-teach-request",
          },
        },
        {
          seq: "21",
          updatedSeq: "21",
          value: {
            id: "native-teach-answer",
            kind: "send-message",
            message: { type: "text", content: "Got your demo recording. Watching it now." },
            requestId: "native-teach-request",
          },
        },
      ];
      const events = yield* projection.project(transcript(entries));
      const messages = events.filter((event) => event.type === "message.updated");
      assert.strictEqual(messages.length, 2);
      assert.strictEqual(messages[0]?.message.role, "user");
      assert.strictEqual(messages[0]?.message.runId, null);
      assert.deepStrictEqual(messages[0]?.message.grokBotWorkflowReferences, references);
      assert.strictEqual(messages[1]?.message.text, "Got your demo recording. Watching it now.");
      const item = events.find(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "user_message",
      );
      assert.ok(item?.type === "turn_item.updated");
      assert.ok(item.turnItem.type === "user_message");
      const encoded = yield* encodePersistedTurnItem(item.turnItem);
      const persisted = yield* decodePersistedTurnItem(encoded);
      assert.ok(persisted.type === "user_message");
      assert.deepStrictEqual(persisted.grokBotWorkflowReferences, references);
      assert.deepStrictEqual(yield* projection.project(transcript(entries, true)), []);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "reattaches an exact accepted native delivery while its cloud endpoint is unavailable",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const identity = grokBotTurnIdentity(turn);
      const adapter = yield* createGrokBotAdapterV2(options).pipe(
        Effect.provideService(
          GrokBotNativeRuntimeService,
          makeNative({
            sendStatus: (request) => {
              assert.equal(request.messageId, identity.messageId);
              return Effect.succeed({ status: "accepted" as const });
            },
            startTurn: () => Effect.die("accepted native delivery must not resend"),
          }),
        ),
        Effect.provideService(
          GrokBotManagedBinding,
          makeBindings(turn, {
            availability: Effect.succeed({ ready: false, reason: "relay starting" }),
            prepareTurn: () =>
              Effect.die("accepted native delivery must not prepare new credentials"),
            restoreTurns: () => Effect.succeed([identity]),
          }),
        ),
      );
      const session = yield* adapter.openSession(sessionInput);
      const thread = yield* session.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: policy,
        existingProviderThread: turn.input.providerThread,
      });
      yield* session.startTurn({ ...turn.input, providerThread: thread });
      const mismatch = yield* Effect.result(
        session.startTurn({
          ...turn.input,
          providerThread: thread,
          providerTurnOrdinal: turn.input.providerTurnOrdinal + 1,
        }),
      );
      assert.equal(mismatch._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect(
  "replays a durable completion after resumed ownership even when its first watch delivery was consumed",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const identity = grokBotTurnIdentity(turn);
      const completion = {
        identity,
        source: "agent_declaration" as const,
        finalText: "finished",
        declaredAtMs: 2000,
      };
      const adapter = yield* createGrokBotAdapterV2(options).pipe(
        Effect.provideService(
          GrokBotNativeRuntimeService,
          makeNative({ sendStatus: () => Effect.succeed({ status: "accepted" }) }),
        ),
        Effect.provideService(
          GrokBotManagedBinding,
          makeBindings(turn, {
            restoreTurns: () => Effect.succeed([identity]),
            lookupCompletion: () => Effect.succeed(completion),
            openCompletionWatch: () =>
              Effect.succeed(Stream.succeed(completion).pipe(Stream.concat(Stream.never))),
            prepareTurn: () => Effect.die("resume must not prepare"),
          }),
        ),
      );
      const session = yield* adapter.openSession(sessionInput);
      // Represents a watcher delivering before the active run listener has attached.
      yield* session.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.take(1),
        Stream.runDrain,
      );
      const thread = yield* session.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: policy,
        existingProviderThread: turn.input.providerThread,
      });
      yield* session.startTurn({ ...turn.input, providerThread: thread });
      const events = yield* session.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.take(2),
        Stream.runCollect,
      );
      assert.deepEqual(
        events.map((event) =>
          event.type === "provider_turn.updated" ? event.providerTurn.status : null,
        ),
        ["pending", "completed"],
      );
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect(
  "imports native image groups and attachment-only replies without duplicating replay",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const imported: string[] = [];
      const projection = makeGrokBotTranscriptProjection({
        native: nativeSession,
        idAllocator,
        importAttachments: (entryId, attachments) =>
          Effect.sync(() => {
            imported.push(entryId);
            return attachments.map((attachment, index) => ({
              type: attachment.image ? ("image" as const) : ("file" as const),
              id: `fixture-attachment-${index}`,
              name: attachment.name ?? `image-${index}.png`,
              mimeType: attachment.image ? "image/png" : "text/plain",
              sizeBytes: 700,
            }));
          }),
      });
      const frame = transcript([
        {
          seq: "10",
          updatedSeq: "10",
          value: {
            id: "four-images",
            kind: "send-message",
            message: {
              type: "text",
              content: "Four pieces",
              images: Array.from({ length: 4 }, (_, index) => ({
                url: `file:///home/box/agent-data/agents/bot-1/attachments/piece-${index}.png`,
              })),
            },
          },
        },
        {
          seq: "11",
          updatedSeq: "11",
          value: {
            id: "text-file",
            kind: "send-message",
            message: {
              type: "attachment",
              url: "file:///home/box/agent-data/agents/bot-1/attachments/file.txt",
              file_name: "poteto.txt",
            },
          },
        },
      ]);
      const events = yield* projection.project(frame);
      const messages = events
        .filter((event) => event.type === "message.updated")
        .map((event) => event.message);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.attachments.length, 4);
      assert.equal(messages[1]?.text, "");
      assert.equal(messages[1]?.attachments[0]?.name, "poteto.txt");
      assert.equal(messages[1]?.role, "assistant");
      assert.equal(imported.length, 5);
      assert.deepEqual(yield* projection.project(frame), []);
      assert.equal(imported.length, 5);
      const turnItems = events.filter((event) => event.type === "turn_item.updated");
      assert.equal(turnItems.length, 2);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "refreshes exact durable ownership when an echo arrives on an already open transcript",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const turn = yield* makeTurn;
      let known = false;
      const lookedUp: string[] = [];
      const projection = makeGrokBotTranscriptProjection({
        native: nativeSession,
        idAllocator,
        lookupTranscriptTurn: (messageId) =>
          Effect.sync(() => {
            lookedUp.push(messageId);
            return known && messageId === turn.messageId ? grokBotTurnIdentity(turn) : undefined;
          }),
      });
      yield* projection.project(
        transcript([
          {
            seq: "1",
            updatedSeq: "1",
            value: {
              id: "external-message",
              kind: "message",
              role: "user",
              content: "same text",
              clientNonce: "external-nonce",
            },
          },
        ]),
      );
      known = true;
      const events = yield* projection.project(
        transcript([
          {
            ...echo(turn.messageId),
            seq: "2",
            updatedSeq: "2",
            value: { ...echo(turn.messageId).value, content: "same text" },
          },
          { ...answer(), seq: "3", updatedSeq: "3" },
        ]),
      );
      const messages = events
        .filter((event) => event.type === "message.updated")
        .map((event) => event.message);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.role, "assistant");
      assert.equal(messages[0]?.runId, grokBotTurnIdentity(turn).runId);
      assert.equal(projection.messages().filter((message) => message.role === "user").length, 1);
      assert.deepEqual(lookedUp, ["external-nonce", turn.messageId]);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("keeps available attachments and retries a failed download on native replay", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    let recovered = false;
    const projection = makeGrokBotTranscriptProjection({
      native: nativeSession,
      idAllocator,
      importAttachments: (_entryId, media) =>
        media[0]?.url.endsWith("missing.png") && !recovered
          ? Effect.fail(new GrokBotBindingError({ reason: "Native attachment unavailable." }))
          : Effect.succeed([
              {
                type: "image" as const,
                id: "fixture-image",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 50,
              },
            ]),
    });
    const frame = transcript([
      {
        seq: "20",
        updatedSeq: "20",
        value: {
          id: "partial-images",
          kind: "send-message",
          message: {
            type: "text",
            content: "Images",
            images: [{ url: "file:///found.png" }, { url: "file:///missing.png" }],
          },
        },
      },
    ]);
    yield* projection.project(frame);
    assert.equal(projection.messages()[0]?.attachments.length, 1);
    assert.include(
      projection.messages()[0]?.text ?? "",
      "1 attachment is temporarily unavailable.",
    );
    recovered = true;
    yield* projection.project(frame);
    assert.equal(projection.messages()[0]?.attachments.length, 2);
    assert.equal(projection.messages()[0]?.text, "Images");
    assert.deepEqual(yield* projection.project(frame), []);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "replays history on cold attach even when the durable binding has an advanced cursor",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const cursor = yield* Deferred.make<{ generation: number; afterUpdatedSeq: string }>();
      const adapter = yield* createGrokBotAdapterV2(options).pipe(
        Effect.provideService(
          GrokBotNativeRuntimeService,
          makeNative({
            watch: (input) =>
              Stream.fromEffect(Deferred.succeed(cursor, input)).pipe(
                Stream.drain,
                Stream.concat(
                  Stream.fromIterable<RuntimeFrame>([
                    { _tag: "Cleared", generation: 7 },
                    {
                      _tag: "Rows",
                      generation: 7,
                      replay: true,
                      deletes: [],
                      entries: [
                        {
                          seq: "1",
                          updatedSeq: "1",
                          value: {
                            id: "older-native-answer",
                            kind: "send-message",
                            message: { type: "text", content: "Historical reply" },
                          },
                        },
                      ],
                    },
                  ]),
                ),
                Stream.concat(Stream.never),
              ),
          }),
        ),
        Effect.provideService(
          GrokBotManagedBinding,
          makeBindings(turn, {
            resolve: () =>
              Effect.succeed({ ...nativeSession, generation: 7, afterUpdatedSeq: "900" }),
          }),
        ),
      );
      const session = yield* adapter.openSession(sessionInput);
      const events = yield* session.events.pipe(Stream.take(2), Stream.runCollect);
      const watched = yield* Deferred.await(cursor);
      assert.equal(watched.generation, 0);
      assert.equal(watched.afterUpdatedSeq, "0");
      const message = events.find((event) => event.type === "message.updated");
      assert.equal(message?.message.text, "Historical reply");
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("preserves settled native message and turn item times when history replays later", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const frame = transcript([
      {
        seq: "1",
        updatedSeq: "1",
        value: {
          id: "past-native-file",
          kind: "send-message",
          timestampMs: 1000,
          message: { type: "attachment", url: "file:///past.txt", file_name: "past.txt" },
        },
      },
    ]);
    const importer = (_entryId: string) =>
      Effect.succeed([
        {
          type: "file" as const,
          id: "past-file",
          name: "past.txt",
          mimeType: "text/plain",
          sizeBytes: 700,
        },
      ]);
    const original = makeGrokBotTranscriptProjection({
      native: nativeSession,
      idAllocator,
      importAttachments: importer,
    });
    yield* TestClock.setTime(2000);
    const first = yield* original.project(frame);
    yield* TestClock.setTime(1_000_000);
    const reattached = makeGrokBotTranscriptProjection({
      native: nativeSession,
      idAllocator,
      importAttachments: importer,
    });
    const replayed = yield* reattached.project(frame);
    const oldMessage = first.find((event) => event.type === "message.updated")?.message;
    const newMessage = replayed.find((event) => event.type === "message.updated")?.message;
    assert.deepEqual(newMessage?.createdAt, oldMessage?.createdAt);
    assert.deepEqual(newMessage?.updatedAt, oldMessage?.updatedAt);
    assert.equal(DateTime.toEpochMillis(newMessage!.updatedAt), 1000);
    const oldItem = first.find((event) => event.type === "turn_item.updated")?.turnItem;
    const newItem = replayed.find((event) => event.type === "turn_item.updated")?.turnItem;
    assert.deepEqual(newItem?.completedAt, oldItem?.completedAt);
    assert.equal(DateTime.toEpochMillis(newItem!.completedAt!), 1000);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("keeps timestamp-free bot replies in their original position across reconnects", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const frame = transcript([
      {
        seq: "1",
        updatedSeq: "1",
        value: {
          id: "old-bot-reply",
          kind: "send-message",
          message: { type: "text", content: "Starting an audit thread now." },
        },
      },
    ]);
    yield* TestClock.setTime(1000);
    const original = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    const first = yield* original.project(frame);
    const oldMessage = first.find((event) => event.type === "message.updated")!.message;
    const oldItem = first.find((event) => event.type === "turn_item.updated")!.turnItem;
    for (const nowMs of [2000, 3000]) {
      yield* TestClock.setTime(nowMs);
      const reconnected = makeGrokBotTranscriptProjection({
        native: nativeSession,
        idAllocator,
        existingMessage: (id) => Effect.succeed(id === oldMessage.id ? oldMessage : undefined),
      });
      const replayed = yield* reconnected.project(frame);
      const message = replayed.find((event) => event.type === "message.updated")!.message;
      const item = replayed.find((event) => event.type === "turn_item.updated")!.turnItem;
      assert.deepEqual(message.createdAt, oldMessage.createdAt);
      assert.deepEqual(message.updatedAt, oldMessage.updatedAt);
      assert.deepEqual(item.startedAt, oldItem.startedAt);
      assert.deepEqual(item.completedAt, oldItem.completedAt);
    }
  }).pipe(Effect.provide(IdAllocator.layer)),
);

// The call end as the native client persists it: the summary has no channel and is linked to the
// call only by the requestId it shares with the call's voice-channel user rows.
const voiceUser = (seq: string, id: string, content: string, requestId: string) => ({
  seq,
  updatedSeq: "1",
  value: {
    id,
    kind: "message",
    role: "user",
    content,
    channel: "voice:call-1",
    channelSender: "the call",
    requestId,
    isStreaming: false,
  },
});
const sendText = (
  seq: string,
  id: string,
  content: string,
  requestId: string,
  channel?: string,
) => ({
  seq,
  updatedSeq: "1",
  value: {
    id,
    kind: "send-message",
    requestId,
    message: { type: "text", content, ...(channel === undefined ? {} : { channel }) },
  },
});
const voiceMarkerRow = {
  seq: "12",
  updatedSeq: "1",
  value: {
    id: "voice-call-row",
    kind: "voice-call",
    call: { callId: "call-1", durationMs: 12_000, ending: "completed", turnCount: 4 },
    timestampMs: 1,
  },
};
const voiceCallRows = [
  voiceUser("10", "voice-question", "what did we decide?", "req-voice"),
  sendText("11", "in-call-bot", "Here is the plan.", "req-voice", "voice:call-1"),
  voiceMarkerRow,
  voiceUser("13", "end-1", "The call ended. This channel is closed.", "req-end"),
  voiceUser("14", "end-2", "second voice row", "req-end"),
  sendText("15", "voice-summary", "We agreed on the rollout.", "req-end"),
  sendText("16", "followup", "Anything else?", "req-other"),
];

it.effect(
  "imports a voice call as a marker with its native summary and keeps the user's voice lines",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const projection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
      const events = yield* projection.project(
        transcript([
          ...voiceCallRows,
          {
            seq: "20",
            updatedSeq: "1",
            value: { id: "voice-call-malformed", kind: "voice-call", call: { durationMs: 1 } },
          },
        ]),
      );
      assert.deepStrictEqual(
        projection.messages().map((message) => ({
          text: message.text,
          role: message.role,
          createdBy: message.createdBy,
          voiceCall: message.grokBotVoiceCall,
          voiceCallId: message.grokBotVoiceCallId,
        })),
        [
          {
            text: "what did we decide?",
            role: "user",
            createdBy: "user",
            voiceCall: undefined,
            voiceCallId: undefined,
          },
          {
            text: "Here is the plan.",
            role: "assistant",
            createdBy: "agent",
            voiceCall: undefined,
            voiceCallId: undefined,
          },
          {
            text: "",
            role: "assistant",
            createdBy: "agent",
            voiceCall: { callId: "call-1", durationMs: 12_000, ending: "completed" },
            voiceCallId: undefined,
          },
          {
            text: "The call ended. This channel is closed.",
            role: "user",
            createdBy: "user",
            voiceCall: undefined,
            voiceCallId: undefined,
          },
          {
            text: "second voice row",
            role: "user",
            createdBy: "user",
            voiceCall: undefined,
            voiceCallId: undefined,
          },
          {
            text: "We agreed on the rollout.",
            role: "assistant",
            createdBy: "agent",
            voiceCall: undefined,
            voiceCallId: "call-1",
          },
          {
            text: "Anything else?",
            role: "assistant",
            createdBy: "agent",
            voiceCall: undefined,
            voiceCallId: undefined,
          },
        ],
      );
      const markerItem = events
        .filter((event) => event.type === "turn_item.updated")
        .map((event) => event.turnItem)
        .find((item) => item.type === "assistant_message" && item.grokBotVoiceCall !== undefined);
      assert.isTrue(markerItem?.type === "assistant_message");
      if (markerItem?.type === "assistant_message") {
        const persisted = yield* encodePersistedTurnItem(markerItem);
        const restored = yield* decodePersistedTurnItem(persisted);
        assert.isTrue(restored.type === "assistant_message");
        if (restored.type === "assistant_message")
          assert.deepStrictEqual(restored.grokBotVoiceCall, markerItem.grokBotVoiceCall);
      }
      const summaryItem = events
        .filter((event) => event.type === "turn_item.updated")
        .map((event) => event.turnItem)
        .find((item) => item.type === "assistant_message" && item.grokBotVoiceCallId !== undefined);
      assert.isTrue(summaryItem?.type === "assistant_message");
      if (summaryItem?.type === "assistant_message") {
        const persisted = yield* encodePersistedTurnItem(summaryItem);
        const restored = yield* decodePersistedTurnItem(persisted);
        assert.isTrue(restored.type === "assistant_message");
        if (restored.type === "assistant_message")
          assert.strictEqual(restored.grokBotVoiceCallId, "call-1");
      }
    }).pipe(Effect.provide(IdAllocator.layer)),
);

// The connector card as the native client persists it: a `send-message` row whose message names the
// connector host and native's server id, not text.
const connectorCardRow = (seq: string, id: string, message: Record<string, unknown>) => ({
  seq,
  updatedSeq: "1",
  value: {
    id,
    kind: "send-message",
    requestId: "req-connect",
    message: { type: "connector", ...message },
    timestampMs: 5,
  },
});

it.effect("imports a connector card with its server id, and survives persistence", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projection = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    const events = yield* projection.project(
      transcript([
        sendText("1", "intro", "I need access to Linear.", "req-connect"),
        connectorCardRow("2", "card", { connector: "mcp.linear.app", serverId: 7, variant: "x" }),
        connectorCardRow("3", "done", {
          connector: "mcp.linear.app",
          serverId: 7,
          variant: "connected",
        }),
        connectorCardRow("4", "no-server", { connector: "mcp.linear.app", variant: "connect" }),
        connectorCardRow("5", "bad-server", { connector: "mcp.linear.app", serverId: 0 }),
      ]),
    );
    assert.deepStrictEqual(
      projection.messages().map((message) => [message.text, message.grokBotConnectorCard]),
      [
        ["I need access to Linear.", undefined],
        [
          "Connect mcp.linear.app",
          { connector: "mcp.linear.app", serverId: 7, variant: "connect" },
        ],
        [
          "mcp.linear.app connected",
          { connector: "mcp.linear.app", serverId: 7, variant: "connected" },
        ],
      ],
    );
    const cardItem = events
      .filter((event) => event.type === "turn_item.updated")
      .map((event) => event.turnItem)
      .find((item) => item.type === "assistant_message" && item.text === "Connect mcp.linear.app");
    assert.isTrue(cardItem?.type === "assistant_message");
    if (cardItem?.type === "assistant_message") {
      const restored = yield* decodePersistedTurnItem(yield* encodePersistedTurnItem(cardItem));
      assert.isTrue(restored.type === "assistant_message");
      if (restored.type === "assistant_message")
        assert.deepStrictEqual(restored.grokBotConnectorCard, cardItem.grokBotConnectorCard);
    }
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("links the summary whatever the batch order and never tags foreign or in-call rows", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const tagOf = (projection: ReturnType<typeof makeGrokBotTranscriptProjection>) =>
      Object.fromEntries(
        projection.messages().map((message) => [message.text, message.grokBotVoiceCallId]),
      );
    const expected = {
      "what did we decide?": undefined,
      "Here is the plan.": undefined,
      "": undefined,
      "The call ended. This channel is closed.": undefined,
      "second voice row": undefined,
      "We agreed on the rollout.": "call-1",
      "Anything else?": undefined,
    };
    // Summary before its voice rows within one batch.
    const reordered = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    const summary = voiceCallRows.find((row) => row.value.id === "voice-summary")!;
    yield* reordered.project(
      transcript([summary, ...voiceCallRows.filter((row) => row !== summary)]),
    );
    assert.deepStrictEqual(tagOf(reordered), expected);
    // Voice rows and marker in an earlier frame, summary in a later one.
    const split = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    yield* split.project(transcript(voiceCallRows.slice(0, 5)));
    yield* split.project(transcript(voiceCallRows.slice(5)));
    assert.deepStrictEqual(tagOf(split), expected);
    // Replaying the same frame is a no-op.
    assert.deepStrictEqual(yield* split.project(transcript(voiceCallRows.slice(5))), []);
    // A request with no voice row is never claimed, and channelless in-call text before the marker stays untagged.
    const foreign = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    yield* foreign.project(
      transcript([
        voiceUser("10", "q", "question", "req-voice"),
        sendText("11", "early", "channelless in-call", "req-voice"),
        voiceMarkerRow,
        sendText("15", "other", "foreign", "req-foreign"),
      ]),
    );
    assert.deepStrictEqual(tagOf(foreign), {
      question: undefined,
      "channelless in-call": undefined,
      "": undefined,
      foreign: undefined,
    });
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("replaying a voice call row keeps one marker with the same identity", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const row = {
      seq: "3",
      updatedSeq: "1",
      value: {
        id: "voice-call-row",
        kind: "voice-call",
        call: { callId: "call-1", durationMs: 12_000, ending: "completed" },
      },
    };
    const first = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    const firstEvents = yield* first.project(transcript([row]));
    const replayed = makeGrokBotTranscriptProjection({ native: nativeSession, idAllocator });
    yield* replayed.project(transcript([row], true));
    const again = yield* replayed.project(transcript([row], true));
    assert.lengthOf(first.messages(), 1);
    assert.lengthOf(replayed.messages(), 1);
    assert.deepStrictEqual(again, []);
    assert.equal(replayed.messages()[0]?.id, first.messages()[0]?.id);
    assert.isTrue(firstEvents.some((event) => event.type === "turn_item.updated"));
  }).pipe(Effect.provide(IdAllocator.layer)),
);
