import * as Effect from "effect/Effect";

import PullRequestReviewGuides from "./061_PullRequestReviewGuides.ts";
import GrokBotManagedRuntime from "./062_GrokBotManagedRuntime.ts";
import GrokBotManagedCompletion from "./063_GrokBotManagedCompletion.ts";

// Local builds recorded GrokBot migrations at 61/62 before upstream added
// review guides at 61. The migrator skips by highest id, so replay these
// idempotent declarations at a new id without changing history or existing data.
export default Effect.gen(function* () {
  yield* PullRequestReviewGuides;
  yield* GrokBotManagedRuntime;
  yield* GrokBotManagedCompletion;
});
