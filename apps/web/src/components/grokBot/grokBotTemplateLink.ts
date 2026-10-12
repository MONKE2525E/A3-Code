const SHARE_ID = /^[A-Za-z0-9_-]{21}$/;

/** Extracts native template IDs without following the supplied URL. */
export function parseGrokBotTemplateLink(value: string): string | null {
  const link = value.trim();
  if (link.length > 2048 || /[\s\\]/.test(link)) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.hash) return null;

  // Native sharing publishes https://x.ai/bot/<21-character share ID>.
  if (url.origin === "https://x.ai" && !url.search) {
    const match = /^\/bot\/([A-Za-z0-9_-]{21})\/?$/.exec(url.pathname);
    return match?.[1] ?? null;
  }
  // The app also handles grokbot://app/v1/bot-template?id=<share ID> (and sand://).
  if (
    (url.protocol === "grokbot:" || url.protocol === "sand:") &&
    url.hostname === "app" &&
    url.pathname === "/v1/bot-template" &&
    [...url.searchParams.keys()].length === 1
  ) {
    const id = url.searchParams.get("id");
    return id !== null && SHARE_ID.test(id) ? id : null;
  }
  return null;
}
