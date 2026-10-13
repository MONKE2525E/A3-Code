import {
  GrokBotComputerError,
  GrokBotHostMachines,
  GrokBotHostMachineUpdateInput,
  GrokBotLocalPermission,
  type GrokBotComputerRecreateInput,
  type GrokBotComputerRecreateResult,
  type GrokBotComputerResetInput,
  type GrokBotComputerResetResult,
  type GrokBotComputerUpgradeScheduleResult,
  type GrokBotTeachRecording,
  type GrokBotTeachStartInput,
  type GrokBotTeachStopInput,
  type GrokBotComputerInput,
  type GrokBotComputer,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Native from "./GrokBotNativeService.ts";
import * as Runtime from "./GrokBotNativeRuntimeService.ts";

export class GrokBotComputerService extends Context.Service<
  GrokBotComputerService,
  {
    readonly machines: () => Effect.Effect<typeof GrokBotHostMachines.Type, GrokBotComputerError>;
    readonly updateMachine: (
      input: typeof GrokBotHostMachineUpdateInput.Type,
    ) => Effect.Effect<typeof GrokBotHostMachines.Type, GrokBotComputerError>;
    readonly readTeaching: (
      input: typeof GrokBotComputerInput.Type,
    ) => Effect.Effect<typeof GrokBotTeachRecording.Type, GrokBotComputerError>;
    readonly startTeaching: (
      input: typeof GrokBotTeachStartInput.Type,
    ) => Effect.Effect<typeof GrokBotTeachRecording.Type, GrokBotComputerError>;
    readonly stopTeaching: (
      input: typeof GrokBotTeachStopInput.Type,
    ) => Effect.Effect<typeof GrokBotTeachRecording.Type, GrokBotComputerError>;
    readonly read: (
      input: typeof GrokBotComputerInput.Type,
    ) => Effect.Effect<typeof GrokBotComputer.Type, GrokBotComputerError>;
    readonly start: (
      input: typeof GrokBotComputerInput.Type,
    ) => Effect.Effect<typeof GrokBotComputer.Type, GrokBotComputerError>;
    /** Destructive and account-wide. The contract requires `confirm: true`, which is rechecked here. */
    readonly reset: (
      input: typeof GrokBotComputerResetInput.Type,
    ) => Effect.Effect<typeof GrokBotComputerResetResult.Type, GrokBotComputerError>;
    readonly recreate: (
      input: typeof GrokBotComputerRecreateInput.Type,
    ) => Effect.Effect<typeof GrokBotComputerRecreateResult.Type, GrokBotComputerError>;
    readonly upgradeSchedule: () => Effect.Effect<
      typeof GrokBotComputerUpgradeScheduleResult.Type,
      GrokBotComputerError
    >;
  }
>()("t3/grokBot/GrokBotComputerService") {}
const make = Effect.gen(function* () {
  const native = yield* Native.GrokBotNativeService;
  const runtime = yield* Runtime.GrokBotNativeRuntimeService;
  const decodeMachines = Schema.decodeUnknownEffect(
    Schema.Struct({
      machines: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            machineId: Schema.String,
            label: Schema.optionalKey(Schema.String),
            connected: Schema.optionalKey(Schema.Boolean),
            localToolPermission: Schema.optionalKey(GrokBotLocalPermission),
          }),
        ),
      ),
    }),
  );
  const readMachines = (binding: string) =>
    native.runtimeRequest(binding, "ListSandMachines", {}).pipe(
      Effect.flatMap(decodeMachines),
      Effect.map((value) => ({
        machines: (value.machines ?? []).map((machine) => ({
          machineId: machine.machineId,
          label: machine.label ?? "",
          connected: machine.connected ?? null,
          permission: machine.localToolPermission ?? ("ask" as const),
        })),
      })),
      Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })),
    );
  const accountBinding = native.accountBinding.pipe(
    Effect.mapError(() => new GrokBotComputerError({ reason: "account_unavailable" })),
  );
  const computer = Effect.fnUntraced(function* (
    input: typeof GrokBotComputerInput.Type,
    wake: boolean,
  ) {
    const binding = yield* native.accountBinding.pipe(
      Effect.mapError(() => new GrokBotComputerError({ reason: "account_unavailable" })),
    );
    return yield* native
      .computer(binding, input.botId, wake)
      .pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
  });
  const teach = Effect.fnUntraced(function* (input: Parameters<typeof native.teachRecording>[1]) {
    const binding = yield* native.accountBinding.pipe(
      Effect.mapError(() => new GrokBotComputerError({ reason: "account_unavailable" })),
    );
    return yield* native
      .teachRecording(binding, input)
      .pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
  });
  const stopTeaching = Effect.fnUntraced(function* (input: typeof GrokBotTeachStopInput.Type) {
    const binding = yield* native.accountBinding.pipe(
      Effect.mapError(() => new GrokBotComputerError({ reason: "account_unavailable" })),
    );
    const status = yield* native
      .teachRecording(binding, { method: "getTeachRecordingStatus", args: {} })
      .pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
    if (status.state === "idle") return status;
    if (status.agentId !== input.botId)
      return yield* new GrokBotComputerError({ reason: "unavailable" });
    return yield* native
      .teachRecording(binding, {
        method: "stopTeachRecording",
        args: { agentId: input.botId, save: input.save },
      })
      .pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
  });
  const recreate = Effect.fnUntraced(function* (input: typeof GrokBotComputerRecreateInput.Type) {
    // Callers that skip schema decoding still cannot recreate without explicit confirmation.
    if (input.confirm !== true) return yield* new GrokBotComputerError({ reason: "unavailable" });
    const binding = yield* accountBinding;
    return yield* runtime
      .recreateComputer({ binding, preserveData: input.preserveData })
      .pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
  });
  const reset = Effect.fnUntraced(function* (input: typeof GrokBotComputerResetInput.Type) {
    if (input.confirm !== true) return yield* new GrokBotComputerError({ reason: "unavailable" });
    const binding = yield* accountBinding;
    return yield* runtime
      .resetComputer({ binding })
      .pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
  });
  const upgradeSchedule = Effect.fnUntraced(function* () {
    const binding = yield* accountBinding;
    const schedule = yield* runtime
      .computerUpgradeSchedule(binding)
      .pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
    if (schedule === undefined) return { schedule: null };
    const { nextFireAtMs, state, ...rest } = schedule;
    const next = nextFireAtMs === undefined ? Number.NaN : Number(nextFireAtMs);
    return {
      schedule: {
        ...rest,
        ...(Number.isFinite(next) ? { nextFireAtMs: next } : {}),
        ...(state === undefined ? {} : { state: String(state) }),
      },
    };
  });
  return GrokBotComputerService.of({
    machines: () =>
      Effect.gen(function* () {
        const binding = yield* accountBinding;
        const result = yield* readMachines(binding);
        if ((yield* accountBinding) !== binding)
          return yield* new GrokBotComputerError({ reason: "account_unavailable" });
        return result;
      }),
    updateMachine: (input) =>
      Effect.gen(function* () {
        const binding = yield* accountBinding;
        const existing = yield* readMachines(binding);
        if (!existing.machines.some((machine) => machine.machineId === input.machineId))
          return yield* new GrokBotComputerError({ reason: "unavailable" });
        if (input.permission !== undefined)
          yield* native
            .runtimeRequest(binding, "UpdateSandMachineLocalToolPermission", {
              machineId: input.machineId,
              localToolPermission: input.permission,
            })
            .pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
        if (input.label !== undefined)
          yield* native
            .runtimeRequest(binding, "UpdateSandMachineLabel", {
              machineId: input.machineId,
              label: input.label,
            })
            .pipe(Effect.mapError(() => new GrokBotComputerError({ reason: "unavailable" })));
        const result = yield* readMachines(binding);
        if ((yield* accountBinding) !== binding)
          return yield* new GrokBotComputerError({ reason: "account_unavailable" });
        return result;
      }),
    recreate,
    reset,
    upgradeSchedule,
    readTeaching: () => teach({ method: "getTeachRecordingStatus", args: {} }),
    startTeaching: (input) =>
      teach({
        method: "startTeachRecording",
        args: { agentId: input.botId, entryPoint: input.entryPoint },
      }),
    stopTeaching,
    read: (input) => computer(input, false),
    start: (input) => computer(input, true),
  });
});
export const layer = Layer.effect(GrokBotComputerService, make);
