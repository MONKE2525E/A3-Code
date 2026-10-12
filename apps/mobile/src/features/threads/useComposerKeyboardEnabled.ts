import { useCallback, useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { KeyboardEvents } from "react-native-keyboard-controller";

/** Quarantines Android's stale keyboard offset after resume until native input activity resumes. */
export function useComposerKeyboardEnabled() {
  const [suspect, setSuspect] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const resume = AppState.addEventListener("change", (state) => {
      if (state === "active") setSuspect(true);
    });
    // Rotation can report the same height and visibility as before. A fresh event still proves
    // the native stream is live, even when useKeyboardState produces no React state change.
    const keyboard = (
      ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"] as const
    ).map((event) => KeyboardEvents.addListener(event, () => setSuspect(false)));
    return () => {
      resume.remove();
      keyboard.forEach((subscription) => subscription.remove());
    };
  }, []);

  const onInputFocusChange = useCallback((focused: boolean) => {
    if (focused) setSuspect(false);
  }, []);

  // The animated stream already reaches zero when hidden. Gating on JS visibility can instead
  // discard a live native offset during rotation or before the show event reaches React.
  return { enabled: Platform.OS !== "android" || !suspect, onInputFocusChange };
}
