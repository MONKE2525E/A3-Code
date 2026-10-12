import * as NodeModule from "node:module";
import { act, createElement, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useComposerKeyboardEnabled } from "./useComposerKeyboardEnabled";

const native = vi.hoisted(() => ({
  platform: "android",
  state: { isVisible: true, height: 320 },
  appListeners: new Set<(state: string) => void>(),
  keyboardListeners: new Map<string, () => void>(),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.platform;
    },
  },
  AppState: {
    addEventListener: (_event: string, callback: (state: string) => void) => {
      native.appListeners.add(callback);
      return { remove: () => native.appListeners.delete(callback) };
    },
  },
}));
vi.mock("react-native-keyboard-controller", () => ({
  useKeyboardState: (selector: (state: typeof native.state) => unknown) => selector(native.state),
  KeyboardEvents: {
    addListener: (event: string, callback: () => void) => {
      native.keyboardListeners.set(event, callback);
      return { remove: () => native.keyboardListeners.delete(event) };
    },
  },
}));

const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): { render(children: ReactNode): void; unmount(): void };
};
let root: ReturnType<typeof createRoot>;
let controller: ReturnType<typeof useComposerKeyboardEnabled>;
function Probe() {
  const value = useComposerKeyboardEnabled();
  useEffect(() => {
    controller = value;
  });
  return null;
}

beforeEach(async () => {
  native.platform = "android";
  native.state = { isVisible: true, height: 320 };
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
  await act(() => root.render(createElement(Probe)));
});

afterEach(async () => {
  await act(() => root.unmount());
  expect(native.appListeners.size).toBe(0);
  expect(native.keyboardListeners.size).toBe(0);
  vi.unstubAllGlobals();
});

async function resume() {
  await act(() => native.appListeners.forEach((callback) => callback("active")));
}

it.each(["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"])(
  "recovers from resume on %s even when height and visibility have not changed",
  async (event) => {
    expect(controller.enabled).toBe(true);
    await resume();
    expect(controller.enabled).toBe(false);
    await act(() => native.keyboardListeners.get(event)?.());
    expect(controller.enabled).toBe(true);
    expect(native.state).toEqual({ isVisible: true, height: 320 });
  },
);

it("keeps a stale offset quarantined until keyboard activity or owned input focus", async () => {
  await resume();
  await act(() => root.render(createElement(Probe)));
  expect(controller.enabled).toBe(false);
  await act(() => controller.onInputFocusChange(false));
  expect(controller.enabled).toBe(false);
  await act(() => controller.onInputFocusChange(true));
  expect(controller.enabled).toBe(true);
});

it("keeps the native animated stream enabled when JS visibility briefly reports hidden", async () => {
  native.state = { isVisible: false, height: 0 };
  await act(() => root.render(createElement(Probe)));
  expect(controller.enabled).toBe(true);
});
