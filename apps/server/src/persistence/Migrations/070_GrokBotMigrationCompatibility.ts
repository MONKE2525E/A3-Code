import * as Effect from "effect/Effect";

import PullRequestReviewGuides from "./061_PullRequestReviewGuides.ts";
import GrokBotManagedRuntime from "./068_GrokBotManagedRuntime.ts";
import GrokBotManagedCompletion from "./069_GrokBotManagedCompletion.ts";

// Local builds recorded GrokBot migrations at 61/62 before upstream added
// review guides at 61. The migrator skips by highest id, so replay these
// idempotent declarations at a new id while retaining existing data.
export default Effect.gen(function* () {
  yield* PullRequestReviewGuides;
  yield* GrokBotManagedRuntime;
  yield* GrokBotManagedCompletion;
});
