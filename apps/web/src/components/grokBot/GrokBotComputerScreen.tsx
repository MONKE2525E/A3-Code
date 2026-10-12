import { useEffect, useRef, useState } from "react";
import { Spinner } from "~/components/ui/spinner";

/** Mounts noVNC locally: native hosted assets require an Electron-only request header. */
export function GrokBotComputerScreen({ socketUrl }: { readonly socketUrl: string }) {
  const target = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting");
  useEffect(() => {
    let disposed = false;
    let disconnect: (() => void) | undefined;
    void import("@novnc/novnc")
      .then(({ default: RFB }) => {
        if (disposed || !target.current) return;
        setStatus("connecting");
        const client = new RFB(target.current, socketUrl, { shared: true });
        client.scaleViewport = true;
        client.resizeSession = false;
        client.viewOnly = false;
        client.focusOnClick = true;
        const connected = () => setStatus("connected");
        const disconnected = () => setStatus("disconnected");
        client.addEventListener("connect", connected);
        client.addEventListener("disconnect", disconnected);
        client.addEventListener("securityfailure", disconnected);
        client.addEventListener("credentialsrequired", disconnected);
        disconnect = () => {
          client.removeEventListener("connect", connected);
          client.removeEventListener("disconnect", disconnected);
          client.removeEventListener("securityfailure", disconnected);
          client.removeEventListener("credentialsrequired", disconnected);
          client.disconnect();
        };
      })
      .catch(() => {
        if (!disposed) setStatus("disconnected");
      });
    return () => {
      disposed = true;
      disconnect?.();
    };
  }, [socketUrl]);
  return (
    <div
      data-grok-bot-computer=""
      className="relative min-h-0 flex-1 overflow-hidden"
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div ref={target} className="h-full w-full" aria-label="Grok Bot cloud computer" />
      {status !== "connected" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-5 text-center text-sm text-muted-foreground">
          {status === "connecting" ? <Spinner /> : null}
          <p>
            {status === "connecting"
              ? "Connecting to the cloud computer…"
              : "Computer disconnected. Use Reconnect to try again."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
