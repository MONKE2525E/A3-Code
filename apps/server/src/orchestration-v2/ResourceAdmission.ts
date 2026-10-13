import type { HostResourcesSnapshot, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const GiB = 1024 ** 3;

/** A coarse turn budget: provider-native shell commands cannot be individually scheduled. */
export function agentWorkCapacity(host: HostResourcesSnapshot): number {
  if (host.totalMemoryBytes === 0) return 0;
  if (host.cpuUtilization !== null && host.cpuUtilization >= 0.95) return 0;
  const reserve = Math.min(2 * GiB, host.totalMemoryBytes / 4);
  const perTurn = Math.min(2 * GiB, host.totalMemoryBytes / 4);
  const additional = Math.max(0, Math.floor((host.availableMemoryBytes - reserve) / perTurn));
  const cores = Math.max(1, Math.floor(host.cpuCount / 2));
  const memory = Math.max(1, Math.floor((host.totalMemoryBytes - reserve) / perTurn));
  // Count live work against current headroom too: a cached reading must not
  // grant another memory budget every time a new start publishes "running".
  return Math.min(cores, memory, additional);
}

export class ResourceAdmission extends Context.Reference<{
  readonly acquire: (input: {
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  readonly release: (runId: RunId) => Effect.Effect<void>;
}>("t3/orchestration-v2/ResourceAdmission", {
  defaultValue: () => ({ acquire: () => Effect.succeed(true), release: () => Effect.void }),
}) {}

const make = Effect.gen(function* () {
  const host = yield* HostResources.HostResources;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const mutex = yield* Semaphore.make(1);
  // Reservations cover the interval before the provider publishes running.
  // Persisted running turns are counted too, including after server restart.
  const reservations = new Map<RunId, ThreadId>();
  return {
    acquire: (input: { readonly runId: RunId; readonly threadId: ThreadId }) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const runs = yield* projections.getResourceAdmissionRuns;
          const byRun = new Map(runs.map((run) => [run.runId, run]));
          for (const [runId, threadId] of reservations) {
            const run = byRun.get(runId);
            if (run?.threadId !== threadId || run.status !== "starting") {
              reservations.delete(runId);
            }
          }
          if (reservations.has(input.runId)) return true;
          const running = runs.filter((run) => run.status === "running");
          if (running.some((run) => run.runId === input.runId)) return true;
          // Waiting parents/approvals consume no admission slot, so delegated children can run.
          const capacity = agentWorkCapacity(yield* host.read);
          if (running.length + reservations.size >= capacity) return false;
          reservations.set(input.runId, input.threadId);
          return true;
        }),
      ),
    release: (runId: RunId) =>
      mutex.withPermits(1)(
        Effect.sync(() => {
          reservations.delete(runId);
        }),
      ),
  };
});

export const layer = Layer.effect(ResourceAdmission, make);
