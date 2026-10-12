import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Opaque binding to the selected native account and team; never a credential. */
export const GrokBotProviderSettings = Schema.Struct({
  accountBinding: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type GrokBotProviderSettings = typeof GrokBotProviderSettings.Type;
