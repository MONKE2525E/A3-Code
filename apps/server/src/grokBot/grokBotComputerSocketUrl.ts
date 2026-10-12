import { grokBotComputerViewerUrl } from "./grokBotComputerUrl.ts";

/** Native noVNC's websocket path carries its display token and broker network grant. */
export function grokBotComputerSocketUrl(
  source: string,
  routes: Parameters<typeof grokBotComputerViewerUrl>[1],
): string {
  const viewer = new URL(grokBotComputerViewerUrl(source, routes));
  const path = viewer.searchParams.get("path") || "websockify";
  const socket = new URL(path.startsWith("/") ? path : "/" + path, viewer.origin);
  if (socket.origin !== viewer.origin) throw new Error("Invalid Grok Bot socket route");
  for (const name of ["network_token", "port_token"])
    if (!socket.searchParams.has(name)) {
      const token = viewer.searchParams.get(name);
      if (token !== null) socket.searchParams.set(name, token);
    }
  socket.protocol = "wss:";
  return socket.toString();
}
