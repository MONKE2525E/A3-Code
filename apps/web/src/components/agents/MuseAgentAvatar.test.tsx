// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { MuseAgentAvatar } from "./MuseAgentAvatar";

const CLIP_URL = "https://example.test/clip.mp4";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let reducedMotion: boolean;
let documentVisibility: DocumentVisibilityState;
let notifyVisible: ((isIntersecting: boolean) => void) | undefined;

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    notifyVisible = (isIntersecting) =>
      callback(
        [{ isIntersecting } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
  }
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reducedMotion = false;
  documentVisibility = "visible";
  notifyVisible = undefined;
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reducedMotion;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => documentVisibility);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(active: boolean) {
  return act(async () =>
    root.render(<MuseAgentAvatar name="Muse" videoUrl={CLIP_URL} active={active} />),
  );
}

function clip(): HTMLVideoElement {
  const video = container.querySelector("video");
  if (!video) throw new Error("expected the avatar to render its clip");
  return video;
}

it("plays an active clip once and never loops it, so a long run does not keep repainting", async () => {
  await render(true);

  expect(clip().loop).toBe(false);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
});

it("replays the clip once per activation rather than on its own", async () => {
  await render(true);
  await render(false);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();

  await render(true);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});

it("stays parked under reduced motion, even while the agent is active", async () => {
  reducedMotion = true;
  await render(true);

  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

it("stays parked in a hidden document from the first frame", async () => {
  documentVisibility = "hidden";
  await render(true);

  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

it("parks while scrolled out of view and resumes when it returns", async () => {
  await render(true);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

  await act(async () => notifyVisible?.(false));
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();

  await act(async () => notifyVisible?.(true));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});
