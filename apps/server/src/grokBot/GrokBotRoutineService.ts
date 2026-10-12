import {
  GrokBotRoutineError,
  GrokBotRoutine as GrokBotRoutineSchema,
  type GrokBotRoutineDeleteInput,
  type GrokBotRoutineDeleteResult,
  type GrokBotRoutineSetEnabledInput,
  type GrokBotRoutineSetEnabledResult,
  type GrokBotRoutinesListInput,
  type GrokBotRoutinesListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Native from "./GrokBotNativeService.ts";

type GrokBotRoutine = typeof GrokBotRoutineSchema.Type;

const Entry = Schema.Struct({ automationId: Schema.String, recordJson: Schema.String });
const Entries = Schema.Array(Entry);
const Roster = Schema.Struct({
  agents: Schema.optionalKey(Schema.Array(Schema.Struct({ agentId: Schema.String }))),
});
const Agent = Schema.Struct({ automations: Schema.optionalKey(Entries) });
const Group = Schema.Struct({
  agentId: Schema.String,
  automations: Schema.optionalKey(Entries),
  unavailable: Schema.optionalKey(Schema.Boolean),
  readIndividually: Schema.optionalKey(Schema.Boolean),
});
const Account = Schema.Struct({ agents: Schema.optionalKey(Schema.Array(Group)) });
// The native automation record carries more fields (prompt, trigger, runs, file path). Only the summary
// the native app itself validates and shows is read; the prompt never crosses into T3.
const Record = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  schedule: Schema.String,
  triggerDescription: Schema.String,
  isEnabled: Schema.Boolean,
  createdAt: Schema.Number,
  nextRunAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(Record));
const decodeRoster = Schema.decodeUnknownOption(Roster);
const decodeAgent = Schema.decodeUnknownOption(Agent);
const decodeAccount = Schema.decodeUnknownOption(Account);

/** Records that fail the native app's own shape check are skipped, as the native app does. */
export const parseRoutines = (
  botId: string,
  entries: readonly (typeof Entry.Type)[],
): readonly GrokBotRoutine[] =>
  entries
    .flatMap((entry) => {
      const record = Option.getOrUndefined(decodeRecord(entry.recordJson));
      if (record === undefined) return [];
      const { nextRunAt, ...rest } = record;
      return [
        {
          ...rest,
          // The API identity can differ from the record's historical id.
          id: entry.automationId,
          botId: botId as GrokBotRoutine["botId"],
          ...(typeof nextRunAt === "number" ? { nextRunAt } : {}),
        },
      ];
    })
    .toSorted(
      (a, b) =>
        (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY) ||
        a.createdAt - b.createdAt,
    );

export class GrokBotRoutineService extends Context.Service<
  GrokBotRoutineService,
  {
    readonly list: (
      input: typeof GrokBotRoutinesListInput.Type,
    ) => Effect.Effect<typeof GrokBotRoutinesListResult.Type, GrokBotRoutineError>;
    readonly setEnabled: (
      input: typeof GrokBotRoutineSetEnabledInput.Type,
    ) => Effect.Effect<typeof GrokBotRoutineSetEnabledResult.Type, GrokBotRoutineError>;
    readonly delete: (
      input: typeof GrokBotRoutineDeleteInput.Type,
    ) => Effect.Effect<typeof GrokBotRoutineDeleteResult.Type, GrokBotRoutineError>;
  }
>()("t3/grokBot/GrokBotRoutineService") {}

const make = Effect.gen(function* () {
  const native = yield* Native.GrokBotNativeService;
  const account = native.accountBinding.pipe(
    Effect.mapError(() => new GrokBotRoutineError({ reason: "provider_not_ready" })),
  );
  const request = (
    binding: string,
    method: Native.NativeRuntimeMethod,
    input: object,
  ): Effect.Effect<unknown, GrokBotRoutineError> =>
    native
      .runtimeRequest(binding, method, input)
      .pipe(Effect.mapError(() => new GrokBotRoutineError({ reason: "unavailable" })));
  // A native response that no longer matches the schema is reported as unavailable, never as empty.
  const decoded = <A>(value: Option.Option<A>) =>
    Option.isSome(value)
      ? Effect.succeed(value.value)
      : Effect.fail(new GrokBotRoutineError({ reason: "unavailable" }));
  const sameAccount = (binding: string) =>
    account.pipe(
      Effect.flatMap((current) =>
        current === binding
          ? Effect.void
          : Effect.fail(new GrokBotRoutineError({ reason: "account_changed" })),
      ),
    );
  const zone = (timeZone: string | undefined) => (timeZone === undefined ? {} : { timeZone });

  const readBot = (binding: string, botId: string, timeZone: string | undefined) =>
    request(binding, "ListGrokBotAgentAutomations", { agentId: botId, ...zone(timeZone) }).pipe(
      Effect.flatMap((value) => decoded(decodeAgent(value))),
      Effect.map((agent) => parseRoutines(botId, agent.automations ?? [])),
    );

  const list = Effect.fn("GrokBotRoutineService.list")(function* (
    input: typeof GrokBotRoutinesListInput.Type,
  ) {
    const binding = yield* account;
    const roster = yield* request(binding, "ListGrokBotAgents", {}).pipe(
      Effect.flatMap((value) => decoded(decodeRoster(value))),
    );
    const botIds = (roster.agents ?? []).map((agent) => agent.agentId);
    if (botIds.length === 0) return { routines: [], unavailableBotIds: [] };
    const groups = yield* request(binding, "ListGrokBotAccountAutomations", {
      agentIds: botIds,
      ...zone(input.timeZone),
    }).pipe(Effect.flatMap((value) => decoded(decodeAccount(value))));
    const routines: GrokBotRoutine[] = [];
    const unavailableBotIds: string[] = [];
    for (const botId of botIds) {
      const group = groups.agents?.find((candidate) => candidate.agentId === botId);
      if (group === undefined || group.unavailable === true) {
        unavailableBotIds.push(botId);
      } else if (group.readIndividually === true) {
        const individual = yield* readBot(binding, botId, input.timeZone).pipe(Effect.option);
        if (Option.isSome(individual)) routines.push(...individual.value);
        else unavailableBotIds.push(botId);
      } else {
        routines.push(...parseRoutines(botId, group.automations ?? []));
      }
    }
    yield* sameAccount(binding);
    return {
      routines,
      unavailableBotIds:
        unavailableBotIds as (typeof GrokBotRoutinesListResult.Type)["unavailableBotIds"][number][],
    };
  });

  const setEnabled = Effect.fn("GrokBotRoutineService.setEnabled")(function* (
    input: typeof GrokBotRoutineSetEnabledInput.Type,
  ) {
    const binding = yield* account;
    const current = yield* readBot(binding, input.botId, input.timeZone);
    if (!current.some((routine) => routine.id === input.routineId))
      return yield* new GrokBotRoutineError({ reason: "routine_not_found" });
    yield* sameAccount(binding);
    const response = yield* request(binding, "SetGrokBotAgentAutomationEnabled", {
      agentId: input.botId,
      automationId: input.routineId,
      isEnabled: input.isEnabled,
      ...zone(input.timeZone),
    }).pipe(Effect.flatMap((value) => decoded(decodeAgent(value))));
    yield* sameAccount(binding);
    const routines = parseRoutines(input.botId, response.automations ?? []);
    if (
      !routines.some(
        (routine) => routine.id === input.routineId && routine.isEnabled === input.isEnabled,
      )
    )
      return yield* new GrokBotRoutineError({ reason: "unavailable" });
    return { botId: input.botId, routines };
  });

  // Like setEnabled, a lost response is settled by re-reading the bot's routines. The delete is never retried.
  const remove = Effect.fn("GrokBotRoutineService.delete")(function* (
    input: typeof GrokBotRoutineDeleteInput.Type,
  ) {
    const binding = yield* account;
    const current = yield* readBot(binding, input.botId, input.timeZone);
    if (!current.some((routine) => routine.id === input.routineId))
      return yield* new GrokBotRoutineError({ reason: "routine_not_found" });
    yield* sameAccount(binding);
    yield* request(binding, "DeleteGrokBotAgentAutomation", {
      agentId: input.botId,
      automationId: input.routineId,
      ...zone(input.timeZone),
    }).pipe(Effect.ignore);
    const routines = yield* readBot(binding, input.botId, input.timeZone);
    if (routines.some((routine) => routine.id === input.routineId))
      return yield* new GrokBotRoutineError({ reason: "unavailable" });
    yield* sameAccount(binding);
    return { botId: input.botId, routines };
  });

  return GrokBotRoutineService.of({ list, setEnabled, delete: remove });
});

export const layer = Layer.effect(GrokBotRoutineService, make);
