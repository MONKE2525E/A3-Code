import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { MuseAgentAvatar } from "./MuseAgentAvatar";

const CLIP_URL = "https://example.test/clip.mp4";

function setup({
  reducedMotion = false,
  visibility = "visible",
}: {
  reducedMotion?: boolean;
  visibility?: DocumentVisibilityState;
} = {}) {
  const disposables = new DisposableStack();
  disposables.use(
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: reducedMotion,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    })),
  );
  let notifyVisible = (_visible: boolean) => {};
  class FakeIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly scrollMargin = "0px";
    readonly thresholds = [0];
    constructor(callback: IntersectionObserverCallback) {
      notifyVisible = (isIntersecting) =>
        callback(
          [
            {
              isIntersecting,
              target: document.body,
              boundingClientRect: new DOMRect(),
              intersectionRect: new DOMRect(),
              intersectionRatio: isIntersecting ? 1 : 0,
              rootBounds: null,
              time: 0,
            },
          ],
          this,
        );
    }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  disposables.use(
    vi.spyOn(window, "IntersectionObserver").mockImplementation(FakeIntersectionObserver),
  );
  disposables.use(vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility));
  const play = disposables.use(
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined),
  );
  const pause = disposables.use(
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined),
  );
  return {
    play,
    pause,
    notifyVisible: (visible: boolean) => notifyVisible(visible),
    [Symbol.dispose]: () => disposables.dispose(),
  };
}

it("plays an active clip once and never loops it, so a long run does not keep repainting", async () => {
  using media = setup();
  await using screen = await render(<MuseAgentAvatar name="Muse" videoUrl={CLIP_URL} active />);
  await vi.waitFor(() => expect(screen.container.querySelector("video")?.loop).toBe(false));
  expect(media.play).toHaveBeenCalledTimes(1);
});

it("replays the clip once per activation rather than on its own", async () => {
  using media = setup();
  await using screen = await render(<MuseAgentAvatar name="Muse" videoUrl={CLIP_URL} active />);
  await screen.rerender(<MuseAgentAvatar name="Muse" videoUrl={CLIP_URL} active={false} />);
  expect(media.pause).toHaveBeenCalled();
  await screen.rerender(<MuseAgentAvatar name="Muse" videoUrl={CLIP_URL} active />);
  expect(media.play).toHaveBeenCalledTimes(2);
});

it("stays parked under reduced motion, even while the agent is active", async () => {
  using media = setup({ reducedMotion: true });
  await using _screen = await render(<MuseAgentAvatar name="Muse" videoUrl={CLIP_URL} active />);
  expect(media.play).not.toHaveBeenCalled();
});

it("stays parked in a hidden document from the first frame", async () => {
  using media = setup({ visibility: "hidden" });
  await using _screen = await render(<MuseAgentAvatar name="Muse" videoUrl={CLIP_URL} active />);
  expect(media.play).not.toHaveBeenCalled();
});

it("parks while scrolled out of view and resumes when it returns", async () => {
  using media = setup();
  await using _screen = await render(<MuseAgentAvatar name="Muse" videoUrl={CLIP_URL} active />);
  expect(media.play).toHaveBeenCalledTimes(1);
  await act(() => media.notifyVisible(false));
  expect(media.pause).toHaveBeenCalled();
  await act(() => media.notifyVisible(true));
  expect(media.play).toHaveBeenCalledTimes(2);
});
