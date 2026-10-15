const CACHE_NAME = "t3-marketplace-icons-v1";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 128;
const pending = new Map<string, Promise<Blob | null>>();

/** Persist bounded image bytes so an unavailable icon host does not erase a known logo. */
export function loadMarketplaceIcon(url: string): Promise<Blob | null> {
  const prior = pending.get(url);
  if (prior) return prior;
  const load = (async () => {
    let cache: Cache | undefined;
    try {
      cache = await globalThis.caches?.open(CACHE_NAME);
    } catch {
      /* Private browsing and full storage can refuse persistence. */
    }
    try {
      const saved = await cache?.match(url);
      if (saved) return saved.blob();
    } catch {
      /* A failed cache read still permits a network load. */
    }
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        return null;
      const response = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(8000),
      });
      const type = response.headers.get("content-type")?.split(";")[0] ?? "";
      if (
        !response.ok ||
        ![
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "image/svg+xml",
          "image/x-icon",
          "image/vnd.microsoft.icon",
        ].includes(type) ||
        Number(response.headers.get("content-length")) > MAX_BYTES ||
        !response.body
      )
        return null;
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BYTES) return null;
          chunks.push(new Uint8Array(next.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!size) return null;
      const blob = new Blob(chunks, { type });
      try {
        if (cache) {
          await cache.put(url, new Response(blob));
          const keys = await cache.keys();
          for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)))
            await cache.delete(key);
        }
      } catch {
        /* A quota failure must not hide an image already fetched. */
      }
      return blob;
    } catch {
      return null;
    }
  })().finally(() => pending.delete(url));
  pending.set(url, load);
  return load;
}
