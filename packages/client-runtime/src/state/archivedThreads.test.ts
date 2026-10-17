import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";
import { v2Now, v2Project, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

it("excludes native backing shells from generic archived actions in every environment", () => {
  const environmentIds = [EnvironmentId.make("local"), EnvironmentId.make("remote")];
  const codingThread = { ...v2ThreadShell, archivedAt: v2Now };
  const snapshot: OrchestrationV2ArchivedShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 42,
    projects: [v2Project],
    threads: [
      codingThread,
      ...["muse-agent", "grok-bot"].map((source) => ({
        ...codingThread,
        id: ThreadId.make(`${source}:fixture`),
      })),
    ],
  };
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
    getSnapshotAtom: () => Atom.make(AsyncResult.success(snapshot)),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey(environmentIds)))).toEqual({
    snapshots: environmentIds.map((environmentId) => ({
      environmentId,
      snapshot: { ...snapshot, threads: [codingThread] },
    })),
    error: null,
    isLoading: false,
  });
  // Filtering a client list must not remove the backing shells from the source cache.
  expect(snapshot.threads).toHaveLength(3);
  registry.dispose();
});

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("keeps Muse conversations reachable for clients with paired restore", () => {
  const environmentId = EnvironmentId.make("mobile");
  const codingThread = { ...v2ThreadShell, archivedAt: v2Now };
  const museThread = { ...codingThread, id: ThreadId.make(`muse-agent:${"a".repeat(64)}:side`) };
  const snapshot: OrchestrationV2ArchivedShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 42,
    projects: [v2Project],
    threads: [codingThread, museThread, { ...codingThread, id: ThreadId.make("grok-bot:fixture") }],
  };
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
    getSnapshotAtom: () => Atom.make(AsyncResult.success(snapshot)),
    labelPrefix: "test:mobile-archived-threads",
    includeMuseConversations: true,
  });
  const registry = AtomRegistry.make();
  expect(
    registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId]))).snapshots,
  ).toEqual([{ environmentId, snapshot: { ...snapshot, threads: [codingThread, museThread] } }]);
  expect(snapshot.threads).toHaveLength(3);
  registry.dispose();
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});
