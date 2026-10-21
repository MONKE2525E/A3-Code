import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import * as MuseAgentComputerPreviewHttp from "@t3tools/client-runtime/state/muse-agent-computer-preview";
import { EnvironmentHttpConnectionNotReadyError } from "@t3tools/client-runtime/state/pull-requests";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Latest authenticated still preview of one Muse computer task. `revision` (the preview's sha256)
 * only keys the cache so a new frame is a new entry; the loader itself takes IDs only. Short stale
 * time and idle TTL: previews are refreshed by the user, never polled.
 */
export const museAgentComputerPreviewQuery = createEnvironmentQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:muse-agent:computer-preview",
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    execute: (input: {
      readonly providerInstanceId: string;
      readonly sessionId: string;
      readonly taskId: string;
      readonly revision: string;
    }) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const loader = yield* MuseAgentComputerPreviewHttp.MuseAgentComputerPreviewLoader;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          return yield* new EnvironmentHttpConnectionNotReadyError({
            message: "The environment HTTP connection is not ready.",
          });
        }
        return yield* loader.load(prepared.value, {
          providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
          sessionId: input.sessionId,
          taskId: input.taskId,
        });
      }),
  },
);
