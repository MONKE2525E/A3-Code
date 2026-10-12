import type { VoiceSocket } from "@t3tools/client-runtime/grok-bot-voice/call-session";

/** Dials the realtime endpoint with the ephemeral secret as the only subprotocol. */
export function openBrowserVoiceSocket(url: string, protocols: string[]): VoiceSocket {
  const socket = new WebSocket(url, protocols);
  return {
    send: (frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    },
    // Closing a socket that is still connecting is allowed; the browser aborts the handshake.
    close: (code, reason) => {
      if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
      socket.close(code, reason);
    },
    get isOpen() {
      return socket.readyState === WebSocket.OPEN;
    },
    onOpen: (listener) => socket.addEventListener("open", () => listener()),
    onMessage: (listener) =>
      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        // Realtime frames are JSON text; binary frames are not part of this protocol.
        if (typeof event.data === "string") listener(event.data);
      }),
    onClose: (listener) =>
      socket.addEventListener("close", (event: CloseEvent) =>
        listener({ code: event.code, clean: event.wasClean }),
      ),
  };
}
