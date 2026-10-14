import { describe, expect, it } from "vite-plus/test";
import { createVoiceCallCollection, type VoiceCallTarget } from "./callCollection.ts";

function fixture() {
  const controllers: Array<ReturnType<typeof create>> = [];
  const changes: unknown[] = [];
  function create(
    _target: VoiceCallTarget,
    onState: (state: { active: boolean; muted: boolean }) => void,
  ) {
    let state = { active: false, muted: false };
    let disposed = 0;
    const update = (next: typeof state) => {
      state = next;
      onState(state);
    };
    const controller = {
      get state() {
        return state;
      },
      get disposed() {
        return disposed;
      },
      start: () => update({ active: true, muted: false }),
      hangUp: () => update({ ...state, active: false }),
      setMuted: (muted: boolean) => update({ ...state, muted }),
      dispose: () => {
        disposed++;
        update({ ...state, active: false });
      },
      update,
    };
    return controller;
  }
  const collection = createVoiceCallCollection<VoiceCallTarget, ReturnType<typeof create>["state"]>(
    {
      create: (target, onState) => {
        const controller = create(target, onState);
        controllers.push(controller);
        return controller;
      },
      isActive: (state) => state.active,
      onChange: (calls) => changes.push(calls),
    },
  );
  return { collection, controllers, changes };
}

describe("independent bot calls", () => {
  it("keeps calls isolated across bots and environments and deduplicates a live target", () => {
    const { collection, controllers } = fixture();
    const first = collection.start({ environmentId: "one", botId: "a" });
    const second = collection.start({ environmentId: "one", botId: "b" });
    collection.start({ environmentId: "two", botId: "a" });
    expect(collection.start({ environmentId: "one", botId: "a" })).toBe(first);
    expect(controllers).toHaveLength(3);
    collection.setMuted(first, true);
    collection.hangUp(second);
    expect(collection.snapshot().map((call) => call.state)).toEqual([
      { active: true, muted: true },
      { active: false, muted: false },
      { active: true, muted: false },
    ]);
    collection.dismiss(first);
    expect(collection.snapshot()).toHaveLength(3);
    collection.dismiss(second);
    expect(collection.snapshot()).toHaveLength(2);
    expect(controllers[1]!.disposed).toBe(1);
  });

  it("ignores old controller callbacks after redial and disposes every owned call", () => {
    const { collection, controllers, changes } = fixture();
    const target = { environmentId: "one", botId: "a" };
    collection.start(target);
    controllers[0]!.hangUp();
    collection.start(target);
    const before = changes.length;
    controllers[0]!.update({ active: true, muted: true });
    expect(changes).toHaveLength(before);
    expect(collection.snapshot()[0]!.state).toEqual({ active: true, muted: false });
    collection.start({ environmentId: "one", botId: "b" });
    collection.dispose();
    collection.dispose();
    expect(collection.snapshot()).toEqual([]);
    expect(controllers.map((controller) => controller.disposed)).toEqual([1, 1, 1]);
  });
});
