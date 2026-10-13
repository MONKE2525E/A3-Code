// @effect-diagnostics nodeBuiltinImport:off - the relay only targets fixed loopback ports, which the Effect HTTP server layer cannot probe and fall back across
import * as NodeHttp from "node:http";

/**
 * The Grok Bot backend registers its OAuth redirect with a relay that forwards the browser to
 * `http://localhost:<port>/callback`, where the native app listens. These are the ports the relay
 * knows; the first free one is used. A busy port is never taken over.
 */
export const LOOPBACK_PORTS: readonly number[] = [8787, 18787, 28787, 31787];
const RELAY_REDIRECT_URI = "https://www.cursor.com/agents/mcp/oauth/callback";
const RELAY_LOOPBACK_SUFFIX = ".tgd";
const DEFAULT_PORT = LOOPBACK_PORTS[0];

export const isLoopbackHostname = (hostname: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

/** True when the provider's URL redirects through the relay, so a listener on this machine can receive it. */
export const usesLoopbackRelay = (authorizationUrl: URL) =>
  authorizationUrl.searchParams.get("redirect_uri") === RELAY_REDIRECT_URI &&
  authorizationUrl.searchParams.get("state")?.endsWith(RELAY_LOOPBACK_SUFFIX) === true;

/**
 * Same encoding as the native app: the default port keeps the state as issued, every other port is
 * appended to it. The relay reads the port back from the state's suffix.
 */
export function retargetAuthorizationUrl(authorizationUrl: URL, port: number): URL | null {
  if (!usesLoopbackRelay(authorizationUrl)) return null;
  const url = new URL(authorizationUrl.href);
  if (port !== DEFAULT_PORT) {
    url.searchParams.set("state", `${authorizationUrl.searchParams.get("state")}${port}`);
  }
  return url;
}

/** Strip the relay port suffix to get the state id the backend issued. */
export function baseStateId(state: string) {
  return state.replace(/(\.tgd)\d{1,5}$/, "$1");
}

export type LoopbackCallback = {
  readonly state: string | null;
  readonly code: string | null;
  readonly error: string | null;
};

const page = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>T3 Code</title><body style="font:16px system-ui;margin:3rem auto;max-width:28rem;text-align:center"><h1>${
    ok ? "Connected" : "Connection failed"
  }</h1><p>${
    ok
      ? "You can close this tab and return to T3 Code."
      : "Return to T3 Code and try connecting again."
  }</p>`;

export type LoopbackListener = {
  readonly port: number;
  /** Stops accepting and ends idle connections without cutting a response in flight. Safe to call from a request handler. */
  readonly release: () => void;
  /** Resolves once every socket is gone. */
  readonly close: () => Promise<void>;
};

type Bound = { readonly server: NodeHttp.Server; readonly port: number };

const listenOn = (
  server: NodeHttp.Server,
  port: number,
  host: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string | undefined }> =>
  new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => resolve({ ok: false, code: error.code });
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve({ ok: true });
    });
  });

const closeServer = (server: NodeHttp.Server) =>
  new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeIdleConnections();
  });

// Hosts without IPv6 report these on ::1; any other failure means something else owns the port there.
const IPV6_ABSENT = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"]);

/**
 * One listener on the first free relay port. `localhost` may resolve to either family, so the port
 * must be ours on both 127.0.0.1 and ::1: when another process already owns it on ::1 the port is
 * skipped, since the browser could land on that process instead. Hosts without IPv6 serve IPv4 only.
 * `handle` resolves true when the callback matched a pending flow and was exchanged.
 */
export async function startLoopbackListener(options: {
  readonly ports: readonly number[];
  readonly handle: (callback: LoopbackCallback) => Promise<boolean>;
}): Promise<LoopbackListener | null> {
  const listener: NodeHttp.RequestListener = (request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      response.writeHead(400, { Connection: "close" }).end();
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404, { Connection: "close" }).end();
      return;
    }
    void Promise.resolve()
      .then(() =>
        options.handle({
          state: url.searchParams.get("state"),
          code: url.searchParams.get("code"),
          error: url.searchParams.get("error"),
        }),
      )
      .catch(() => false)
      .then((ok) => {
        response
          .writeHead(ok ? 200 : 400, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            Connection: "close",
          })
          .end(page(ok));
      })
      .catch(() => response.destroy());
  };
  const create = () => {
    const server = NodeHttp.createServer(listener);
    // A late socket error must never take the process down.
    server.on("error", () => {});
    return server;
  };
  for (const port of options.ports) {
    const v4 = create();
    if (!(await listenOn(v4, port, "127.0.0.1")).ok) continue;
    const actual = (v4.address() as { port: number }).port;
    const v6 = create();
    const bound = await listenOn(v6, actual, "::1");
    if (!bound.ok && !(bound.code && IPV6_ABSENT.has(bound.code))) {
      await closeServer(v4);
      continue;
    }
    const servers: Bound[] = [{ server: v4, port: actual }];
    if (bound.ok) servers.push({ server: v6, port: actual });
    return {
      port: actual,
      release: () => {
        for (const { server } of servers) void closeServer(server);
      },
      close: async () => {
        const closing = servers.map(({ server }) => closeServer(server));
        for (const { server } of servers) server.closeAllConnections();
        await Promise.all(closing);
      },
    };
  }
  return null;
}
