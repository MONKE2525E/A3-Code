import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Native from "./GrokBotNativeService.ts";
import * as Routines from "./GrokBotRoutineService.ts";

const record = (id: string, overrides: object = {}) =>
  JSON.stringify({
    id,
    name: `Routine ${id}`,
    prompt: "secret prompt",
    trigger: { kind: "schedule" },
    schedule: "Every day at 9:00",
    triggerDescription: "Schedule",
    isEnabled: true,
    createdAt: 10,
    filePath: "/x",
    runs: [],
    ...overrides,
  });

const isNativeReadError = Schema.is(Native.NativeReadError);

const fakeNative = (
  respond: (method: string, input: Record<string, unknown>) => unknown,
  binding = () => "account-1",
) =>
  Layer.succeed(Native.GrokBotNativeService, {
    accountBinding: Effect.sync(binding),
    runtimeRequest: (_binding: string, method: string, input: object) =>
      Effect.suspend(() => {
        const result = respond(method, input as Record<string, unknown>);
        return isNativeReadError(result) ? Effect.fail(result) : Effect.succeed(result);
      }),
  } as unknown as Native.GrokBotNativeService["Service"]);

const run = <A, E>(
  respond: (method: string, input: Record<string, unknown>) => unknown,
  effect: Effect.Effect<A, E, Routines.GrokBotRoutineService>,
  binding?: () => string,
) => effect.pipe(Effect.provide(Routines.layer.pipe(Layer.provide(fakeNative(respond, binding)))));

it.effect("parses valid records, drops invalid ones, and never exposes the prompt", () =>
  Effect.sync(() => {
    const routines = Routines.parseRoutines("bot-1", [
      { automationId: "a", recordJson: record("a", { nextRunAt: 50 }) },
      { automationId: "b", recordJson: "not json" },
      { automationId: "c", recordJson: record("c", { isEnabled: "yes" }) },
      { automationId: "d", recordJson: record("d", { nextRunAt: 20 }) },
    ]);
    assert.deepStrictEqual(
      routines.map((routine) => routine.id),
      ["d", "a"],
    );
    assert.isFalse("prompt" in routines[0]!);
  }),
);

it.effect("lists account routines and reads individually when the native app asks", () =>
  run(
    (method, input) => {
      if (method === "ListGrokBotAgents")
        return { agents: [{ agentId: "bot-1" }, { agentId: "bot-2" }, { agentId: "bot-3" }] };
      if (method === "ListGrokBotAccountAutomations")
        return {
          agents: [
            { agentId: "bot-1", automations: [{ automationId: "a", recordJson: record("a") }] },
            { agentId: "bot-2", readIndividually: true },
            { agentId: "bot-3", unavailable: true },
          ],
        };
      assert.strictEqual(method, "ListGrokBotAgentAutomations");
      assert.strictEqual(input.agentId, "bot-2");
      return { automations: [{ automationId: "z", recordJson: record("z") }] };
    },
    Effect.gen(function* () {
      const service = yield* Routines.GrokBotRoutineService;
      const result = yield* service.list({});
      assert.deepStrictEqual(
        result.routines.map((routine) => `${routine.botId}:${routine.id}`),
        ["bot-1:a", "bot-2:z"],
      );
      assert.deepStrictEqual(result.unavailableBotIds, ["bot-3"]);
    }),
  ),
);

it.effect("toggles only an existing routine and rejects an unknown one", () => {
  const calls: string[] = [];
  return run(
    (method, input) => {
      calls.push(method);
      if (method === "ListGrokBotAgentAutomations")
        return { automations: [{ automationId: "a", recordJson: record("historical-id") }] };
      assert.strictEqual(input.isEnabled, false);
      assert.strictEqual(input.automationId, "a");
      return {
        automations: [{ automationId: "a", recordJson: record("a", { isEnabled: false }) }],
      };
    },
    Effect.gen(function* () {
      const service = yield* Routines.GrokBotRoutineService;
      const result = yield* service.setEnabled({
        botId: "bot-1" as never,
        routineId: "a",
        isEnabled: false,
      });
      assert.isFalse(result.routines[0]?.isEnabled);
      const missing = yield* service
        .setEnabled({ botId: "bot-1" as never, routineId: "nope", isEnabled: true })
        .pipe(Effect.flip);
      assert.strictEqual(missing.reason, "routine_not_found");
      assert.strictEqual(calls.filter((call) => call.startsWith("Set")).length, 1);
    }),
  );
});

it.effect("fails with a bounded error when the account changes mid-request", () => {
  let reads = 0;
  return run(
    (method) => {
      if (method === "ListGrokBotAgents") return { agents: [{ agentId: "bot-1" }] };
      return { agents: [{ agentId: "bot-1", automations: [] }] };
    },
    Effect.gen(function* () {
      const service = yield* Routines.GrokBotRoutineService;
      const error = yield* service.list({}).pipe(Effect.flip);
      assert.strictEqual(error.reason, "account_changed");
    }),
    () => (reads++ === 0 ? "account-1" : "account-2"),
  );
});

it.effect("does not report success when native enablement is unchanged", () =>
  run(
    () => ({ automations: [{ automationId: "a", recordJson: record("a") }] }),
    Effect.gen(function* () {
      const service = yield* Routines.GrokBotRoutineService;
      const error = yield* service
        .setEnabled({
          botId: "bot-1" as never,
          routineId: "a",
          isEnabled: false,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "unavailable");
    }),
  ),
);

it.effect("deletes one routine and returns the account's remaining routines", () => {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  let present = ["a", "b"];
  return run(
    (method, input) => {
      calls.push({ method, input });
      if (method === "DeleteGrokBotAgentAutomation") {
        present = present.filter((id) => id !== input.automationId);
        return {};
      }
      return {
        automations: present.map((id) => ({ automationId: id, recordJson: record(id) })),
      };
    },
    Effect.gen(function* () {
      const service = yield* Routines.GrokBotRoutineService;
      const result = yield* service.delete({ botId: "bot-1" as never, routineId: "a" });
      assert.deepStrictEqual(
        result.routines.map((routine) => routine.id),
        ["b"],
      );
      assert.deepStrictEqual(
        calls.filter((call) => call.method === "DeleteGrokBotAgentAutomation"),
        [
          {
            method: "DeleteGrokBotAgentAutomation",
            input: { agentId: "bot-1", automationId: "a" },
          },
        ],
      );
    }),
  );
});

it.effect(
  "does not retry a lost routine delete and reports it unavailable while it remains",
  () => {
    const deletes: string[] = [];
    return run(
      (method) => {
        if (method === "DeleteGrokBotAgentAutomation") {
          deletes.push(method);
          return new Native.NativeReadError({ stage: "request" });
        }
        return { automations: [{ automationId: "a", recordJson: record("a") }] };
      },
      Effect.gen(function* () {
        const service = yield* Routines.GrokBotRoutineService;
        const error = yield* service
          .delete({ botId: "bot-1" as never, routineId: "a" })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "unavailable");
        assert.strictEqual(deletes.length, 1);
      }),
    );
  },
);

it.effect("rejects deleting an unknown routine without sending a delete", () => {
  const methods: string[] = [];
  return run(
    (method) => {
      methods.push(method);
      return { automations: [] };
    },
    Effect.gen(function* () {
      const service = yield* Routines.GrokBotRoutineService;
      const error = yield* service
        .delete({ botId: "bot-1" as never, routineId: "nope" })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "routine_not_found");
      assert.isFalse(methods.includes("DeleteGrokBotAgentAutomation"));
    }),
  );
});
