import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  grokBotsVoiceConnected,
  grokBotsVoiceEnd,
  grokBotsVoiceRefresh,
  grokBotsVoiceStart,
  grokBotsVoiceTool,
} from "~/state/grokBotVoice";
import { useAtomCommand } from "~/state/use-atom-command";

import { openVoiceAudio } from "./grokBotVoiceAudio";
import { createGrokBotVoiceCall, type GrokBotVoiceCallState } from "./grokBotVoiceCall";
import { openBrowserVoiceSocket } from "./grokBotVoiceSocket";
import {
  GrokBotVoiceCallContext,
  type GrokBotVoiceCallTarget,
  type GrokBotVoiceCallValue,
  type PinnedGrokBotVoiceCall,
} from "./useGrokBotVoiceCall";

// Voice results carry secrets and transcripts-adjacent payloads; failures stay out of the console.
const VOICE_COMMAND_OPTIONS = {
  reportFailure: false,
  reportDefect: false,
} as const;

async function unwrap<A>(result: AtomCommandResult<A, unknown>): Promise<A> {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

/**
 * Owns the tab's single voice call in the app shell, so navigating between threads and settings
 * never ends it. The call stays pinned to the bot and environment it started with. Unmounting the
 * shell (sign-out or leaving the app) ends any live call.
 */
export function GrokBotVoiceCallProvider({ children }: { readonly children: ReactNode }) {
  const startCommand = useAtomCommand(grokBotsVoiceStart, VOICE_COMMAND_OPTIONS);
  const refreshCommand = useAtomCommand(grokBotsVoiceRefresh, VOICE_COMMAND_OPTIONS);
  const toolCommand = useAtomCommand(grokBotsVoiceTool, VOICE_COMMAND_OPTIONS);
  const connectedCommand = useAtomCommand(grokBotsVoiceConnected, VOICE_COMMAND_OPTIONS);
  const endCommand = useAtomCommand(grokBotsVoiceEnd, VOICE_COMMAND_OPTIONS);
  const [call, setCall] = useState<PinnedGrokBotVoiceCall | null>(null);
  // The controller's state is read synchronously, so a second start cannot slip in during the first.
  const controllerRef = useRef<ReturnType<typeof createGrokBotVoiceCall> | null>(null);

  const value = useMemo<GrokBotVoiceCallValue>(
    () => ({
      call,
      start: (target: GrokBotVoiceCallTarget) => {
        const live = controllerRef.current;
        if (live !== null && live.state.phase !== "idle") return;
        const { environmentId } = target;
        const controller = createGrokBotVoiceCall({
          botId: target.botId,
          ports: {
            startCall: async (botId) =>
              unwrap(await startCommand({ environmentId, input: { botId } })),
            refreshCredential: async (callId) =>
              unwrap(await refreshCommand({ environmentId, input: { callId } })),
            runTool: async (input) => unwrap(await toolCommand({ environmentId, input })),
            connectedCall: async (callId) =>
              unwrap(await connectedCommand({ environmentId, input: { callId } })),
            endCall: async (input) => unwrap(await endCommand({ environmentId, input })),
            openAudio: (onFrame) => openVoiceAudio({ onFrame }),
            openSocket: openBrowserVoiceSocket,
            subscribeEnvironmentRecovery: (onRecovery) => {
              const connectionAtom = environmentCatalog.stateAtom(environmentId);
              const connectedGeneration = () =>
                Option.getOrNull(
                  Option.flatMap(AsyncResult.value(appAtomRegistry.get(connectionAtom)), (state) =>
                    state.phase === "connected" ? Option.some(state.generation) : Option.none(),
                  ),
                );
              let previous = connectedGeneration();
              return appAtomRegistry.subscribe(connectionAtom, () => {
                const generation = connectedGeneration();
                const recovered = generation !== null && generation !== previous;
                previous = generation;
                if (recovered) onRecovery();
              });
            },
          },
          onState: (state: GrokBotVoiceCallState) => {
            if (controllerRef.current === controller) setCall({ ...target, state });
          },
        });
        controllerRef.current = controller;
        void controller.start();
      },
      hangUp: () => controllerRef.current?.hangUp(),
      setMuted: (muted: boolean) => controllerRef.current?.setMuted(muted),
    }),
    [call, endCommand, refreshCommand, startCommand, toolCommand],
  );

  // StrictMode runs this cleanup once before the real mount; `dispose` is safe to repeat.
  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    },
    [],
  );

  return (
    <GrokBotVoiceCallContext.Provider value={value}>{children}</GrokBotVoiceCallContext.Provider>
  );
}
