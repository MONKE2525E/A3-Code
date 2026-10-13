/** A call keeps the environment and bot it was opened against through navigation. */
export interface VoiceCallTarget {
  readonly environmentId: string;
  readonly botId: string;
}

export interface VoiceCallController<State> {
  readonly state: State;
  start(): Promise<void> | void;
  hangUp(): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export interface VoiceCallEntry<Target, State> {
  readonly key: string;
  readonly target: Target;
  readonly state: State;
}

function voiceCallTargetKey(target: VoiceCallTarget): string {
  return JSON.stringify([target.environmentId, target.botId]);
}

/**
 * Owns independent controllers, one per environment/bot. The UI supplies audio and state
 * adapters and decides which calls receive microphone input. Starting another target never
 * replaces a live call. Ended entries remain available for their notices until dismissed.
 */
export function createVoiceCallCollection<Target extends VoiceCallTarget, State>(options: {
  readonly create: (target: Target, onState: (state: State) => void) => VoiceCallController<State>;
  readonly isActive: (state: State) => boolean;
  readonly onChange: (calls: readonly VoiceCallEntry<Target, State>[]) => void;
}) {
  const calls = new Map<string, { target: Target; controller: VoiceCallController<State> }>();
  const snapshot = () =>
    [...calls].map(([key, call]) => ({ key, target: call.target, state: call.controller.state }));
  const emit = () => options.onChange(snapshot());

  return {
    snapshot,
    start(target: Target) {
      const key = voiceCallTargetKey(target);
      const previous = calls.get(key);
      if (previous && options.isActive(previous.controller.state)) return key;
      if (previous) {
        calls.delete(key);
        previous.controller.dispose();
      }
      let controller: VoiceCallController<State> | undefined;
      controller = options.create(target, () => {
        if (controller !== undefined && calls.get(key)?.controller === controller) emit();
      });
      calls.set(key, { target, controller });
      emit();
      void controller.start();
      return key;
    },
    hangUp(key: string) {
      calls.get(key)?.controller.hangUp();
    },
    setMuted(key: string, muted: boolean) {
      calls.get(key)?.controller.setMuted(muted);
    },
    dismiss(key: string) {
      const call = calls.get(key);
      if (!call || options.isActive(call.controller.state)) return;
      calls.delete(key);
      call.controller.dispose();
      emit();
    },
    dispose() {
      const owned = [...calls.values()];
      calls.clear();
      for (const call of owned) call.controller.dispose();
      emit();
    },
  };
}
