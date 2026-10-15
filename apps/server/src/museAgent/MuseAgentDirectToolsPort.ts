import type { ProviderInstanceId, RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import * as NativeTools from "../mcp/direct/NativeAgentDirectTools.ts";
import type { MuseDirectToolSession } from "./MuseAgentDirectTools.ts";

/** Trusted metadata from the native host. These fields must never come from tool arguments. */
export interface MuseDirectToolInvocation {
  readonly accountBinding: string;
  readonly nativeSessionId: string;
  readonly connectionId: string;
  readonly commandId: string;
  readonly payload: unknown;
}

export interface MuseDirectToolTurnOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly remoteRun: { readonly runId: RunId; readonly attemptId: RunAttemptId };
  readonly accountBinding: string;
  readonly nativeSessionId: string;
  readonly connectionId?: string;
  readonly browserToolsAvailable: boolean;
  readonly capabilities: ReadonlySet<McpCapability>;
  /** Checks the captured account, native session and exact active attempt in host-owned state. */
  readonly isCurrent: Effect.Effect<boolean>;
  /** A host callback adapter registers definitions only. Registry credentials never reach it. */
  readonly register: (
    commands: Readonly<Record<string, NativeTools.DirectToolDefinition>>,
    invoke: (input: MuseDirectToolInvocation) => ReturnType<MuseDirectToolSession["invoke"]>,
  ) => Effect.Effect<
    {
      readonly accepted: number;
      /** Trusted connection identity from registration, if the host can provide it then. */
      readonly connectionId?: string;
      /** Remove native callbacks on turn terminal, stop, unload, or registration failure. */
      readonly close: Effect.Effect<void>;
    },
    NativeTools.NativeAgentDirectToolsError
  >;
}

export interface MuseDirectToolTurn {
  /** Denies new invocations and revokes host credentials without awaiting native cleanup. */
  readonly revoke: Effect.Effect<void>;
  /** Idempotently cancels dispatch, removes callbacks, and revokes the registry credential. */
  readonly close: Effect.Effect<void>;
}

type StartTurn = (
  options: MuseDirectToolTurnOptions,
) => Effect.Effect<MuseDirectToolTurn, NativeTools.NativeAgentDirectToolsError, Scope.Scope>;

/** Created before provider drivers; the checked catalog installs its implementation later. */
export class MuseAgentDirectToolsPort extends Context.Service<
  MuseAgentDirectToolsPort,
  {
    readonly start: StartTurn;
    readonly install: (
      start: StartTurn,
    ) => Effect.Effect<
      { readonly uninstall: Effect.Effect<void> },
      NativeTools.NativeAgentDirectToolsError
    >;
  }
>()("t3/museAgent/MuseAgentDirectToolsPort") {}

export const layer = Layer.sync(MuseAgentDirectToolsPort, () => {
  let implementation: MuseAgentDirectToolsPort["Service"]["start"] | undefined;
  let installed = false;
  return MuseAgentDirectToolsPort.of({
    start: (options) =>
      Effect.suspend(() =>
        implementation === undefined
          ? Effect.fail(new NativeTools.NativeAgentDirectToolsError({ code: "not_installed" }))
          : implementation(options),
      ),
    install: (start) =>
      Effect.gen(function* () {
        if (installed)
          return yield* new NativeTools.NativeAgentDirectToolsError({ code: "already_installed" });
        installed = true;
        implementation = start;
        return {
          uninstall: Effect.sync(() => {
            implementation = undefined;
          }),
        };
      }),
  });
});
