import { assert, expect, it } from "@effect/vitest";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
    type: "auto-review-approval",
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
  nativeOwner: Partial<Pick<typeof nativeSession, "binding" | "botId">> = {},
  beforeResolve?: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const calls: { method: string; input: object }[] = [];
    let failure: "refused" | "uncertain" | undefined;
    const call = (method: string) => (input: object) =>
      Effect.gen(function* () {
        calls.push({ method, input });
        if (beforeResolve !== undefined) yield* beforeResolve;
        if (failure !== undefined) return yield* new NativeRuntimeError({ kind: failure });
        return {};
      });
    const projection = makeGrokBotApprovalProjection({
      native: {
        ...nativeSession,
        ...nativeOwner,
        threadId: appThreadId,
        sessionId: nativeSessionId,
      },
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
        resolveLocalToolPermission: call("local"),
        resolveConnectorGrant: call("connector"),
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

it.effect("honors the native custom-answer flag", () =>
  Effect.gen(function* () {
    const { projection } = yield* harness;
    const events = yield* projection.project(
      rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1") }]),
    );
    const [, , item] = events as unknown as { turnItem: object }[];
    expect(item?.turnItem).toMatchObject({
      questions: [{ id: "q1", allowCustomAnswer: false }],
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
        rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1", { allowCustom: true }) }]),
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
  assert.isUndefined(decodeGrokBotApproval({ ...card("e", "r"), kind: "message" }));
  assert.isUndefined(
    decodeGrokBotApproval({
      ...card("e", "r"),
      message: { type: "approval", approval: { requestId: "r", status: "pending" } },
    }),
  );
  assert.isUndefined(decodeGrokBotApproval(card("e", "r", { requestId: undefined })));
  assert.isUndefined(decodeGrokBotApproval(card("e", "r", { status: undefined })));
});

const localCard = (id: string, requestId: string, ask: object = {}) => ({
  kind: "send-message",
  id,
  message: {
    type: "local-tool-permission",
    ask: {
      requestId,
      status: "pending",
      action: "read-file",
      target: "/workspace/config.json",
      description: "Read the config",
      ...ask,
    },
  },
});
const connectorCard = (id: string, requestId: string, ask: object = {}) => ({
  kind: "send-message",
  id,
  message: {
    type: "connector-grant",
    ask: { requestId, status: "pending", serverName: "Calendar", ...ask },
  },
});

const permissionCases = [
  {
    makeCard: localCard,
    method: "local",
    allow: "ALLOW_ONCE",
    deny: "DENY",
    labels: ["Allow once", "Deny"],
    prompt: "Read the config\nread-file: /workspace/config.json",
  },
  {
    makeCard: connectorCard,
    method: "connector",
    allow: "ALLOWED",
    deny: "SKIPPED",
    labels: ["Allow", "Skip"],
    prompt: "Allow access to Calendar?",
  },
];
it.effect.each(permissionCases)(
  "projects $method permission with once-only native choices and confirmed callbacks",
  ({ makeCard, method, allow, deny, labels, prompt }) =>
    Effect.gen(function* () {
      const { projection, calls, fail } = yield* harness;
      const frame = rowsFrame([
        { seq: "1", updatedSeq: "1", value: makeCard("e1", "r1") },
        { seq: "2", updatedSeq: "1", value: makeCard("e2", "r2") },
      ]);
      const events = yield* projection.project(frame);
      const [first, second] = pendingRequest(events);
      const item = events.find((e) => e.type === "turn_item.updated");
      assert.equal(
        item?.type === "turn_item.updated" && item.turnItem.type === "approval_request"
          ? item.turnItem.prompt
          : undefined,
        prompt,
      );
      assert.deepStrictEqual(
        item?.type === "turn_item.updated" && item.turnItem.type === "approval_request"
          ? item.turnItem.options?.map((o) => o.label)
          : undefined,
        labels,
      );
      assert.deepStrictEqual(yield* projection.project({ ...frame, replay: true }), []);
      for (const failure of ["refused", "uncertain"] as const) {
        fail(failure);
        const error = yield* projection.respond(first!.id, "accept").pipe(Effect.flip);
        assert.equal(error._tag === "GrokBotNativeRuntimeError" ? error.kind : undefined, failure);
        assert.deepStrictEqual(
          pendingRequest(yield* projection.replayPending()).map((r) => r.status),
          ["pending", "pending"],
        );
      }
      fail(undefined);
      const before = calls.length;
      for (const decision of ["acceptAlways", "acceptForSession"] as const)
        assert.equal(
          (yield* projection.respond(first!.id, decision).pipe(Effect.flip))._tag,
          "GrokBotBindingError",
        );
      assert.equal(calls.length, before);
      assert.deepStrictEqual(
        pendingRequest(yield* projection.respond(first!.id, "accept")).map((r) => r.status),
        ["resolved"],
      );
      assert.deepStrictEqual(yield* projection.respond(first!.id, "accept"), []);
      yield* projection.respond(second!.id, "decline");
      assert.deepStrictEqual(calls.slice(-2), [
        {
          method,
          input: {
            binding: nativeSession.binding,
            botId: nativeSession.botId,
            sessionId: nativeSession.sessionId,
            entryId: "e1",
            requestId: "r1",
            resolution: allow,
          },
        },
        {
          method,
          input: {
            binding: nativeSession.binding,
            botId: nativeSession.botId,
            sessionId: nativeSession.sessionId,
            entryId: "e2",
            requestId: "r2",
            resolution: deny,
          },
        },
      ]);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each(permissionCases)(
  "handles native settlement, stale versions, deletion and reordered $method rows",
  ({ makeCard }) =>
    Effect.gen(function* () {
      const { projection, calls } = yield* harness;
      const frame = rowsFrame([{ seq: "1", updatedSeq: "2", value: makeCard("e1", "r1") }]);
      const [request] = pendingRequest(yield* projection.project(frame));
      assert.deepStrictEqual(
        yield* projection.project(rowsFrame([], [{ seq: "1", updatedSeq: "1", entryId: "e1" }])),
        [],
      );
      assert.deepStrictEqual(
        pendingRequest(
          yield* projection.project(
            rowsFrame([
              { seq: "1", updatedSeq: "3", value: makeCard("e1", "r1", { status: "allowed" }) },
            ]),
          ),
        ).map((r) => r.status),
        ["resolved"],
      );
      assert.deepStrictEqual(yield* projection.project(frame), []);
      assert.deepStrictEqual(yield* projection.respond(request!.id, "accept"), []);
      const deleted = pendingRequest(
        yield* projection.project(
          rowsFrame([{ seq: "2", updatedSeq: "4", value: makeCard("e2", "r2") }]),
        ),
      )[0]!;
      assert.deepStrictEqual(
        pendingRequest(
          yield* projection.project(rowsFrame([], [{ seq: "2", updatedSeq: "5", entryId: "e2" }])),
        ).map((r) => r.status),
        ["cancelled"],
      );
      assert.deepStrictEqual(yield* projection.respond(deleted.id, "accept"), []);
      assert.equal(calls.length, 0);
      const restarted = yield* harness;
      assert.deepStrictEqual(
        yield* restarted.projection.project(
          rowsFrame([
            {
              seq: "1",
              updatedSeq: "8",
              value: makeCard("settled", "settled", { status: "expired" }),
            },
            { seq: "1", updatedSeq: "7", value: makeCard("settled", "settled") },
          ]),
        ),
        [],
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("keeps approval, local-tool and connector request namespaces separate", () =>
  Effect.gen(function* () {
    const { projection, calls } = yield* harness;
    const requests = pendingRequest(
      yield* projection.project(
        rowsFrame([
          { seq: "1", updatedSeq: "1", value: card("command", "shared") },
          { seq: "2", updatedSeq: "1", value: localCard("local", "shared") },
          { seq: "3", updatedSeq: "1", value: connectorCard("connector", "shared") },
        ]),
      ),
    );
    assert.equal(new Set(requests.map((r) => r.id)).size, 3);
    for (const request of requests) yield* projection.respond(request.id, "accept");
    assert.deepStrictEqual(
      calls.map((c) => c.method),
      ["auto", "local", "connector"],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("binds reused native requests to their exact account, bot and session", () =>
  Effect.gen(function* () {
    const first = yield* harness;
    const frame = rowsFrame([{ seq: "1", updatedSeq: "1", value: localCard("entry", "request") }]);
    const [owned] = pendingRequest(yield* first.projection.project(frame));
    for (const { sessionId, owner } of [
      { sessionId: nativeSession.sessionId, owner: { binding: "b".repeat(64) } },
      { sessionId: nativeSession.sessionId, owner: { botId: "another-bot" } },
      { sessionId: "another-session", owner: {} },
    ]) {
      const foreign = yield* makeHarness(
        providerSessionId,
        undefined,
        nativeSession.threadId,
        sessionId,
        undefined,
        owner,
      );
      const [request] = pendingRequest(yield* foreign.projection.project(frame));
      assert.notEqual(request!.id, owned!.id);
      assert.equal(
        (yield* foreign.projection.respond(owned!.id, "accept").pipe(Effect.flip))._tag,
        "GrokBotBindingError",
      );
      assert.equal(foreign.calls.length, 0);
    }
    yield* first.projection.respond(owned!.id, "accept");
    assert.deepStrictEqual(first.calls[0]?.input, {
      binding: nativeSession.binding,
      botId: nativeSession.botId,
      sessionId: nativeSession.sessionId,
      entryId: "entry",
      requestId: "request",
      resolution: "ALLOW_ONCE",
    });
  }).pipe(Effect.provide(IdAllocator.layer)),
);

const multiselectCases = [
  {
    name: "two values in option order",
    widget: {},
    answer: ["Beta", "a", "a"],
    expected: "a\nBeta",
  },
  {
    name: "value rather than label",
    widget: { allowCustom: true },
    answer: ["Alpha", "a"],
    expected: "a\nAlpha",
  },
  {
    name: "label fallback and newline normalization",
    widget: { options: [{ label: "One", value: " one\n\nvalue " }, { label: " two\nlabel " }] },
    answer: [" two\nlabel ", " one\n\nvalue "],
    expected: "one value\ntwo label",
  },
  {
    name: "custom text after selected values",
    widget: { allowCustom: true },
    answer: [" custom\n\nanswer ", "Beta", "a"],
    expected: "a\nBeta\ncustom answer",
  },
  {
    name: "custom multiline string",
    widget: { allowCustom: true },
    answer: " custom\n \nanswer ",
    expected: "custom answer",
  },
];
it.effect.each(multiselectCases)(
  "serializes native multiselect $name without dismissal",
  ({ widget, answer, expected }) =>
    Effect.gen(function* () {
      const { projection, calls, fail } = yield* harness;
      const [request] = pendingRequest(
        yield* projection.project(
          rowsFrame([
            {
              seq: "1",
              updatedSeq: "1",
              value: widgetCard("q1", { multiSelect: true, ...widget }),
            },
          ]),
        ),
      );
      fail("refused");
      yield* projection.answer(request!.id, { q1: answer }).pipe(Effect.flip);
      assert.equal(projection.hasPending(), true);
      fail("uncertain");
      yield* projection.answer(request!.id, { q1: answer }).pipe(Effect.flip);
      assert.equal(projection.hasPending(), true);
      fail(undefined);
      assert.deepStrictEqual(
        pendingRequest(yield* projection.answer(request!.id, { q1: answer })).map((r) => r.status),
        ["resolved"],
      );
      const count = calls.length;
      assert.deepStrictEqual(yield* projection.answer(request!.id, { q1: answer }), []);
      assert.equal(calls.length, count);
      assert.deepStrictEqual(calls.at(-1), {
        method: "widget",
        input: {
          binding: nativeSession.binding,
          botId: nativeSession.botId,
          sessionId: nativeSession.sessionId,
          entryId: "q1",
          value: expected,
        },
      });
      assert.isFalse(calls.some((c) => c.method === "dismiss"));
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("keeps invalid, empty, disallowed custom and cross-question answers pending", () =>
  Effect.gen(function* () {
    const { projection, calls } = yield* harness;
    const [request] = pendingRequest(
      yield* projection.project(
        rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("q1", { multiSelect: true }) }]),
      ),
    );
    for (const answers of [
      { q1: [] },
      { q1: " " },
      { q1: ["\n"] },
      { q1: [42] },
      { q1: ["custom"] },
      { q2: ["a"] },
      { q1: ["a"], q2: "Beta" },
    ])
      assert.equal(
        (yield* projection.answer(request!.id, answers).pipe(Effect.flip))._tag,
        "GrokBotBindingError",
      );
    assert.equal(projection.hasPending(), true);
    assert.equal(calls.length, 0);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("does not turn empty native option values into their visible labels", () =>
  Effect.gen(function* () {
    const { projection, calls } = yield* harness;
    const events = yield* projection.project(
      rowsFrame([
        {
          seq: "1",
          updatedSeq: "1",
          value: widgetCard("q1", {
            multiSelect: true,
            options: [
              { label: "Empty value", value: "" },
              { label: "Whitespace value", value: " \n " },
            ],
          }),
        },
      ]),
    );
    const [request] = pendingRequest(events);
    for (const answer of [[""], [" \n "], ["Empty value"], ["Whitespace value"]])
      assert.equal(
        (yield* projection.answer(request!.id, { q1: answer }).pipe(Effect.flip))._tag,
        "GrokBotBindingError",
      );
    assert.equal(calls.length, 0);
    assert.equal(projection.hasPending(), true);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("rejects malformed native permission envelopes without an inferred request id", () =>
  Effect.gen(function* () {
    const { projection, calls } = yield* harness;
    const malformed = [
      { ...localCard("local", "request"), kind: "message" },
      { ...localCard("local", "request", { requestId: undefined }), requestId: "managed-request" },
      localCard("local", "request", { action: 42 }),
      localCard("local", "request", { status: undefined }),
      connectorCard("connector", "request", { serverName: undefined }),
      {
        ...connectorCard("connector", "request", { requestId: undefined }),
        requestId: "managed-request",
      },
    ];
    assert.deepStrictEqual(
      yield* projection.project(
        rowsFrame(
          malformed.map((value, index) => ({
            seq: String(index + 1),
            updatedSeq: String(index + 1),
            value,
          })),
        ),
      ),
      [],
    );
    assert.equal(calls.length, 0);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("does not conflate the managed turn nonce with the native approval request", () =>
  Effect.gen(function* () {
    const turn = grokBotTurnIdentity(yield* makeTurn);
    const { projection, calls } = yield* makeHarness(
      providerSessionId,
      undefined,
      nativeSession.threadId,
      nativeSession.sessionId,
      (requestId) => (requestId === "managed-turn" ? turn : undefined),
    );
    const events = yield* projection.project(
      rowsFrame([
        {
          seq: "1",
          updatedSeq: "1",
          value: { ...card("entry", "native-approval"), requestId: "managed-turn" },
        },
      ]),
    );
    const node = events.find((e) => e.type === "node.updated");
    assert.equal(node?.type === "node.updated" ? node.node.runId : null, turn.runId);
    yield* projection.respond(pendingRequest(events)[0]!.id, "accept");
    expect(calls[0]?.input).toMatchObject({
      requestId: "native-approval",
      binding: nativeSession.binding,
      botId: nativeSession.botId,
      sessionId: nativeSession.sessionId,
    });
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("rejects a mismatched native row before mutating the projection", () =>
  Effect.gen(function* () {
    const { projection, calls } = yield* harness;
    const existing = rowsFrame([{ seq: "1", updatedSeq: "1", value: widgetCard("existing") }]);
    yield* projection.project(existing);
    const error = yield* projection
      .project(
        rowsFrame([
          { seq: "2", updatedSeq: "2", value: localCard("valid", "valid-request") },
          { seq: "3", updatedSeq: "3", entryId: "another-entry", value: widgetCard("mismatched") },
        ]),
      )
      .pipe(Effect.flip);
    assert.equal(error._tag, "GrokBotBindingError");
    assert.deepStrictEqual(
      pendingRequest(yield* projection.replayPending()).map((r) => r.status),
      ["pending"],
    );
    assert.deepStrictEqual(yield* projection.project(existing), []);
    assert.equal(calls.length, 0);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("does not resurrect a deleted card from a later stale or duplicate frame", () =>
  Effect.gen(function* () {
    const { projection } = yield* harness;
    yield* projection.project(rowsFrame([], [{ seq: "1", updatedSeq: "9", entryId: "deleted" }]));
    for (const updatedSeq of ["7", "9"])
      assert.deepStrictEqual(
        yield* projection.project(
          rowsFrame([{ seq: "1", updatedSeq, value: localCard("deleted", "request") }]),
        ),
        [],
      );
    assert.equal(projection.hasPending(), false);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("dispatches a pending permission once and preserves a deletion during the callback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const confirmed = yield* Deferred.make<void>();
      const { projection, calls } = yield* makeHarness(
        providerSessionId,
        undefined,
        nativeSession.threadId,
        nativeSession.sessionId,
        undefined,
        {},
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(confirmed))),
      );
      const [request] = pendingRequest(
        yield* projection.project(
          rowsFrame([{ seq: "1", updatedSeq: "1", value: localCard("entry", "request") }]),
        ),
      );
      const fiber = yield* projection.respond(request!.id, "accept").pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.equal(
        (yield* projection.respond(request!.id, "accept").pipe(Effect.flip))._tag,
        "GrokBotBindingError",
      );
      assert.equal(calls.length, 1);
      assert.deepStrictEqual(
        pendingRequest(
          yield* projection.project(
            rowsFrame([], [{ seq: "1", updatedSeq: "2", entryId: "entry" }]),
          ),
        ).map((r) => r.status),
        ["cancelled"],
      );
      yield* Deferred.succeed(confirmed, undefined);
      assert.deepStrictEqual(yield* Fiber.join(fiber), []);
      assert.equal(projection.hasPending(), false);
      assert.deepStrictEqual(yield* projection.respond(request!.id, "accept"), []);
      assert.equal(calls.length, 1);
    }),
  ).pipe(Effect.provide(IdAllocator.layer)),
);

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
