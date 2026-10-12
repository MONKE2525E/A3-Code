import { assert, expect, it } from "@effect/vitest";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import { ProviderSessionId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import {
  NativeRuntimeError,
  type RuntimeFrame,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import {
  decodeGrokBotApproval,
  grokBotApprovalCall,
  makeGrokBotApprovalProjection,
} from "./GrokBotApprovalProjection.ts";
import { makeTurn, nativeSession, providerSessionId } from "./GrokBotProvider.testkit.ts";

const rowsFrame = (
  entries: readonly { seq: string; updatedSeq: string; entryId?: string; value: unknown }[],
  deletes: readonly { seq: string; updatedSeq: string; entryId?: string }[] = [],
): Extract<RuntimeFrame, { readonly _tag: "Rows" }> => ({
  _tag: "Rows",
  generation: 0,
  entries,
  deletes,
  replay: false,
});
const card = (id: string, requestId: string, approval: object = {}) => ({
  kind: "send-message",
  id,
  requestId,
  timestampMs: 1,
  message: {
    type: "approval",
    approval: { status: "pending", requestId, summary: "Run ls", ...approval },
  },
});

const widgetCard = (id: string, widget: object = {}) => ({
  kind: "send-message",
  id,
  message: {
    type: "widget",
    widget: {
      prompt: "Pick one",
      options: [{ label: "Alpha", value: "a" }, { label: "Beta" }],
      ...widget,
    },
  },
});

const makeHarness = (
  sessionId = providerSessionId,
  threadId?: ProviderThreadId,
  appThreadId = nativeSession.threadId,
  nativeSessionId = nativeSession.sessionId,
  turnForRequest?: Parameters<typeof makeGrokBotApprovalProjection>[0]["turnForRequest"],
) =>
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const calls: { method: string; input: object }[] = [];
    let failure: "refused" | "uncertain" | undefined;
    const call = (method: string) => (input: object) => {
      calls.push({ method, input });
      return failure === undefined
        ? Effect.succeed({})
        : Effect.fail(new NativeRuntimeError({ kind: failure }));
    };
    const projection = makeGrokBotApprovalProjection({
      native: { ...nativeSession, threadId: appThreadId, sessionId: nativeSessionId },
      providerThreadId:
        threadId ??
        ids.derive.providerThread({
          driver: "grok-bot" as never,
          nativeThreadId: "t",
        }),
      providerSessionId: sessionId,
      idAllocator: ids,
      ...(turnForRequest === undefined ? {} : { turnForRequest }),
      runtime: {
        resolveAutoReviewApproval: call("auto"),
        respondToWidget: call("widget"),
        dismissWidget: call("dismiss"),
      },
    });
    return {
      projection,
      calls,
      fail: (kind: typeof failure) => {
        failure = kind;
      },
    };
  });
import { grokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";

const harness = makeHarness();
const pendingRequest = (events: readonly { type: string }[]) =>
  events.flatMap((event) =>
    event.type === "runtime_request.updated"
      ? [(event as unknown as { runtimeRequest: { id: never; status: string } }).runtimeRequest]
      : [],
  );

it.effect("projects pending nested approvals once, outside any run, and ignores replays", () =>
  Effect.gen(function* () {
    const { projection } = yield* harness;
    const frame = rowsFrame([
      { seq: "1", updatedSeq: "1", value: card("e1", "r1", { command: "ls" }) },
      { seq: "2", updatedSeq: "1", value: { id: "m", kind: "message", role: "user" } },
      {
        seq: "3",
        updatedSeq: "1",
        value: {
          kind: "send-message",
          id: "w",
          requestId: "r3",
          message: { type: "widget", widget: { prompt: "p", options: [] } },
        },
      },
    ]);
    const events = yield* projection.project(frame);
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["node.updated", "runtime_request.updated", "turn_item.updated"],
    );
    const node = events[0];
    assert.strictEqual(node?.type === "node.updated" ? node.node.runId : "x", null);
    assert.deepStrictEqual(
      pendingRequest(events).map((r) => r.status),
      ["pending"],
    );
    assert.deepStrictEqual(yield* projection.project(frame), []);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("hides answered or deleted cards and never resurrects them", () =>
  Effect.gen(function* () {
    const { projection } = yield* harness;
    assert.deepStrictEqual(
      yield* projection.project(
        rowsFrame([{ seq: "1", updatedSeq: "1", value: card("c0", "q0", { status: "approved" }) }]),
      ),
      [],
    );
    yield* projection.project(rowsFrame([{ seq: "2", updatedSeq: "1", value: card("c1", "q1") }]));
    const answered = yield* projection.project(
      rowsFrame([{ seq: "2", updatedSeq: "2", value: card("c1", "q1", { status: "denied" }) }]),
    );
    assert.deepStrictEqual(
      pendingRequest(answered).map((r) => r.status),
      ["resolved"],
    );
    assert.deepStrictEqual(
      yield* projection.project(
        rowsFrame([{ seq: "2", updatedSeq: "3", value: card("c1", "q1") }]),
      ),
      [],
    );
    yield* projection.project(rowsFrame([{ seq: "4", updatedSeq: "1", value: card("l1", "q2") }]));
    const removed = yield* projection.project(
      rowsFrame([], [{ seq: "4", updatedSeq: "2", entryId: "l1" }]),
    );
    assert.deepStrictEqual(
      pendingRequest(removed).map((r) => r.status),
      ["cancelled"],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("dispatches the desktop-platform resolution and settles only after confirmation", () =>
  Effect.gen(function* () {
    const { projection, calls, fail } = yield* harness;
    const events = yield* projection.project(
      rowsFrame([
        { seq: "1", updatedSeq: "1", value: card("e1", "r1", { command: "ls -la" }) },
        { seq: "2", updatedSeq: "1", value: card("e2", "r2") },
      ]),
    );
    const [first, second] = pendingRequest(events);
    fail("refused");
    assert.strictEqual(
      (yield* projection.respond(first!.id, "accept").pipe(Effect.flip))._tag,
      "GrokBotNativeRuntimeError",
    );
    fail("uncertain");
    yield* projection.respond(first!.id, "accept").pipe(Effect.flip);
    fail(undefined);
    const settled = yield* projection.respond(first!.id, "accept");
    assert.deepStrictEqual(
      pendingRequest(settled).map((r) => r.status),
      ["resolved"],
    );
    // A replayed call after native settled the card is a no-op, not a second native call.
    assert.deepStrictEqual(yield* projection.respond(first!.id, "accept"), []);
    for (const unsupported of ["acceptAlways", "acceptForSession"] as const)
      assert.strictEqual(
        (yield* projection.respond(second!.id, unsupported).pipe(Effect.flip))._tag,
        "GrokBotBindingError",
      );
    yield* projection.respond(second!.id, "decline");
    expect(calls.slice(-2).map((c) => c.input)).toEqual([
      expect.objectContaining({
        resolution: "APPROVED",
        approvalPlatform: "desktop",
        approvedCommand: "ls -la",
        requestId: "r1",
      }),
      expect.objectContaining({
        resolution: "DENIED",
        approvalPlatform: "desktop",
        requestId: "r2",
      }),
    ]);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("rejects responses for requests this session never projected", () =>
  Effect.gen(function* () {
    const { projection } = yield* harness;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const foreign = yield* ids.allocate.runtimeRequest({ driver: "grok-bot" as never });
    assert.strictEqual(
      (yield* projection.respond(foreign, "accept").pipe(Effect.flip))._tag,
      "GrokBotBindingError",
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("projects a waiting widget as an async question that keeps native dismissal", () =>
  Effect.gen(function* () {
    const { projection } = yield* harness;
    const frame = rowsFrame([
      {
        seq: "1",
        updatedSeq: "1",
        value: widgetCard("q1", { allowCustom: true, multiSelect: true }),
      },
    ]);
    const events = yield* projection.project(frame);
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["node.updated", "runtime_request.updated", "turn_item.updated"],
    );
    const [node, request, item] = events as unknown as {
      node: object;
      runtimeRequest: object;
      turnItem: object;
    }[];
    expect(node?.node).toMatchObject({ kind: "user_input_request", status: "waiting" });
    expect(request?.runtimeRequest).toMatchObject({
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message", providerSessionId },
    });
    expect(item?.turnItem).toMatchObject({
      type: "user_input_request",
      questions: [
        {
          id: "q1",
          question: "Pick one",
          multiSelect: true,
          allowCustomAnswer: true,
          options: [
            { label: "Alpha", description: "Alpha", value: "a" },
            { label: "Beta", description: "Beta" },
          ],
        },
      ],
    });
    assert.deepStrictEqual(yield* projection.project(frame), []);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("offers a custom answer even when the native widget does not allow one", () =>
  Effect.gen(function* () {
    const { projection } = yield* harness;
    const events = yield* projection.project(
      rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1") }]),
    );
    const [, , item] = events as unknown as { turnItem: object }[];
    expect(item?.turnItem).toMatchObject({
      questions: [{ id: "q1", allowCustomAnswer: true }],
    });
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("settles widgets from native state and supersedes older open questions", () =>
  Effect.gen(function* () {
    const { projection } = yield* harness;
    yield* projection.project(rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1") }]));
    const second = yield* projection.project(
      rowsFrame([{ seq: "2", updatedSeq: "1", value: widgetCard("q2") }]),
    );
    assert.deepStrictEqual(
      pendingRequest(second).map((r) => r.status),
      ["cancelled", "pending"],
    );
    assert.deepStrictEqual(
      pendingRequest(
        yield* projection.project(
          rowsFrame([
            { seq: "2", updatedSeq: "2", value: { ...widgetCard("q2"), respondedValue: "a" } },
          ]),
        ),
      ).map((r) => r.status),
      ["resolved"],
    );
    yield* projection.project(rowsFrame([{ seq: "3", updatedSeq: "1", value: widgetCard("q3") }]));
    assert.deepStrictEqual(
      pendingRequest(
        yield* projection.project(rowsFrame([], [{ seq: "3", updatedSeq: "2", entryId: "q3" }])),
      ).map((r) => r.status),
      ["cancelled"],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "reuses card identity after observer restart and routes answers through the new session",
  () =>
    Effect.gen(function* () {
      const first = yield* harness;
      const sessionId = ProviderSessionId.make("reopened-observer");
      const second = yield* makeHarness(
        sessionId,
        ProviderThreadId.make("managed-turn-provider-thread"),
      );
      const otherThread = yield* makeHarness(
        sessionId,
        ProviderThreadId.make("another-native-thread"),
        ThreadId.make("another-canonical-bot-thread"),
      );
      const frame = rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1") }]);
      const initial = pendingRequest(yield* first.projection.project(frame))[0]!;
      const replayed = yield* second.projection.project({ ...frame, replay: true });
      const restored = pendingRequest(replayed)[0]!;
      assert.strictEqual(restored.id, initial.id);
      assert.notStrictEqual(
        pendingRequest(yield* otherThread.projection.project(frame))[0]!.id,
        initial.id,
      );
      const requestEvent = replayed.find((event) => event.type === "runtime_request.updated");
      assert.strictEqual(requestEvent?.type, "runtime_request.updated");
      if (requestEvent?.type === "runtime_request.updated")
        assert.deepStrictEqual(requestEvent.runtimeRequest.responseCapability, {
          type: "message",
          providerSessionId: sessionId,
        });
      yield* second.projection.answer(restored.id, { q1: "a" });
      assert.strictEqual(second.calls.length, 1);
      assert.deepStrictEqual(yield* second.projection.project(frame), []);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "keeps reused widget entry IDs separate across native sessions of the same bot thread",
  () =>
    Effect.gen(function* () {
      const first = yield* makeHarness(
        providerSessionId,
        undefined,
        nativeSession.threadId,
        "native-session-one",
      );
      const second = yield* makeHarness(
        providerSessionId,
        undefined,
        nativeSession.threadId,
        "native-session-two",
      );
      const frame = rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("t1s1") }]);
      const firstRequest = pendingRequest(yield* first.projection.project(frame))[0]!;
      const secondRequest = pendingRequest(yield* second.projection.project(frame))[0]!;
      assert.notStrictEqual(firstRequest.id, secondRequest.id);
      yield* first.projection.answer(firstRequest.id, { t1s1: "a" });
      yield* second.projection.answer(secondRequest.id, { t1s1: "a" });
      expect(first.calls[0]?.input).toEqual(
        expect.objectContaining({ sessionId: "native-session-one" }),
      );
      expect(second.calls[0]?.input).toEqual(
        expect.objectContaining({ sessionId: "native-session-two" }),
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("a full replay exposes only the latest native widget regardless of row order", () =>
  Effect.gen(function* () {
    const { projection } = yield* harness;
    const frame = rowsFrame([
      { seq: "3", updatedSeq: "3", value: widgetCard("latest") },
      { seq: "1", updatedSeq: "9", value: widgetCard("old") },
      { seq: "2", updatedSeq: "8", value: widgetCard("older") },
    ]);
    const events = yield* projection.project({ ...frame, replay: true });
    assert.strictEqual(pendingRequest(events).length, 1);
    const item = events.find((event) => event.type === "turn_item.updated");
    assert.strictEqual(
      item?.type === "turn_item.updated" && item.turnItem.type === "user_input_request"
        ? item.turnItem.questions[0]?.id
        : undefined,
      "latest",
    );
    assert.deepStrictEqual(yield* projection.project(frame), []);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "a newer settled widget retires the previous question without surfacing stale history",
  () =>
    Effect.gen(function* () {
      const { projection } = yield* harness;
      const initial = rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("old") }]);
      yield* projection.project(initial);
      const settled = rowsFrame([
        { seq: "2", updatedSeq: "2", value: { ...widgetCard("latest"), respondedValue: "a" } },
      ]);
      assert.deepStrictEqual(
        pendingRequest(yield* projection.project(settled)).map((r) => r.status),
        ["cancelled", "resolved"],
      );
      const restarted = yield* harness;
      assert.deepStrictEqual(
        pendingRequest(
          yield* restarted.projection.project({
            ...initial,
            entries: [...initial.entries, ...settled.entries],
            replay: true,
          }),
        ).map((request) => request.status),
        ["resolved"],
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("answers a widget natively only with one of its choices, once", () =>
  Effect.gen(function* () {
    const { projection, calls, fail } = yield* harness;
    const [first] = pendingRequest(
      yield* projection.project(
        rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1") }]),
      ),
    );
    // Approve or deny does not apply to a question, and nothing reaches native.
    assert.strictEqual(
      (yield* projection.respond(first!.id, "accept").pipe(Effect.flip))._tag,
      "GrokBotBindingError",
    );
    assert.strictEqual(calls.length, 0);
    fail("refused");
    assert.strictEqual(
      (yield* projection.answer(first!.id, { q1: "a" }).pipe(Effect.flip))._tag,
      "GrokBotNativeRuntimeError",
    );
    fail(undefined);
    // Native confirmation is what settles the question, and the settled events carry the answer.
    const answered = yield* projection.answer(first!.id, { q1: "a" });
    assert.deepStrictEqual(
      pendingRequest(answered).map((r) => r.status),
      ["resolved"],
    );
    expect(answered).toContainEqual(
      expect.objectContaining({
        type: "turn_item.updated",
        turnItem: expect.objectContaining({
          status: "completed",
          questionAnswer: expect.objectContaining({ answers: { q1: "a" } }),
        }),
      }),
    );
    // A replay after native settled is a no-op, not a second native call.
    assert.deepStrictEqual(yield* projection.answer(first!.id, { q1: "a" }), []);
    expect(calls.filter((call) => call.method === "widget")).toEqual([
      { method: "widget", input: expect.objectContaining({ entryId: "q1", value: "a" }) },
      { method: "widget", input: expect.objectContaining({ entryId: "q1", value: "a" }) },
    ]);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("clears a widget natively on dismissal and never reopens it", () =>
  Effect.gen(function* () {
    const { projection, calls, fail } = yield* harness;
    const [request] = pendingRequest(
      yield* projection.project(
        rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1") }]),
      ),
    );
    // A refused dismissal leaves the card available: nothing is reported as cleared.
    fail("refused");
    assert.strictEqual(
      (yield* projection.respond(request!.id, "cancel").pipe(Effect.flip))._tag,
      "GrokBotNativeRuntimeError",
    );
    fail(undefined);
    const dismissed = yield* projection.respond(request!.id, "cancel");
    assert.deepStrictEqual(
      pendingRequest(dismissed).map((r) => r.status),
      ["cancelled"],
    );
    expect(calls.at(-1)).toEqual({
      method: "dismiss",
      input: expect.objectContaining({ entryId: "q1" }),
    });
    assert.deepStrictEqual(yield* projection.respond(request!.id, "cancel"), []);
    assert.deepStrictEqual(
      yield* projection.project(
        rowsFrame([
          { seq: "1", updatedSeq: "2", value: { ...widgetCard("q1"), widgetDismissed: true } },
        ]),
      ),
      [],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("keeps refused custom native answers pending and resolves only after acceptance", () =>
  Effect.gen(function* () {
    const { projection, calls, fail } = yield* harness;
    const [request] = pendingRequest(
      yield* projection.project(
        rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1") }]),
      ),
    );
    fail("uncertain");
    yield* projection.answer(request!.id, { q1: "Gamma custom" }).pipe(Effect.flip);
    assert.deepStrictEqual(
      pendingRequest(yield* projection.replayPending()).map((r) => r.status),
      ["pending"],
    );
    expect(calls.at(-1)).toEqual({
      method: "widget",
      input: expect.objectContaining({ entryId: "q1", value: "Gamma custom" }),
    });
    fail(undefined);
    const resolved = pendingRequest(yield* projection.answer(request!.id, { q1: "Gamma custom" }));
    assert.deepStrictEqual(
      resolved.map((r) => r.status),
      ["resolved"],
    );

    assert.isFalse(calls.some((call) => call.method === "dismiss"));
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("clears a chat-answered question silently and never overwrites its record", () =>
  Effect.gen(function* () {
    const { projection, calls, fail } = yield* harness;
    const [chatted] = pendingRequest(
      yield* projection.project(
        rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1", { multiSelect: true }) }]),
      ),
    );
    // Unsupported multi-select text was already recorded in chat. Its native clear is refused.
    fail("uncertain");
    assert.strictEqual(
      (yield* projection.answer(chatted!.id, { q1: ["Gamma"] }).pipe(Effect.flip))._tag,
      "GrokBotNativeRuntimeError",
    );
    fail(undefined);
    // A newer question and a native removal of the old card must not emit over the recorded answer.
    const superseding = yield* projection.project(
      rowsFrame([{ seq: "2", updatedSeq: "1", value: widgetCard("q2") }]),
    );
    // Only the new question is emitted; the older one is not cancelled over its answer.
    assert.deepStrictEqual(
      pendingRequest(superseding).map((r) => r.status),
      ["pending"],
    );
    assert.deepStrictEqual(
      yield* projection.project(rowsFrame([], [{ seq: "1", updatedSeq: "3", entryId: "q1" }])),
      [],
    );
    // The retry clears the card without emitting: the transcript already holds the answer.
    assert.deepStrictEqual(yield* projection.answer(chatted!.id, { q1: ["Gamma"] }), []);
    expect(calls.at(-1)).toEqual({
      method: "dismiss",
      input: expect.objectContaining({ entryId: "q1" }),
    });
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it("rejects malformed or non-approval entries", () => {
  assert.isDefined(decodeGrokBotApproval(card("e", "r")));
  const approval = decodeGrokBotApproval(card("e", "r"));
  assert.isDefined(approval && grokBotApprovalCall(approval, "decline"));
  assert.isUndefined(approval && grokBotApprovalCall(approval, "acceptAlways"));
  assert.isUndefined(decodeGrokBotApproval({ ...card("e", "r"), id: undefined }));
  assert.isUndefined(
    decodeGrokBotApproval({ id: "e", kind: "auto_review_approval", requestId: "r" }),
  );
  assert.isUndefined(decodeGrokBotApproval("text"));
});

it.effect(
  "associates a pending native question with its exact managed request and retains ownership on answer",
  () =>
    Effect.gen(function* () {
      const turn = grokBotTurnIdentity(yield* makeTurn);
      const { projection } = yield* makeHarness(
        providerSessionId,
        undefined,
        nativeSession.threadId,
        nativeSession.sessionId,
        (requestId) => (requestId === "owned" ? turn : undefined),
      );
      const events = yield* projection.project(
        rowsFrame([
          {
            seq: "1",
            updatedSeq: "1",
            value: { ...widgetCard("owned-widget"), requestId: "owned" },
          },
        ]),
      );
      const node = events.find((e) => e.type === "node.updated");
      assert.strictEqual(node?.type === "node.updated" ? node.node.runId : null, turn.runId);
      assert.strictEqual(
        node?.type === "node.updated" ? node.node.parentNodeId : null,
        turn.rootNodeId,
      );
      const request = events.find((e) => e.type === "runtime_request.updated");
      assert.strictEqual(
        request?.type === "runtime_request.updated" ? request.runtimeRequest.providerTurnId : null,
        turn.providerTurnId,
      );
      const replay = yield* projection.replayPending();
      const replayedRequest = replay.find((e) => e.type === "runtime_request.updated");
      assert.strictEqual(
        replayedRequest?.type === "runtime_request.updated"
          ? replayedRequest.runtimeRequest.providerTurnId
          : null,
        turn.providerTurnId,
      );
      const answer = yield* projection.project(
        rowsFrame([
          {
            seq: "1",
            updatedSeq: "2",
            value: { ...widgetCard("owned-widget"), requestId: "owned", respondedValue: "a" },
          },
        ]),
      );
      const answeredNode = answer.find((e) => e.type === "node.updated");
      assert.strictEqual(
        answeredNode?.type === "node.updated" ? answeredNode.node.runId : null,
        turn.runId,
      );
      assert.strictEqual(
        answeredNode?.type === "node.updated" ? answeredNode.node.status : null,
        "completed",
      );
      assert.strictEqual(
        answer.some((e) => e.type === "turn.terminal"),
        false,
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("re-associates a runless pending question when its managed echo arrives later", () =>
  Effect.gen(function* () {
    const turn = grokBotTurnIdentity(yield* makeTurn);
    let echoKnown = false;
    const { projection } = yield* makeHarness(
      providerSessionId,
      undefined,
      nativeSession.threadId,
      nativeSession.sessionId,
      (requestId) => (echoKnown && requestId === "owned" ? turn : undefined),
    );
    yield* projection.project(
      rowsFrame([
        { seq: "1", updatedSeq: "1", value: { ...widgetCard("late-widget"), requestId: "owned" } },
      ]),
    );
    echoKnown = true;
    const events = yield* projection.project(rowsFrame([]));
    const node = events.find((e) => e.type === "node.updated");
    assert.strictEqual(node?.type === "node.updated" ? node.node.runId : null, turn.runId);
    assert.strictEqual(node?.type === "node.updated" ? node.node.status : null, "waiting");
    assert.deepStrictEqual(yield* projection.project(rowsFrame([])), []);
  }).pipe(Effect.provide(IdAllocator.layer)),
);
