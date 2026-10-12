import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Observed official gateway SandTurnSettlement. A nonce is required; idle state is never a settlement.
export const Settlement = Schema.Struct({
  clientNonce: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  outcome: Schema.Literals(["success", "error", "cancelled"]),
  settledAtMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  errorCode: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  errorDomain: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  errorRetryable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  botBlock: Schema.optionalKey(
    Schema.Struct({
      confidence: Schema.Literals(["high", "low"]),
      family: Schema.String.check(Schema.isMaxLength(128)),
    }),
  ),
});
const Agent = Schema.Struct({
  id: Schema.String,
  lastTurnSettlement: Schema.optionalKey(Schema.NullOr(Settlement)),
});
const Roster = Schema.Array(Agent);
const AgentsEvent = Schema.Struct({ agents: Roster });
const UpsertEvent = Schema.Struct({ agent: Agent });
export class SettlementDecodeError extends Schema.TaggedError<SettlementDecodeError>()(
  "GrokBotSettlementDecodeError",
  {},
) {}
const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => new SettlementDecodeError({})),
  );
export const fromRoster = (botId: string, input: unknown) =>
  decode(Roster, input).pipe(
    Effect.map((agents) =>
      agents.flatMap((agent) =>
        agent.id === botId && agent.lastTurnSettlement != null ? [agent.lastTurnSettlement] : [],
      ),
    ),
  );
export const fromEvent = (
  botId: string,
  event: { readonly channel: string; readonly payload: unknown },
) => {
  if (event.channel === "agents")
    return decode(AgentsEvent, event.payload).pipe(
      Effect.flatMap((payload) => fromRoster(botId, payload.agents)),
    );
  if (event.channel === "agent-upserted")
    return decode(UpsertEvent, event.payload).pipe(
      Effect.flatMap((payload) => fromRoster(botId, [payload.agent])),
    );
  return Effect.succeed([]);
};
