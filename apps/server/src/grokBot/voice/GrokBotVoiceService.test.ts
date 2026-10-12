import { assert, it } from "@effect/vitest";
import { GrokBotVoiceError } from "@t3tools/contracts/grokBotVoice";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Bridge from "../voiceRouting/GrokBotVoiceT3Bridge.ts";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Voice from "./GrokBotVoiceService.ts";

const session = {
  instructions: "be brief",
  tools: [],
  hasOverheard: false,
  greeting: { direction: "say hi", withLandedWork: "report" },
};
const line = {
  theyJustTalked: false,
  newsOwed: false,
  receiptOwed: false,
  alreadySpokeThisTurn: false,
};

const makeBackend = (websocketUrl: string, expiresIn = 600) =>
  Effect.gen(function* () {
    const binding = yield* Ref.make("account-1");
    const minted = yield* Ref.make({ websocketUrl, expiresIn });
    const toolCalls: { binding: string; botId: string; callId: string }[] = [];
    const presence: { botId: string; callId: string; onTheLine: boolean }[] = [];
    const records: { binding: string; record: Voice.VoiceCallRecord }[] = [];
    const failRecord = { value: false };
    // Holds a presence-true in flight so a test can end the call underneath it.
    const presenceDelay = { ms: 0 };
    let mints = 0;
    const layer = Layer.succeed(Voice.GrokBotVoiceBackend, {
      accountBinding: Ref.get(binding),
      mintCredential: () =>
        Effect.all([Clock.currentTimeMillis, Ref.get(minted)]).pipe(
          Effect.map(([now, next]) => ({
            clientSecret: `ephemeral-secret-${(mints += 1)}`,
            expiresAtUnixSeconds: Math.floor(now / 1000) + next.expiresIn,
            model: "grok-voice",
            websocketUrl: next.websocketUrl,
          })),
        ),
      openSession: () => Effect.succeed(session),
      callTool: (boundTo, input) =>
        Effect.sync(() => {
          toolCalls.push({ binding: boundTo, botId: input.botId, callId: input.callId });
          return { kind: "served" as const, output: { ok: true } };
        }),
      setPresence: (_binding, input) =>
        Effect.sleep(input.onTheLine ? presenceDelay.ms : 0).pipe(
          Effect.andThen(Effect.sync(() => void presence.push(input))),
        ),
      recordCall: (boundTo, record) =>
        failRecord.value
          ? Effect.fail(new GrokBotVoiceError({ reason: "unavailable" }))
          : Effect.sync(() => void records.push({ binding: boundTo, record })),
    });
    return { layer, toolCalls, presence, records, failRecord, presenceDelay, binding, minted };
  });
type Backend = Effect.Success<ReturnType<typeof makeBackend>>;
const routed: { botId: string; callId: string; name: string; access: string }[] = [];
const bridgeLayer = Layer.succeed(Bridge.GrokBotVoiceT3Bridge, {
  context: () => Effect.succeed(undefined),
  activate: () => Effect.void,
  forget: () => Effect.void,
  call: (input) =>
    Effect.sync(() => {
      routed.push({
        botId: input.botId,
        callId: input.callId,
        name: input.name,
        access: input.access,
      });
      return { kind: "served" as const, output: { spoken: "ok" } };
    }),
});
const serviceLayer = (backend: Backend) =>
  Voice.layer.pipe(Layer.provide(Layer.merge(backend.layer, bridgeLayer)));

const start = { botId: "bot-a" };
const url = "wss://api.x.ai/v1/realtime";
const request = { toolCallId: "t1", name: "stay_silent", input: {}, line };

it.effect("rejects delayed results after hang-up or an account switch", () =>
  Effect.gen(function* () {
    for (const change of ["hang-up", "account"] as const) {
      const backend = yield* makeBackend(url);
      const waiting = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const delayedBridge = Layer.succeed(Bridge.GrokBotVoiceT3Bridge, {
        context: () => Effect.succeed(undefined),
        activate: () => Effect.void,
        forget: () => Effect.void,
        call: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(waiting, undefined);
            yield* Deferred.await(completed);
            return {
              kind: "served",
              output: { updates: ["Completed work"] },
              completion: { requestToolCallId: "t1", pending: false },
            } as const;
          }),
      });
      yield* Effect.gen(function* () {
        const voice = yield* Voice.GrokBotVoiceService;
        const call = yield* voice.start(start);
        const result = yield* voice
          .tool(
            {
              ...request,
              callId: call.callId,
              name: Bridge.T3_TASK_PROGRESS,
              input: { requestToolCallId: "t1" },
            },
            "operate",
          )
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(waiting);
        if (change === "hang-up") {
          yield* voice.end({ callId: call.callId });
          yield* voice.start(start);
        } else yield* Ref.set(backend.binding, "account-2");
        yield* Deferred.succeed(completed, undefined);
        const error = yield* Fiber.join(result);
        assert.strictEqual(
          error.reason,
          change === "hang-up" ? "unknown_call" : "account_unavailable",
        );
      }).pipe(
        Effect.provide(Voice.layer.pipe(Layer.provide(Layer.merge(backend.layer, delayedBridge)))),
      );
    }
  }),
);

it.effect("rejects realtime endpoints outside the official wss origin", () =>
  Effect.gen(function* () {
    for (const bad of [
      "ws://api.x.ai/v1/realtime",
      "wss://api.x.ai.evil.test/v1/realtime",
      "wss://api.x.ai@evil.test/v1/realtime",
      "https://api.x.ai/v1/realtime",
    ]) {
      const backend = yield* makeBackend(bad);
      const error = yield* Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* Voice.GrokBotVoiceService).start(start);
        }).pipe(Effect.provide(serviceLayer(backend))),
      );
      assert.instanceOf(error, GrokBotVoiceError);
      assert.strictEqual(error.reason, "undialable_endpoint");
    }
  }),
);

it.effect("refuses a credential that is about to expire", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url, 1);
    const error = yield* Effect.flip(
      Effect.gen(function* () {
        return yield* (yield* Voice.GrokBotVoiceService).start(start);
      }).pipe(Effect.provide(serviceLayer(backend))),
    );
    assert.strictEqual(error.reason, "expired_credential");
  }),
);

it.effect("ties tool calls to the bot and account the call was opened for", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const first = yield* voice.start(start);
      const second = yield* voice.start({ botId: "bot-b" });
      assert.notStrictEqual(first.callId, second.callId);
      yield* voice.tool({ callId: first.callId, ...request }, "operate");
      yield* voice.tool({ callId: second.callId, ...request }, "operate");
      assert.deepStrictEqual(backend.toolCalls, [
        { binding: "account-1", botId: "bot-a", callId: first.callId },
        { binding: "account-1", botId: "bot-b", callId: second.callId },
      ]);
      assert.isTrue((yield* voice.end({ callId: first.callId })).ended);
      assert.isFalse((yield* voice.end({ callId: first.callId })).ended);
      const error = yield* Effect.flip(voice.tool({ callId: first.callId, ...request }, "operate"));
      assert.strictEqual(error.reason, "unknown_call");
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("stops serving a call once the selected account changes, and does not revive it", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      yield* Ref.set(backend.binding, "account-2");
      const tool = yield* Effect.flip(voice.tool({ callId: call.callId, ...request }, "operate"));
      assert.strictEqual(tool.reason, "account_unavailable");
      yield* Ref.set(backend.binding, "account-1");
      const back = yield* Effect.flip(voice.refresh(call.callId));
      assert.strictEqual(back.reason, "unknown_call");
      assert.deepStrictEqual(backend.toolCalls, []);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("refresh mints a new credential for the same call without adding a call", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      const refreshed = yield* voice.refresh(call.callId);
      assert.notStrictEqual(refreshed.clientSecret, call.credential.clientSecret);
      // Still the one call: ending it once leaves nothing behind.
      assert.isTrue((yield* voice.end({ callId: call.callId })).ended);
      assert.isFalse((yield* voice.end({ callId: call.callId })).ended);
      const error = yield* Effect.flip(voice.refresh(call.callId));
      assert.strictEqual(error.reason, "unknown_call");
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("refresh applies the same endpoint and expiry checks as start", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      yield* Ref.set(backend.minted, { websocketUrl: url, expiresIn: 1 });
      const expired = yield* Effect.flip(voice.refresh(call.callId));
      assert.strictEqual(expired.reason, "expired_credential");
      yield* Ref.set(backend.minted, { websocketUrl: "wss://api.x.ai.evil.test/", expiresIn: 600 });
      const bad = yield* Effect.flip(voice.refresh(call.callId));
      assert.strictEqual(bad.reason, "undialable_endpoint");
      // A failed refresh leaves the call usable for another attempt.
      yield* Ref.set(backend.minted, { websocketUrl: url, expiresIn: 600 });
      yield* voice.refresh(call.callId);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("enforces the maximum call age on tool and refresh, not only on start", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url, 3600 * 24);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const stale = yield* voice.start(start);
      yield* TestClock.adjust("5 hours");
      const tool = yield* Effect.flip(voice.tool({ callId: stale.callId, ...request }, "operate"));
      assert.strictEqual(tool.reason, "unknown_call");
      assert.isFalse((yield* voice.end({ callId: stale.callId })).ended);
      const other = yield* voice.start(start);
      yield* TestClock.adjust("5 hours");
      const refresh = yield* Effect.flip(voice.refresh(other.callId));
      assert.strictEqual(refresh.reason, "unknown_call");
      assert.deepStrictEqual(backend.toolCalls, []);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("drops calls that outlive the maximum age when a new call starts", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url, 3600 * 24);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const stale = yield* voice.start(start);
      yield* TestClock.adjust("5 hours");
      yield* voice.start(start);
      assert.isFalse((yield* voice.end({ callId: stale.callId })).ended);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

const hungUp = {
  ending: "hung-up" as const,
  realtimeConversationId: "conv-1",
  turns: [
    { id: "i1", speaker: "user" as const, text: "hello", atMs: 10 },
    { id: "i2", speaker: "assistant" as const, text: "hi there", atMs: 20 },
  ],
};

it.effect("records a connected call natively once, with its turns and served tool calls", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      assert.match(call.callId, /^call-/);
      // Presence waits for proof the realtime session connected: a tool call is that proof here.
      assert.deepStrictEqual(backend.presence, []);
      yield* voice.tool({ callId: call.callId, ...request, input: { q: 1 } }, "operate");
      yield* TestClock.adjust("3 seconds");
      // A remote close and an unmount cleanup racing the hang-up: only one finalizes.
      const results = yield* Effect.all(
        [
          voice.end({ callId: call.callId, ...hungUp }),
          voice.end({ callId: call.callId, ...hungUp }),
          voice.end({ callId: call.callId, ending: "disconnected" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(
        results.map((r) => [r.ended, r.recorded]),
        [
          [true, true],
          [false, false],
          [false, false],
        ],
      );
      assert.strictEqual(backend.records.length, 1);
      const { binding, record } = backend.records[0]!;
      assert.strictEqual(binding, "account-1");
      assert.strictEqual(record.callId, call.callId);
      assert.strictEqual(record.agentId, "bot-a");
      assert.strictEqual(record.model, "grok-voice");
      assert.strictEqual(record.realtimeConversationId, "conv-1");
      assert.strictEqual(record.ending, "hung-up");
      assert.strictEqual(record.durationMs, 3000);
      assert.strictEqual(record.endedAtMs - record.startedAtMs, 3000);
      assert.deepStrictEqual(record.turns, hungUp.turns);
      assert.deepStrictEqual([record.nudges, record.overheard], [[], []]);
      assert.strictEqual(record.harnessMayCollect, false);
      assert.strictEqual(record.toolCalls.length, 1);
      assert.strictEqual(record.toolCalls[0]?.id, "t1");
      assert.strictEqual(record.toolCalls[0]?.argumentsJson, '{"q":1}');
      assert.strictEqual(record.toolCalls[0]?.result?.json, '{"ok":true}');
      assert.deepStrictEqual(backend.presence.at(-1), {
        botId: "bot-a",
        callId: call.callId,
        onTheLine: false,
      });
      const late = yield* Effect.flip(voice.tool({ callId: call.callId, ...request }, "operate"));
      assert.strictEqual(late.reason, "unknown_call");
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

const onLine = (callId: string, onTheLine: boolean) => ({ botId: "bot-a", callId, onTheLine });

it.effect(
  "a connected call with no tool calls goes on the line once and is recorded from connect",
  () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend(url);
      yield* Effect.gen(function* () {
        const voice = yield* Voice.GrokBotVoiceService;
        const call = yield* voice.start(start);
        // Credential setup time must not count toward the call.
        yield* TestClock.adjust("10 seconds");
        assert.deepStrictEqual(backend.presence, []);
        const results = yield* Effect.all(
          [voice.connected(call.callId), voice.connected(call.callId)],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(results.map((r) => r.first).toSorted(), [false, true]);
        assert.deepStrictEqual(backend.presence, [onLine(call.callId, true)]);
        // A tool call after connect does not repeat presence.
        yield* voice.tool({ callId: call.callId, ...request }, "operate");
        yield* TestClock.adjust("2 seconds");
        yield* voice.end({ callId: call.callId, ...hungUp });
        assert.deepStrictEqual(backend.presence, [
          onLine(call.callId, true),
          onLine(call.callId, false),
        ]);
        const { record } = backend.records[0]!;
        assert.strictEqual(record.durationMs, 2000);
        assert.strictEqual(record.endedAtMs - record.startedAtMs, 2000);
      }).pipe(Effect.provide(serviceLayer(backend)));
    }),
);

it.effect("connected after end is unknown_call and never puts the bot on the line", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      yield* voice.end({ callId: call.callId });
      const late = yield* Effect.flip(voice.connected(call.callId));
      assert.strictEqual(late.reason, "unknown_call");
      assert.deepStrictEqual(backend.presence, []);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("an end racing an in-flight connected leaves the bot off the line", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    backend.presenceDelay.ms = 1000;
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      const connecting = yield* Effect.forkChild(voice.connected(call.callId));
      yield* Effect.yieldNow;
      yield* voice.end({ callId: call.callId, ...hungUp });
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(connecting);
      assert.strictEqual(backend.presence.at(-1)?.onTheLine, false);
      assert.strictEqual(backend.records.length, 1);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("a switched account fails connected without presence or a record", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      yield* Ref.set(backend.binding, "account-2");
      const failed = yield* Effect.flip(voice.connected(call.callId));
      assert.strictEqual(failed.reason, "account_unavailable");
      const ended = yield* voice.end({ callId: call.callId, ...hungUp });
      assert.deepStrictEqual(ended, { ended: false, recorded: false });
      assert.deepStrictEqual([backend.presence, backend.records], [[], []]);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("forgets a call that never connected without recording it", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      const ended = yield* voice.end({ callId: call.callId });
      assert.deepStrictEqual(ended, { ended: true, recorded: false });
      assert.deepStrictEqual(backend.records, []);
      assert.deepStrictEqual(backend.presence, []);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("swaps native execution for T3 tools and routes them locally, never to native", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    routed.length = 0;
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      const names = call.session.tools.map((tool) => tool.name);
      assert.includeMembers(names, [
        "t3_thread_launch",
        "t3_project_list",
        "delegate_task",
        "t3_thread_read",
      ]);
      assert.notInclude(names, "t3_run_task");
      assert.notInclude(names, "send_task");
      assert.include(call.session.instructions, "t3_run_task");
      for (const name of ["t3_run_task", "send_task"])
        yield* voice.tool({ callId: call.callId, ...request, name }, "operate");
      yield* voice.tool({ callId: call.callId, ...request }, "read");
      assert.deepStrictEqual(
        routed.map((r) => [r.name, r.botId, r.callId, r.access]),
        [
          ["t3_run_task", "bot-a", call.callId, "operate"],
          ["send_task", "bot-a", call.callId, "operate"],
        ],
      );
      // Only the conversation control tool reached native.
      assert.strictEqual(backend.toolCalls.length, 1);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect("refuses stale connector tools locally, in whichever environment the call lives", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    routed.length = 0;
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const call = yield* voice.start(start);
      for (const name of ["t3_thread_send", "t3-code__delegate_task", ""]) {
        const result = yield* voice.tool({ callId: call.callId, ...request, name }, "operate");
        assert.strictEqual(result.kind, "unknown_tool");
      }
      // Neither this environment's bridge nor native ever saw them.
      assert.deepStrictEqual(routed, []);
      assert.deepStrictEqual(backend.toolCalls, []);
    }).pipe(Effect.provide(serviceLayer(backend)));
  }),
);

it.effect(
  "does not record a call under a different account, and a failed record still ends it",
  () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend(url);
      yield* Effect.gen(function* () {
        const voice = yield* Voice.GrokBotVoiceService;
        const failed = yield* voice.start(start);
        backend.failRecord.value = true;
        assert.deepStrictEqual(yield* voice.end({ callId: failed.callId, ...hungUp }), {
          ended: true,
          recorded: false,
        });
        assert.isFalse((yield* voice.end({ callId: failed.callId, ...hungUp })).ended);
        backend.failRecord.value = false;
        const other = yield* voice.start(start);
        yield* Ref.set(backend.binding, "account-2");
        yield* voice.end({ callId: other.callId, ...hungUp });
        // The record is addressed to the account that opened the call; the backend rejects a mismatch.
        assert.strictEqual(backend.records.at(-1)?.binding, "account-1");
      }).pipe(Effect.provide(serviceLayer(backend)));
    }),
);

it.effect("releases call authority on hang-up, account change, expiry, and shutdown", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url, 3600 * 24);
    const activated: string[] = [];
    const forgotten: string[] = [];
    const lifecycleBridge = Layer.succeed(Bridge.GrokBotVoiceT3Bridge, {
      context: () => Effect.succeed(undefined),
      activate: ({ callId }) =>
        Effect.sync(() => {
          activated.push(callId);
        }),
      forget: (callId) =>
        Effect.sync(() => {
          forgotten.push(callId);
        }),
      call: () => Effect.succeed({ kind: "served", output: null }),
    });
    let shutdownCall = "";
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const hung = yield* voice.start(start);
      yield* voice.connected(hung.callId);
      yield* voice.connected(hung.callId);
      assert.deepStrictEqual(activated, [hung.callId]);
      yield* voice.end({ callId: hung.callId });
      const switched = yield* voice.start(start);
      yield* voice.connected(switched.callId);
      yield* Ref.set(backend.binding, "account-2");
      yield* voice.refresh(switched.callId).pipe(Effect.flip);
      const expired = yield* voice.start(start);
      yield* voice.connected(expired.callId);
      yield* TestClock.adjust("5 hours");
      shutdownCall = (yield* voice.start(start)).callId;
      yield* voice.connected(shutdownCall);
      assert.includeMembers(forgotten, [hung.callId, switched.callId, expired.callId]);
    }).pipe(
      Effect.provide(Voice.layer.pipe(Layer.provide(Layer.merge(backend.layer, lifecycleBridge)))),
      Effect.scoped,
    );
    assert.include(forgotten, shutdownCall);
  }),
);

it.effect("hang-up during parent acquisition releases late authority before serving a tool", () =>
  Effect.gen(function* () {
    const backend = yield* makeBackend(url);
    const acquiring = yield* Deferred.make<void>();
    const acquired = yield* Deferred.make<void>();
    const forgotten: string[] = [];
    let dispatched = false;
    const lifecycleBridge = Layer.succeed(Bridge.GrokBotVoiceT3Bridge, {
      context: () => Effect.succeed(undefined),
      activate: () =>
        Deferred.succeed(acquiring, undefined).pipe(Effect.andThen(Deferred.await(acquired))),
      forget: (id) =>
        Effect.sync(() => {
          forgotten.push(id);
        }),
      call: () =>
        Effect.sync(() => {
          dispatched = true;
          return { kind: "served", output: null } as const;
        }),
    });
    yield* Effect.gen(function* () {
      const voice = yield* Voice.GrokBotVoiceService;
      const current = yield* voice.start(start);
      const tool = yield* voice
        .tool(
          { callId: current.callId, ...request, name: "delegate_task", input: { task: "work" } },
          "operate",
        )
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(acquiring);
      yield* voice.end({ callId: current.callId });
      yield* Deferred.succeed(acquired, undefined);
      assert.strictEqual((yield* Fiber.join(tool)).reason, "unknown_call");
      assert.isFalse(dispatched);
      assert.include(forgotten, current.callId);
    }).pipe(
      Effect.provide(Voice.layer.pipe(Layer.provide(Layer.merge(backend.layer, lifecycleBridge)))),
    );
  }),
);
