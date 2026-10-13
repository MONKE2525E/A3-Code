import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Native from "../GrokBotNativeService.ts";
import * as BackendLive from "./GrokBotVoiceBackendLive.ts";
import { GrokBotVoiceBackend } from "./GrokBotVoiceService.ts";

const line = {
  theyJustTalked: true,
  newsOwed: false,
  receiptOwed: false,
  alreadySpokeThisTurn: false,
};

const makeNative = (responses: Record<string, unknown>) => {
  const sent: { binding: string; method: string; input: unknown }[] = [];
  const layer = Layer.mock(Native.GrokBotNativeService)({
    accountBinding: Effect.succeed("binding-1"),
    runtimeRequest: (binding, method, input) =>
      Effect.sync(() => sent.push({ binding, method, input })).pipe(
        Effect.flatMap(() => {
          if (binding !== "binding-1")
            return Effect.fail(new Native.NativeReadError({ stage: "session" }));
          return Effect.succeed(responses[method]);
        }),
      ),
  });
  return { sent, layer: BackendLive.layer.pipe(Layer.provide(layer)) };
};

const roster = { agents: [{ agentId: "bot-a", name: "Native Name" }] };

it.effect("speaks as the roster's native name and never the caller's", () =>
  Effect.gen(function* () {
    const native = makeNative({
      ListGrokBotAgents: roster,
      VoiceCallHarnessSession: {
        instructions: "be brief",
        tools: [{ type: "function", name: "send_task", description: "d", parameters: { a: 1 } }],
        hasOverheard: true,
        greeting: { direction: "hi", withLandedWork: "report" },
        receipt: { output: { receipt: "under way" }, instructions: "say receipt" },
      },
    });
    const session = yield* Effect.gen(function* () {
      const backend = yield* GrokBotVoiceBackend;
      return yield* backend.openSession("binding-1", { botId: "bot-a", userName: "me" });
    }).pipe(Effect.provide(native.layer));
    assert.deepStrictEqual(native.sent.at(-1), {
      binding: "binding-1",
      method: "VoiceCallHarnessSession",
      input: { agentId: "bot-a", agentName: "Native Name", userName: "me" },
    });
    assert.deepStrictEqual(session.receipt, { output: "under way", instructions: "say receipt" });
    assert.isTrue(session.hasOverheard);
    assert.strictEqual(session.tools[0]?.name, "send_task");
  }),
);

it.effect("refuses a bot that is not on this account's roster without opening a session", () =>
  Effect.gen(function* () {
    const native = makeNative({ ListGrokBotAgents: roster });
    const error = yield* Effect.flip(
      Effect.gen(function* () {
        return yield* (yield* GrokBotVoiceBackend).openSession("binding-1", { botId: "bot-z" });
      }).pipe(Effect.provide(native.layer)),
    );
    assert.strictEqual(error.reason, "refused");
    assert.deepStrictEqual(
      native.sent.map((request) => request.method),
      ["ListGrokBotAgents"],
    );
  }),
);

it.effect("maps a changed account binding to account_unavailable", () =>
  Effect.gen(function* () {
    const native = makeNative({});
    const error = yield* Effect.flip(
      Effect.gen(function* () {
        return yield* (yield* GrokBotVoiceBackend).mintCredential("binding-2");
      }).pipe(Effect.provide(native.layer)),
    );
    assert.strictEqual(error.reason, "account_unavailable");
  }),
);

it.effect("decodes the minted credential, including an int64 expiry sent as a string", () =>
  Effect.gen(function* () {
    const native = makeNative({
      MintSandVoiceCallSecret: {
        clientSecret: "s",
        expiresAtUnixSeconds: "1900000000",
        model: "m",
        websocketUrl: "wss://api.x.ai/v1/realtime",
      },
    });
    const credential = yield* Effect.gen(function* () {
      return yield* (yield* GrokBotVoiceBackend).mintCredential("binding-1");
    }).pipe(Effect.provide(native.layer));
    assert.strictEqual(credential.expiresAtUnixSeconds, 1900000000);
    assert.deepStrictEqual(native.sent[0]?.input, {});
  }),
);

it.effect(
  "maps tool outcomes and sends the call's id (not the realtime tool call id) with the bot's id",
  () =>
    Effect.gen(function* () {
      const native = makeNative({
        VoiceCallHarnessTool: {
          kind: "VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_INVALID_INPUT",
          output: { error: "bad" },
        },
      });
      const result = yield* Effect.gen(function* () {
        return yield* (yield* GrokBotVoiceBackend).callTool("binding-1", {
          botId: "bot-a",
          callId: "call-1",
          name: "send_task",
          input: { x: 1 },
          line,
        });
      }).pipe(Effect.provide(native.layer));
      assert.deepStrictEqual(result, { kind: "invalid_input", output: { error: "bad" } });
      assert.deepStrictEqual(native.sent[0]?.input, {
        agentId: "bot-a",
        callId: "call-1",
        name: "send_task",
        input: { x: 1 },
        line,
      });
    }),
);

it.effect("treats an unspecified tool outcome as unavailable", () =>
  Effect.gen(function* () {
    const native = makeNative({
      VoiceCallHarnessTool: { kind: "VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_UNSPECIFIED" },
    });
    const error = yield* Effect.flip(
      Effect.gen(function* () {
        return yield* (yield* GrokBotVoiceBackend).callTool("binding-1", {
          botId: "bot-a",
          callId: "c",
          name: "n",
          input: null,
          line,
        });
      }).pipe(Effect.provide(native.layer)),
    );
    assert.strictEqual(error.reason, "unavailable");
  }),
);

it.effect("sends presence and the call record to the gateway under the call's binding", () =>
  Effect.gen(function* () {
    const sent: { binding: string; method: string; args: unknown }[] = [];
    const layer = BackendLive.layer.pipe(
      Layer.provide(
        Layer.mock(Native.GrokBotNativeService)({
          accountBinding: Effect.succeed("binding-1"),
          voiceGateway: (binding, input) =>
            Effect.sync(() => void sent.push({ binding, ...input })).pipe(
              Effect.flatMap(() =>
                binding === "binding-1"
                  ? Effect.void
                  : Effect.fail(new Native.NativeReadError({ stage: "session" })),
              ),
            ),
        }),
      ),
    );
    const record = {
      callId: "call-1",
      agentId: "bot-a",
      model: "grok-voice",
      startedAtMs: 1,
      endedAtMs: 5,
      durationMs: 4,
      ending: "hung-up" as const,
      turns: [{ id: "t1", speaker: "user" as const, text: "hi", atMs: 2 }],
      nudges: [] as const,
      toolCalls: [],
      overheard: [] as const,
      harnessMayCollect: false as const,
    };
    const error = yield* Effect.gen(function* () {
      const backend = yield* GrokBotVoiceBackend;
      yield* backend.setPresence("binding-1", {
        botId: "bot-a",
        callId: "call-1",
        onTheLine: true,
      });
      yield* backend.recordCall("binding-1", record);
      return yield* Effect.flip(backend.recordCall("binding-2", record));
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(sent[0], {
      binding: "binding-1",
      method: "setVoiceCallPresence",
      args: { id: "bot-a", callId: "call-1", isOnTheLine: true },
    });
    assert.deepStrictEqual(sent[1], {
      binding: "binding-1",
      method: "recordVoiceCall",
      args: { record },
    });
    assert.strictEqual(error.reason, "account_unavailable");
  }),
);

it.effect("refuses native group agents before opening an unsupported multi-speaker session", () =>
  Effect.gen(function* () {
    const native = makeNative({
      ListGrokBotAgents: {
        agents: [{ agentId: "group", name: "Team", memberAgentIds: ["bot-a", "bot-b"] }],
      },
    });
    const error = yield* Effect.flip(
      Effect.gen(function* () {
        return yield* (yield* GrokBotVoiceBackend).openSession("binding-1", { botId: "group" });
      }).pipe(Effect.provide(native.layer)),
    );
    assert.strictEqual(error.reason, "refused");
    assert.deepStrictEqual(
      native.sent.map((request) => request.method),
      ["ListGrokBotAgents"],
    );
  }),
);
