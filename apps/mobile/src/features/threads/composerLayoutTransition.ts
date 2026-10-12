import {
  Easing,
  type LayoutAnimationFunction,
  ReduceMotion,
  withTiming,
} from "react-native-reanimated";

export const COMPOSER_TRANSITION_DURATION_MS = 220;

// Side panes already animate the dock's width. Nested horizontal layout
// transitions would leave the surface trailing its toolbar's new position.
// Keep the vertical pill/card morph while horizontal layout follows the dock.
export const COMPOSER_HEIGHT_TRANSITION: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_TRANSITION_DURATION_MS,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};

export const COMPOSER_FULLSCREEN_TRANSITION_MS = 300;

// The fullscreen morph covers most of the screen, so it gets a longer, ease-out curve than the
// pill/card morph: it leaves quickly and settles softly instead of lurching in and out. The card,
// its dock, and the editor/toolbar inside all use this one function so they move as a unit.
const FULLSCREEN_EASING = Easing.bezier(0.2, 0, 0, 1);
export const COMPOSER_FULLSCREEN_TRANSITION: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_FULLSCREEN_TRANSITION_MS,
    easing: FULLSCREEN_EASING,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};
