import type { Cookie, Page } from "playwright-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MUSE_AUTH_PROFILE = "integration-muse-auth";
export const MUSE_AUTH_THREAD = "integration-auth:muse";

export class IntegrationBrowserError extends Schema.TaggedError<IntegrationBrowserError>()(
  "IntegrationBrowserError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The Muse sign-in browser is unavailable.";
  }
}

/** Human-only sign-in. Cookies stay in the environment's private browser profile. */
export class IntegrationBrowser extends Context.Service<
  IntegrationBrowser,
  {
    readonly openMuse: Effect.Effect<
      { readonly threadId: string; readonly tabId: string },
      IntegrationBrowserError
    >;
    readonly museCookies: Effect.Effect<readonly Cookie[], IntegrationBrowserError>;
    readonly museTransportPage: Effect.Effect<Page, IntegrationBrowserError>;
  }
>()("t3/preview/IntegrationBrowser") {}
