import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { EnvironmentHttpConnectionNotReadyError } from "@t3tools/client-runtime/state/pull-requests";
import * as MuseAgentAvatarHttp from "@t3tools/client-runtime/state/muse-agent-avatar";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Avatar bytes keyed by environment, instance, variant, and content revision. A revision is
 * content-addressed, so the profile poll never refetches unchanged media; a new revision is a
 * new key. The idle TTL bounds how long unmounted avatars stay cached.
 */
export const museAgentAvatarQuery = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:muse-agent:avatar",
  staleTimeMs: 24 * 60 * 60_000,
  idleTtlMs: 5 * 60_000,
  execute: (input: {
    readonly providerInstanceId: string;
    readonly variant: string;
    readonly revision: string;
  }) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const loader = yield* MuseAgentAvatarHttp.MuseAgentAvatarLoader;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) {
        return yield* new EnvironmentHttpConnectionNotReadyError({
          message: "The environment HTTP connection is not ready.",
        });
      }
      return yield* loader.load(prepared.value, {
        providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
        variant: input.variant,
        revision: input.revision,
      });
    }),
});
