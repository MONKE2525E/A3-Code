import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createThreadPrefetchAtom } from "./threadPrefetch";

function harness() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const ids = Atom.make<ReadonlyArray<ThreadId>>([]).pipe(Atom.keepAlive);
  const states = Atom.family((_id: ThreadId) =>
    Atom.make<AsyncResult.AsyncResult<EnvironmentThreadState>>(
      AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE),
    ),
  );
  const prefetch = createThreadPrefetchAtom({ threadIdsAtom: ids, stateAtom: states, limit: 2 });
  const unmount = registry.mount(prefetch);
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const mounted = (id: ThreadId) => {
    flush();
    return registry.getNodes().has(states(id));
  };
  return { registry, ids, states, mounted, unmount };
}

describe("thread prefetch", () => {
  it("bounds detail streams and releases each on synchronization without reopening on shell refresh", () => {
    const h = harness();
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    const c = ThreadId.make("c");
    h.registry.set(h.ids, [a, b, c]);
    expect(h.mounted(a)).toBe(true);
    expect(h.mounted(b)).toBe(true);
    expect(h.mounted(c)).toBe(false);
    h.registry.set(
      h.states(a),
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "live" }),
    );
    expect(h.mounted(a)).toBe(false);
    expect(h.mounted(b)).toBe(true);
    expect(h.mounted(c)).toBe(true);
    h.registry.set(h.ids, [a, b, c]);
    expect(h.mounted(a)).toBe(false);
    h.registry.set(
      h.states(b),
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "live" }),
    );
    h.registry.set(
      h.states(c),
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "live" }),
    );
    expect(h.mounted(b)).toBe(false);
    expect(h.mounted(c)).toBe(false);
    h.unmount();
    expect(h.mounted(b)).toBe(false);
  });

  it("releases a removed candidate and fills its slot without retaining its stream", () => {
    const h = harness();
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    const c = ThreadId.make("c");
    h.registry.set(h.ids, [a, b, c]);
    expect(h.mounted(a)).toBe(true);
    expect(h.mounted(c)).toBe(false);
    h.registry.set(h.ids, [b, c]);
    expect(h.mounted(a)).toBe(false);
    expect(h.mounted(b)).toBe(true);
    expect(h.mounted(c)).toBe(true);
    h.unmount();
    expect(h.mounted(b)).toBe(false);
    expect(h.mounted(c)).toBe(false);
  });

  it("releases a failed detail and drops the previous environment's mounts on unmount", () => {
    const h = harness();
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    h.registry.set(h.ids, [a, b]);
    expect(h.mounted(a)).toBe(true);
    h.registry.set(
      h.states(a),
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, error: Option.some("offline") }),
    );
    expect(h.mounted(a)).toBe(false);
    h.unmount();
    expect(h.mounted(b)).toBe(false);
  });
});
