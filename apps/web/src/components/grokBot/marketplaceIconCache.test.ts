import { afterEach, expect, it, vi } from "vite-plus/test";
import { loadMarketplaceIcon } from "./marketplaceIconCache";

afterEach(() => vi.unstubAllGlobals());

it("persists image bytes and reuses them when the host is offline", async () => {
  const stored = new Map<string, Response>();
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async (url: string) => stored.get(url)?.clone(),
      put: async (url: string, response: Response) => {
        stored.set(url, response);
      },
      keys: async () => [...stored.keys()],
      delete: async (url: string) => stored.delete(url),
    }),
  });
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response("synthetic-image", { headers: { "content-type": "image/png" } }),
    );
  vi.stubGlobal("fetch", fetch);
  expect(await (await loadMarketplaceIcon("https://images.example.test/logo.png"))?.text()).toBe(
    "synthetic-image",
  );
  fetch.mockRejectedValue(new Error("offline"));
  expect(await (await loadMarketplaceIcon("https://images.example.test/logo.png"))?.text()).toBe(
    "synthetic-image",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("deduplicates simultaneous loads and rejects non-image and oversized responses", async () => {
  vi.stubGlobal("caches", undefined);
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response("logo", { headers: { "content-type": "image/webp" } }));
  vi.stubGlobal("fetch", fetch);
  const [one, two] = await Promise.all([
    loadMarketplaceIcon("https://images.example.test/shared.webp"),
    loadMarketplaceIcon("https://images.example.test/shared.webp"),
  ]);
  expect(one).toBe(two);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue(
    new Response("<html>Error</html>", { headers: { "content-type": "text/html" } }),
  );
  expect(await loadMarketplaceIcon("https://images.example.test/error")).toBeNull();
  fetch.mockResolvedValue(
    new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }),
  );
  expect(await loadMarketplaceIcon("https://images.example.test/large.png")).toBeNull();
});

it("still displays fetched bytes when browser storage rejects writes", async () => {
  vi.stubGlobal("caches", {
    open: async () => {
      throw new Error("storage denied");
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("image", { headers: { "content-type": "image/png" } })),
  );
  expect(
    await (await loadMarketplaceIcon("https://images.example.test/no-storage.png"))?.text(),
  ).toBe("image");
});
