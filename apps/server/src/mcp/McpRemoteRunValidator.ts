import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

/** Checks remote ownership again at each request, including native account changes. */
export class McpRemoteRunValidator extends Context.Service<
  McpRemoteRunValidator,
  {
    readonly validate: (scope: McpThreadInvocationScope) => Effect.Effect<boolean>;
  }
>()("t3/mcp/McpRemoteRunValidator") {}
