/** Rewrites the in-box noVNC route using the broker's authenticated public routes. */
export function grokBotComputerViewerUrl(
  source: string,
  routes: {
    readonly primaryUrl?: string | undefined;
    readonly forkBaseUrl?: string | undefined;
    readonly networkToken?: string;
  },
): string {
  let url = new URL(source);
  if (["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname.endsWith("/vnc.html")) {
    if (url.port === "6080" && routes.primaryUrl) url = new URL(routes.primaryUrl);
    else if (url.port === "6081" && routes.forkBaseUrl && routes.networkToken) {
      const path = url.searchParams.get("path") ?? "";
      const token = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("token");
      url = new URL("vnc.html", routes.forkBaseUrl.replace(/\/$/, "") + "/");
      const socket = new URLSearchParams({
        ...(token ? { token } : {}),
        network_token: routes.networkToken,
        resume_lower_s: "900",
        resume_upper_s: "18000",
      });
      url.searchParams.set("network_token", routes.networkToken);
      url.searchParams.set("resume_lower_s", "900");
      url.searchParams.set("resume_upper_s", "18000");
      url.searchParams.set("path", "websockify?" + socket.toString());
    }
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !["cursor.sh", "cursor.com", "cursorvm.com"].some(
      (domain) => url.hostname === domain || url.hostname.endsWith("." + domain),
    )
  )
    throw new Error("Invalid Grok Bot computer route");
  url.searchParams.set("autoconnect", "true");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("reconnect", "true");
  url.searchParams.set("sandInteractive", "1");
  return url.toString();
}
