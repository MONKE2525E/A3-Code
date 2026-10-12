import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

/** Warm pinned details with bounded concurrency, releasing each stream once synchronized. */
export function createThreadPrefetchAtom<E>(input: {
  readonly threadIdsAtom: Atom.Atom<ReadonlyArray<ThreadId>>;
  readonly stateAtom: (
    threadId: ThreadId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;
  readonly limit: number;
}) {
  const finished = new Set<ThreadId>();
  return Atom.make((get) => {
    const ids = get(input.threadIdsAtom);
    const pending = ids.filter((threadId) => !finished.has(threadId)).slice(0, input.limit);
    for (const threadId of pending) {
      const stateAtom = input.stateAtom(threadId);
      get.subscribe(stateAtom, (result) => {
        const done =
          AsyncResult.isFailure(result) ||
          (AsyncResult.isSuccess(result) &&
            (result.value.status === "live" ||
              result.value.status === "deleted" ||
              Option.isSome(result.value.error)));
        if (!done) return;
        finished.add(threadId);
        get.refreshSelf();
      });
      get.mount(stateAtom);
    }
    return ids;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel("web-thread-prefetch"));
}
