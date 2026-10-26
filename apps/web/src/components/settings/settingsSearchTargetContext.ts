import { createContext, useContext } from "react";

export interface SettingsSearchTargetContextValue {
  readonly targetId: string | null;
  readonly highlightTarget: boolean;
  readonly onTargetHandled: () => void;
}

const noop = () => undefined;
export const SettingsSearchTargetContext = createContext<SettingsSearchTargetContextValue>({
  targetId: null,
  highlightTarget: true,
  onTargetHandled: noop,
});

// Lives apart from settingsLayout: settingsLayout renders SettingsScopeSentence, which needs this
// hook, and a settingsLayout <-> SettingsScopeSentence import cycle deadlocks browser tests that
// mock settingsLayout.
export function useSettingsSearchTargetId(): string | null {
  return useContext(SettingsSearchTargetContext).targetId;
}
