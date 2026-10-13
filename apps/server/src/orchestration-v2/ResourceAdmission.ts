import type { HostResourcesSnapshot, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const GiB = 1024 ** 3;

/** A coarse turn budget: provider-native shell commands cannot be individually scheduled. */
export function agentWorkCapacity(host: HostResourcesSnapshot) {
  if (
    host.totalMemoryBytes === 0 ||
    (host.cpuUtilization !== null && host.cpuUtilization >= 0.95)
  ) {
    return { concurrentTurns: 0, newStarts: 0 };
  }
  const reserve = Math.min(2 * GiB, host.totalMemoryBytes / 4);
  const perTurn = Math.min(2 * GiB, host.totalMemoryBytes / 4);
  const newStarts = Math.max(0, Math.floor((host.availableMemoryBytes - reserve) / perTurn));
  const cores = Math.max(1, Math.floor(host.cpuCount / 2));
  const memory = Math.max(1, Math.floor((host.totalMemoryBytes - reserve) / perTurn));
  return { concurrentTurns: Math.min(cores, memory), newStarts };
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
  let memoryBudget: { sampledAt: number; starts: Set<RunId> } | undefined;
  return {
    acquire: (input: { readonly runId: RunId; readonly threadId: ThreadId }) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const runs = yield* projections.getResourceAdmissionRuns;
          const byRun = new Map(runs.map((run) => [run.runId, run]));
          for (const [runId, threadId] of reservations) {
            const run = byRun.get(runId);
            if (
              run?.threadId !== threadId ||
              (run.status !== "starting" && !(run.status === "waiting" && run.resourceWait))
            ) {
              reservations.delete(runId);
            }
          }
          if (reservations.has(input.runId)) return true;
          const running = runs.filter((run) => run.status === "running");
          if (running.some((run) => run.runId === input.runId)) return true;
          // Waiting parents/approvals consume no admission slot, so delegated children can run.
          const sample = yield* host.read;
          const capacity = agentWorkCapacity(sample);
          if (memoryBudget?.sampledAt !== sample.sampledAt) {
            memoryBudget = { sampledAt: sample.sampledAt, starts: new Set(reservations.keys()) };
          }
          // Available memory already accounts for existing processes. Charge only
          // admissions since this sample, even after they publish running or exit.
          if (
            running.length + reservations.size >= capacity.concurrentTurns ||
            (!memoryBudget.starts.has(input.runId) &&
              memoryBudget.starts.size >= capacity.newStarts)
          )
            return false;
          reservations.set(input.runId, input.threadId);
          memoryBudget.starts.add(input.runId);
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
