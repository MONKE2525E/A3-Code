import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useWindowDimensions, type ViewStyle } from "react-native";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import {
  COMPOSER_FULLSCREEN_TRANSITION,
  COMPOSER_FULLSCREEN_TRANSITION_MS,
} from "./composerLayoutTransition";

// The layout transition is only armed briefly after a toggle.
const FULLSCREEN_TRANSITION_WINDOW_MS = COMPOSER_FULLSCREEN_TRANSITION_MS + 60;

/**
 * Fullscreen state for a composer.
 *
 * - Each toggle changes the card immediately and focuses the editor on expansion, including
 *   when a hardware keyboard keeps the software keyboard hidden.
 * - Collapses automatically when an open software keyboard is dismissed.
 * - `isAnimating` is true briefly after an animated change so Android (which otherwise snaps the
 *   composer so it can ride the keyboard) runs one height transition for the toggle. Automatic
 *   collapses (keyboard down, send, thread switch) pass `animate: false` and snap, leaving the
 *   keyboard-synced slide as the only motion.
 */
export function useComposerFullscreen() {
  const [isFullscreen, setIsFullscreenState] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const fullscreenRef = useRef(false);
  const animateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setFullscreen = useCallback((next: boolean, animate = true) => {
    if (fullscreenRef.current === next) return;
    fullscreenRef.current = next;
    setIsFullscreenState(next);
    if (animateTimerRef.current) clearTimeout(animateTimerRef.current);
    setIsAnimating(animate);
    if (animate) {
      animateTimerRef.current = setTimeout(
        () => setIsAnimating(false),
        FULLSCREEN_TRANSITION_WINDOW_MS,
      );
    }
  }, []);

  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const wasKeyboardVisibleRef = useRef(isKeyboardVisible);

  useEffect(() => {
    if (wasKeyboardVisibleRef.current && !isKeyboardVisible) {
      setFullscreen(false, false);
    }
    wasKeyboardVisibleRef.current = isKeyboardVisible;
  }, [isKeyboardVisible, setFullscreen]);

  const toggleFullscreen = useCallback(
    (focusEditor?: () => void) => {
      const next = !fullscreenRef.current;
      setFullscreen(next);
      if (next) focusEditor?.();
    },
    [setFullscreen],
  );

  // Rotating or folding changes the window width and re-lays the keyboard out, so the settled
  // geometry fullscreen leans on is stale. Start over with the small composer.
  const { width: windowWidth } = useWindowDimensions();
  const windowWidthRef = useRef(windowWidth);
  useEffect(() => {
    if (windowWidthRef.current === windowWidth) return;
    windowWidthRef.current = windowWidth;
    setFullscreen(false, false);
  }, [setFullscreen, windowWidth]);

  useEffect(
    () => () => {
      if (animateTimerRef.current) clearTimeout(animateTimerRef.current);
    },
    [],
  );

  return { isFullscreen, isAnimating, setFullscreen, toggleFullscreen };
}

export type ComposerFullscreenController = ReturnType<typeof useComposerFullscreen>;

/**
 * Keeps a composer above the keyboard by translating it with the IME, like KeyboardStickyView.
 * Fullscreen, the dock stretches to cover the space between `fullscreenTop` and the keyboard. The
 * animated translate stays identical in both modes. Fullscreen offsets the dock's top by the
 * same native lift in the same worklet, keeping its visible top at `fullscreenTop` even while
 * rotation resizes the keyboard before JS receives its new height.
 */
export function ComposerKeyboardDock(props: {
  readonly children: ReactNode;
  readonly fullscreen: boolean;
  readonly fullscreenTop?: number;
  readonly openedOffset: number;
  readonly enabled?: boolean;
  /** Animates the dock's own frame change, in step with the surface inside it. */
  readonly animateLayout?: boolean;
  readonly pointerEvents?: "box-none";
  readonly style: ViewStyle;
}) {
  const { height, progress } = useReanimatedKeyboardAnimation();
  const { enabled = true, openedOffset, fullscreen, fullscreenTop = 0 } = props;
  const restingTop = props.style.top ?? "auto";
  const animatedStyle = useAnimatedStyle(() => {
    const lift = enabled ? height.value + openedOffset * progress.value : 0;
    return {
      top: fullscreen ? fullscreenTop - lift : restingTop,
      transform: [{ translateY: lift }],
    };
  }, [enabled, openedOffset, fullscreen, fullscreenTop, restingTop]);

  return (
    <Animated.View
      layout={props.animateLayout ? COMPOSER_FULLSCREEN_TRANSITION : undefined}
      pointerEvents={props.pointerEvents}
      style={[props.style, animatedStyle]}
    >
      {props.children}
    </Animated.View>
  );
}
