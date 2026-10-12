import { describe, expect, it, vi } from "vite-plus/test";

import {
  checkForkReleaseUpdate,
  FORK_APK_NAME,
  FORK_RELEASES_API,
  FORK_RELEASES_URL,
  selectForkReleaseUpdate,
} from "./fork-releases";

function release(build: number, overrides = {}) {
  const tag = `mobile-build-${build}`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: FORK_APK_NAME,
        state: "uploaded",
        browser_download_url: `${FORK_RELEASES_URL}/download/${tag}/${FORK_APK_NAME}`,
      },
    ],
    ...overrides,
  };
}

describe("fork APK releases", () => {
  it("finds the highest newer build regardless of publication order, including prereleases", () => {
    expect(
      selectForkReleaseUpdate([release(12), release(15, { prerelease: true }), release(14)], 10),
    ).toEqual({
      build: 15,
      tag: "mobile-build-15",
      downloadUrl: `${FORK_RELEASES_URL}/download/mobile-build-15/${FORK_APK_NAME}`,
    });
  });
  it("does not offer an installed build or a downgrade", () => {
    expect(selectForkReleaseUpdate([release(10), release(9)], 10)).toBeNull();
  });
  it("ignores drafts, desktop tags, and releases without the custom APK", () => {
    expect(
      selectForkReleaseUpdate(
        [
          release(12, { draft: true }),
          release(13, { tag_name: "v2.0.0" }),
          release(14, { assets: [] }),
        ],
        10,
      ),
    ).toBeNull();
  });
  it("rejects downloads outside this repository and assets still uploading", () => {
    const wrong = release(12, {
      assets: [
        {
          name: FORK_APK_NAME,
          state: "uploaded",
          browser_download_url: "https://example.com/app.apk",
        },
      ],
    });
    const pending = release(13, {
      assets: [
        {
          name: FORK_APK_NAME,
          state: "new",
          browser_download_url: `${FORK_RELEASES_URL}/download/mobile-build-13/${FORK_APK_NAME}`,
        },
      ],
    });
    expect(selectForkReleaseUpdate([wrong, pending], 10)).toBeNull();
  });
  it("ignores malformed entries and out-of-range native version codes", () => {
    expect(
      selectForkReleaseUpdate(
        [
          null,
          {},
          release(0),
          release(2_100_000_001),
          release(1.5),
          release(20, { assets: null }),
          release(11),
        ],
        10,
      )?.build,
    ).toBe(11);
  });
  it("reports an empty repository accurately and rejects an invalid response", () => {
    expect(selectForkReleaseUpdate([], 1)).toBeNull();
    expect(() => selectForkReleaseUpdate({ message: "error" }, 1)).toThrow("invalid release list");
  });
  it("checks the fork's public GitHub API", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify([release(12)])));
    expect((await checkForkReleaseUpdate(10, request))?.build).toBe(12);
    expect(request).toHaveBeenCalledWith(FORK_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: expect.any(AbortSignal),
    });
  });
  it("does not report up to date on a rate limit or network failure", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 }));
    await expect(checkForkReleaseUpdate(10, request)).rejects.toThrow("403");
    request.mockRejectedValue(new Error("offline"));
    await expect(checkForkReleaseUpdate(10, request)).rejects.toThrow("offline");
  });
  it("aborts a stalled request and clears its timeout", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>().mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const checked = expect(checkForkReleaseUpdate(10, request)).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(15_000);
      await checked;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
