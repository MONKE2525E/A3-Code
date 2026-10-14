import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Native from "./GrokBotNativeService.ts";
import * as Computer from "./GrokBotComputerService.ts";
import * as Runtime from "./GrokBotNativeRuntimeService.ts";

it.effect("updates only a registered native computer and rereads its permission", () =>
  Effect.gen(function* () {
    const machines = [
      { machineId: "pc", label: "PC", localToolPermission: "never" },
      { machineId: "other", label: "Other", localToolPermission: "always" },
    ];
    const updates: unknown[] = [];
    const native = Layer.mock(Native.GrokBotNativeService)({
      accountBinding: Effect.succeed("account"),
      runtimeRequest: (_binding, method, body) =>
        Effect.sync(() => {
          if (method === "ListSandMachines") return { machines };
          updates.push({ method, body });
          if (method === "UpdateSandMachineLocalToolPermission")
            machines[0]!.localToolPermission = "ask";
          return {};
        }),
    });
    yield* Effect.gen(function* () {
      const service = yield* Computer.GrokBotComputerService;
      const result = yield* service.updateMachine({ machineId: "pc", permission: "ask" });
      assert.strictEqual(result.machines[0]!.permission, "ask");
      assert.strictEqual(result.machines[1]!.permission, "always");
      yield* service
        .updateMachine({ machineId: "missing", permission: "always" })
        .pipe(Effect.flip);
      assert.deepStrictEqual(updates, [
        {
          method: "UpdateSandMachineLocalToolPermission",
          body: { machineId: "pc", localToolPermission: "ask" },
        },
      ]);
    }).pipe(
      Effect.provide(
        Computer.layer.pipe(
          Layer.provide(
            Layer.mergeAll(native, Layer.mock(Runtime.GrokBotNativeRuntimeService)({})),
          ),
        ),
      ),
    );
  }),
);

it.effect("uses native bot identity and preserves save versus discard for teaching", () =>
  Effect.gen(function* () {
    const calls: {
      readonly binding: string;
      readonly input: Parameters<Native.GrokBotNativeService["Service"]["teachRecording"]>[1];
    }[] = [];
    const recording = {
      state: "recording" as const,
      agentId: "bot-1",
      startedAtMs: 123,
      maxDurationMs: 600000,
    };
    const native = Layer.mock(Native.GrokBotNativeService)({
      accountBinding: Effect.succeed("account-binding"),
      teachRecording: (binding, input) =>
        Effect.sync(() => {
          calls.push({ binding, input });
          return recording;
        }),
    });
    yield* Effect.gen(function* () {
      const service = yield* Computer.GrokBotComputerService;
      assert.deepStrictEqual(yield* service.readTeaching({ botId: "bot-1" }), recording);
      yield* service.startTeaching({ botId: "bot-1", entryPoint: "fullscreen_title_bar" });
      yield* service.stopTeaching({ botId: "bot-1", save: true });
      yield* service.stopTeaching({ botId: "bot-1", save: false });
    }).pipe(
      Effect.provide(
        Computer.layer.pipe(
          Layer.provide(
            Layer.mergeAll(native, Layer.mock(Runtime.GrokBotNativeRuntimeService)({})),
          ),
        ),
      ),
    );
    assert.deepStrictEqual(calls, [
      { binding: "account-binding", input: { method: "getTeachRecordingStatus", args: {} } },
      {
        binding: "account-binding",
        input: {
          method: "startTeachRecording",
          args: { agentId: "bot-1", entryPoint: "fullscreen_title_bar" },
        },
      },
      { binding: "account-binding", input: { method: "getTeachRecordingStatus", args: {} } },
      {
        binding: "account-binding",
        input: { method: "stopTeachRecording", args: { agentId: "bot-1", save: true } },
      },
      { binding: "account-binding", input: { method: "getTeachRecordingStatus", args: {} } },
      {
        binding: "account-binding",
        input: { method: "stopTeachRecording", args: { agentId: "bot-1", save: false } },
      },
    ]);
  }),
);

it.effect("does not dispatch teaching when the account binding is unavailable", () =>
  Effect.gen(function* () {
    let called = false;
    const native = Layer.mock(Native.GrokBotNativeService)({
      accountBinding: Effect.fail(new Native.NativeReadError({ stage: "session" })),
      teachRecording: () =>
        Effect.sync(() => {
          called = true;
          return {
            state: "idle" as const,
            agentId: null,
            startedAtMs: null,
            maxDurationMs: 600000,
          };
        }),
    });
    const error = yield* Effect.gen(function* () {
      const service = yield* Computer.GrokBotComputerService;
      return yield* service
        .startTeaching({ botId: "bot-1", entryPoint: "fullscreen_title_bar" })
        .pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        Computer.layer.pipe(
          Layer.provide(
            Layer.mergeAll(native, Layer.mock(Runtime.GrokBotNativeRuntimeService)({})),
          ),
        ),
      ),
    );
    assert.strictEqual(error.reason, "account_unavailable");
    assert.strictEqual(called, false);
  }),
);

it.effect("refuses to stop a different bot's active recording", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const native = Layer.mock(Native.GrokBotNativeService)({
      accountBinding: Effect.succeed("account-binding"),
      teachRecording: (_binding, input) =>
        Effect.sync(() => {
          calls.push(input.method);
          return {
            state: "recording" as const,
            agentId: "another-bot",
            startedAtMs: 123,
            maxDurationMs: 600000,
          };
        }),
    });
    yield* Effect.gen(function* () {
      const service = yield* Computer.GrokBotComputerService;
      yield* service.stopTeaching({ botId: "bot-1", save: false }).pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        Computer.layer.pipe(
          Layer.provide(
            Layer.mergeAll(native, Layer.mock(Runtime.GrokBotNativeRuntimeService)({})),
          ),
        ),
      ),
    );
    assert.deepStrictEqual(calls, ["getTeachRecordingStatus"]);
  }),
);

it.effect("resets the computer only with confirmation and a bound account", () => {
  const calls: unknown[] = [];
  const runtime = Layer.mock(Runtime.GrokBotNativeRuntimeService)({
    resetComputer: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return { started: true, operationId: "op-2" };
      }),
  });
  const run = <A, E>(
    binding: Effect.Effect<string, never>,
    body: Effect.Effect<A, E, Computer.GrokBotComputerService>,
  ) =>
    body.pipe(
      Effect.provide(
        Computer.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Native.GrokBotNativeService)({ accountBinding: binding }),
              runtime,
            ),
          ),
        ),
      ),
    );
  return Effect.gen(function* () {
    const refused = yield* run(
      Effect.succeed("account-binding"),
      Computer.GrokBotComputerService.pipe(
        Effect.flatMap((s) => s.reset({ confirm: false as never })),
        Effect.flip,
      ),
    );
    assert.strictEqual(refused.reason, "unavailable");
    assert.deepStrictEqual(calls, []);
    const unbound = yield* run(
      Effect.fail(new Native.NativeSignedOutError()) as never,
      Computer.GrokBotComputerService.pipe(
        Effect.flatMap((s) => s.reset({ confirm: true })),
        Effect.flip,
      ),
    );
    assert.strictEqual(unbound.reason, "account_unavailable");
    assert.deepStrictEqual(calls, []);
    const ok = yield* run(
      Effect.succeed("account-binding"),
      Computer.GrokBotComputerService.pipe(Effect.flatMap((s) => s.reset({ confirm: true }))),
    );
    assert.deepStrictEqual(ok, { started: true, operationId: "op-2" });
    assert.deepStrictEqual(calls, [{ binding: "account-binding" }]);
  });
});

it.effect("recreates the computer only with explicit confirmation", () => {
  const calls: unknown[] = [];
  const native = Layer.mock(Native.GrokBotNativeService)({
    accountBinding: Effect.succeed("account-binding"),
  });
  const runtime = Layer.mock(Runtime.GrokBotNativeRuntimeService)({
    recreateComputer: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return { started: true, operationId: "op-1" };
      }),
  });
  return Effect.gen(function* () {
    const service = yield* Computer.GrokBotComputerService;
    const refused = yield* service
      .recreate({ preserveData: false, confirm: false as never })
      .pipe(Effect.flip);
    assert.strictEqual(refused.reason, "unavailable");
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(yield* service.recreate({ preserveData: true, confirm: true }), {
      started: true,
      operationId: "op-1",
    });
    assert.deepStrictEqual(calls, [{ binding: "account-binding", preserveData: true }]);
  }).pipe(Effect.provide(Computer.layer.pipe(Layer.provide(Layer.mergeAll(native, runtime)))));
});
