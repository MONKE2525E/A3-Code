import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { HostResourcesSnapshot, OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ResourceAdmission from "./ResourceAdmission.ts";

const GiB = 1024 ** 3;
const host: HostResourcesSnapshot = {
  sampledAt: 0,
  cpuUtilization: 0,
  cpuCount: 4,
  totalMemoryBytes: 16 * GiB,
  availableMemoryBytes: 8 * GiB,
};

describe("agent work capacity", () => {
  it("reserves CPU capacity and limits small-memory hosts", () => {
    expect(ResourceAdmission.agentWorkCapacity(host)).toBe(2);
    expect(
      ResourceAdmission.agentWorkCapacity({ ...host, cpuCount: 12, totalMemoryBytes: 8 * GiB }),
    ).toBe(3);
    expect(ResourceAdmission.agentWorkCapacity({ ...host, cpuCount: 1 })).toBe(1);
  });
  it("pauses admission before memory headroom is exhausted", () => {
    expect(ResourceAdmission.agentWorkCapacity({ ...host, availableMemoryBytes: 3 * GiB })).toBe(0);
    expect(
      ResourceAdmission.agentWorkCapacity({ ...host, cpuCount: 12, availableMemoryBytes: 4 * GiB }),
    ).toBe(1);
    expect(ResourceAdmission.agentWorkCapacity({ ...host, cpuUtilization: 0.99 })).toBe(0);
  });
});

it.effect.each(["memory", "sqlite"] as const)(
  "reserves concurrent starts, releases failed starts, and counts persisted running work in %s",
  (storage) =>
    Effect.gen(function* () {
      const resources = yield* Ref.make(host);
      yield* Effect.gen(function* () {
        const admission = yield* ResourceAdmission.ResourceAdmission;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const instanceId = ProviderInstanceId.make("codex");
        const put = (
          id: string,
          status: OrchestrationV2Run["status"],
          create = true,
          resourceWait = false,
        ) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make(id);
            const runId = RunId.make(`run:${id}`);
            if (create)
              yield* store.apply({
                id: EventId.make(`thread:${id}`),
                type: "thread.created",
                threadId,
                occurredAt: now,
                payload: {
                  id: threadId,
                  projectId: ProjectId.make("project"),
                  title: id,
                  providerInstanceId: instanceId,
                  modelSelection: { instanceId, model: "test" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: threadId,
                  },
                  forkedFrom: null,
                  createdBy: "user",
                  creationSource: "web",
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              });
            yield* store.apply({
              id: EventId.make(`run:${id}:${status}`),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection: { instanceId, model: "test" },
                providerThreadId: null,
                userMessageId: MessageId.make(`message:${id}`),
                rootNodeId: null,
                activeAttemptId: null,
                status,
                resourceWait,
                requestedAt: now,
                startedAt: status === "starting" ? null : now,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            });
            return { runId, threadId };
          });
        const a = yield* put("a", "starting");
        const b = yield* put("b", "starting");
        const c = yield* put("c", "starting");
        const results = yield* Effect.all(
          [admission.acquire(a), admission.acquire(b), admission.acquire(c)],
          { concurrency: "unbounded" },
        );
        expect(results).toEqual([true, true, false]);
        yield* put("b", "waiting", false, true);
        // Keep the reservation while an admitted resource-waiting run commits starting.
        expect(yield* admission.acquire(c)).toBe(false);
        yield* put("b", "starting", false);
        yield* admission.release(a.runId);
        expect(yield* admission.acquire(c)).toBe(true);
        yield* put("b", "running", false);
        yield* store.apply({
          id: EventId.make("archive:b"),
          type: "thread.archived",
          threadId: b.threadId,
          occurredAt: now,
          payload: { ...(yield* store.getThread(b.threadId))!, archivedAt: now },
        });
        expect(yield* admission.acquire(a)).toBe(false);
        yield* put("b", "waiting", false);
        expect(yield* admission.acquire(a)).toBe(true);
        yield* admission.release(a.runId);
        yield* Ref.set(resources, { ...host, availableMemoryBytes: GiB });
        expect(yield* admission.acquire(a)).toBe(false);
        yield* Ref.set(resources, host);
        expect(yield* admission.acquire(a)).toBe(true);
        const d = yield* put("d", "starting");
        yield* put("c", "completed", false);
        yield* Ref.set(resources, { ...host, availableMemoryBytes: 4 * GiB });
        expect(yield* admission.acquire(d)).toBe(false);
        yield* put("a", "running", false);
        // Publishing running must not grant another slot from the same host sample.
        expect(yield* admission.acquire(d)).toBe(false);
        yield* put("a", "completed", false);
        expect(yield* admission.acquire(d)).toBe(true);
      }).pipe(
        Effect.provide(
          ResourceAdmission.layer.pipe(
            Layer.provideMerge(
              Layer.merge(
                storage === "memory"
                  ? ProjectionStore.layerMemory
                  : ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
                Layer.succeed(HostResources.HostResources, { read: Ref.get(resources) }),
              ),
            ),
          ),
        ),
      );
    }),
);
