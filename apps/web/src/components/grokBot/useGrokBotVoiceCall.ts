import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import type { GrokBotVoiceCallState } from "./grokBotVoiceCall";

/** The bot and environment a call was started against. A live call keeps this for its whole life. */
export interface GrokBotVoiceCallTarget {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly botName: string;
}

export interface PinnedGrokBotVoiceCall extends GrokBotVoiceCallTarget {
  readonly state: GrokBotVoiceCallState;
}

export interface GrokBotVoiceCallValue {
  /** The most recent call in this tab, kept after it ends so its notice can still show. */
  readonly call: PinnedGrokBotVoiceCall | null;
  /** Starts a call unless one is already live; a live call is never replaced. */
  readonly start: (target: GrokBotVoiceCallTarget) => void;
  readonly hangUp: () => void;
  readonly setMuted: (muted: boolean) => void;
}

export const GrokBotVoiceCallContext = createContext<GrokBotVoiceCallValue | null>(null);

/** Reads the tab's single voice call. The provider lives in the app shell, so it survives navigation. */
export function useGrokBotVoiceCall(): GrokBotVoiceCallValue {
  const value = useContext(GrokBotVoiceCallContext);
  if (value === null) {
    throw new Error("useGrokBotVoiceCall must be used inside GrokBotVoiceCallProvider.");
  }
  return value;
}
