import * as NodeModule from "node:module";
import { act, createElement, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ComposerKeyboardDock, useComposerFullscreen } from "./ComposerKeyboardDock";

const keyboard = vi.hoisted(() => ({
  height: { value: -320 },
  progress: { value: 1 },
  visible: true,
  style: () => ({ top: 0 as number | string, transform: [{ translateY: 0 }] }),
}));
vi.mock("react-native", () => ({ useWindowDimensions: () => ({ width: 800, height: 1000 }) }));
vi.mock("react-native-keyboard-controller", () => ({
  useReanimatedKeyboardAnimation: () => keyboard,
  useKeyboardState: (selector: (state: { isVisible: boolean }) => unknown) =>
    selector({ isVisible: keyboard.visible }),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: () => null },
  Easing: { bezier: () => undefined },
  ReduceMotion: { System: "system" },
  withTiming: (value: number) => value,
  useAnimatedStyle: (callback: typeof keyboard.style) => {
    keyboard.style = callback;
    return {};
  },
}));

const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): { render(children: ReactNode): void; unmount(): void };
};
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  keyboard.height.value = -320;
  keyboard.progress.value = 1;
  keyboard.visible = true;
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("immediately reverses rapid toggles when native keyboard is open but JS visibility is stale", async () => {
  vi.useFakeTimers();
  keyboard.visible = false;
  let controller: ReturnType<typeof useComposerFullscreen>;
  function Probe() {
    const value = useComposerFullscreen();
    useEffect(() => {
      controller = value;
    });
    return null;
  }
  await act(() => root.render(createElement(Probe)));
  const focus = vi.fn();
  await act(() => controller.toggleFullscreen(focus));
  expect(controller!.isFullscreen).toBe(true);
  await act(() => controller.toggleFullscreen(focus));
  expect(controller!.isFullscreen).toBe(false);
  await act(() => controller.toggleFullscreen(focus));
  expect(controller!.isFullscreen).toBe(true);
  expect(focus).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTime(700));
  expect(controller!.isFullscreen).toBe(true);
});

it("immediately expands and reverses with the software keyboard hidden", async () => {
  vi.useFakeTimers();
  keyboard.visible = false;
  keyboard.height.value = 0;
  keyboard.progress.value = 0;
  let controller: ReturnType<typeof useComposerFullscreen>;
  function Probe() {
    const value = useComposerFullscreen();
    useEffect(() => {
      controller = value;
    });
    return null;
  }
  await act(() => root.render(createElement(Probe)));
  const focus = vi.fn();
  await act(() => controller.toggleFullscreen(focus));
  expect(focus).toHaveBeenCalledOnce();
  expect(controller!.isFullscreen).toBe(true);
  await act(() => controller.toggleFullscreen(focus));
  expect(controller!.isFullscreen).toBe(false);
  await act(() => controller.toggleFullscreen(focus));
  expect(controller!.isFullscreen).toBe(true);
  expect(focus).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTime(700));
  expect(controller!.isFullscreen).toBe(true);
});

it("keeps fullscreen within the safe area and follows native keyboard height before JS catches up", async () => {
  await act(() =>
    root.render(
      createElement(ComposerKeyboardDock, {
        fullscreen: true,
        fullscreenTop: 44,
        openedOffset: 34,
        style: { position: "absolute", top: 0, bottom: 0 },
        children: null,
      }),
    ),
  );
  // No React render or JS keyboard state update occurs between these native resize frames.
  for (const [viewportHeight, keyboardHeight] of [
    [1000, 0],
    [1000, 320],
    [800, 400],
    [1000, 280],
  ]) {
    keyboard.height.value = -keyboardHeight!;
    keyboard.progress.value = keyboardHeight === 0 ? 0 : 1;
    const style = keyboard.style();
    const translation = style.transform[0]!.translateY;
    const visibleTop = Number(style.top) + translation;
    // The composer retains its 34px safe-area padding inside the translated dock.
    const visibleBottom = viewportHeight! + translation - 34;
    expect(visibleTop).toBe(44);
    expect(visibleBottom).toBe(viewportHeight! - (keyboardHeight || 34));
    expect(visibleBottom).toBeGreaterThan(visibleTop);
  }
});

it("restores the resting top when fullscreen collapses", async () => {
  const props = {
    fullscreen: true,
    openedOffset: 0,
    style: { top: 0, bottom: 0 },
    children: null,
  };
  await act(() => root.render(createElement(ComposerKeyboardDock, props)));
  await act(() =>
    root.render(createElement(ComposerKeyboardDock, { ...props, fullscreen: false })),
  );
  expect(keyboard.style().top).toBe(0);
});
