// @effect-diagnostics nodeBuiltinImport:off -- Native egress is a binary WebSocket-to-TCP adapter.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { isPublicFaviconHost } from "@t3tools/shared/hostClassification";

export type EgressPolicy = {
  readonly restricted: boolean;
  readonly allowedDomains: readonly string[];
  readonly allowedTcpDestinations: readonly { readonly cidr: string; readonly port: number }[];
};
export function egressAllows(host: string, port: number, policy: EgressPolicy): boolean {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    host.length > 253 ||
    !/^[a-z\d.:-]+$/i.test(host)
  )
    return false;
  if (!policy.restricted) return true;
  const name = host.toLowerCase().replace(/\.$/, "");
  if (
    (port === 80 || port === 443) &&
    policy.allowedDomains.some((domain) => {
      const rule = domain.toLowerCase().replace(/\.$/, "");
      return rule.startsWith("*.") ? name.endsWith(rule.slice(1)) : name === rule;
    })
  )
    return true;
  if (NodeNet.isIP(host) !== 4) return false;
  const value = host.split(".").reduce((a, n) => (a << 8) | Number(n), 0) >>> 0;
  return policy.allowedTcpDestinations.some((rule) => {
    const [ip, prefix = "32"] = rule.cidr.split("/");
    const bits = Number(prefix);
    if (
      rule.port !== port ||
      !ip ||
      NodeNet.isIP(ip) !== 4 ||
      !Number.isInteger(bits) ||
      bits < 0 ||
      bits > 32
    )
      return false;
    const network = ip.split(".").reduce((a, n) => (a << 8) | Number(n), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (network & mask) >>> 0;
  });
}
export function egressFrame(bytes: Buffer) {
  if (bytes.length < 5) return null;
  const id = bytes.readUInt32BE(1);
  if (bytes[0] === 1 && bytes.length >= 8)
    return {
      kind: "open" as const,
      id,
      port: bytes.readUInt16BE(5),
      host: bytes.toString("utf8", 7),
    };
  if (bytes[0] === 2) return { kind: "data" as const, id, data: bytes.subarray(5) };
  if (bytes[0] === 3 && bytes.length === 5) return { kind: "close" as const, id };
  return null;
}
const closeFrame = (id: number) => {
  const b = Buffer.alloc(5);
  b[0] = 3;
  b.writeUInt32BE(id, 1);
  return b;
};
const MAX_BUFFER = 1024 * 1024;

/** Same native framing and if-free ownership. Never claims or replaces another desktop tunnel. */
export function startEgressClient(input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly policy: EgressPolicy;
  readonly now: () => number;
  readonly status: (
    state: "connecting" | "connected" | "standby" | "error",
    active: number,
    relayed: number,
  ) => void;
}) {
  let stopped = false;
  let relayed = 0;
  let state: "connecting" | "connected" | "standby" | "error" = "connecting";
  let heard = input.now();
  const streams = new Map<
    number,
    { socket?: NodeNet.Socket; pending: Buffer[]; bytes: number; ended: boolean; openedAt: number }
  >();
  const resumeDrainedStreams = () => {
    if (ws.bufferedAmount > MAX_BUFFER) return;
    for (const stream of streams.values()) if (stream.socket?.isPaused()) stream.socket.resume();
  };
  const ws = new NodeWS.WebSocket(input.url, {
    headers: { ...input.headers, "x-sand-egress-attach": "if-free" },
    handshakeTimeout: 15000,
    maxPayload: MAX_BUFFER,
  });
  const publish = () => input.status(state, streams.size, relayed);
  const send = (bytes: Buffer) => {
    if (!stopped && ws.readyState === NodeWS.WebSocket.OPEN) ws.send(bytes);
  };
  const close = (id: number, expected?: ReturnType<typeof streams.get>) => {
    const stream = streams.get(id);
    if (!stream || (expected !== undefined && expected !== stream)) return;
    streams.delete(id);
    stream.socket?.destroy();
    send(closeFrame(id));
    publish();
  };
  const open = async (id: number, host: string, port: number) => {
    if (streams.has(id) || streams.size >= 64) {
      send(closeFrame(id));
      return;
    }
    const stream: {
      socket?: NodeNet.Socket;
      pending: Buffer[];
      bytes: number;
      ended: boolean;
      openedAt: number;
    } = {
      pending: [],
      bytes: 0,
      ended: false,
      openedAt: input.now(),
    };
    streams.set(id, stream);
    try {
      // Resolve once and connect to that exact public address, preventing DNS rebinding.
      const addresses = await NodeDnsPromises.lookup(host, { all: true });
      const address = addresses.find(
        (entry) =>
          isPublicFaviconHost(entry.address) &&
          (egressAllows(host, port, input.policy) ||
            egressAllows(entry.address, port, input.policy)),
      );
      if (
        !address ||
        stopped ||
        streams.get(id) !== stream ||
        ws.readyState !== NodeWS.WebSocket.OPEN
      ) {
        close(id, stream);
        return;
      }
      const socket = NodeNet.createConnection({ host: address.address, port });
      stream.socket = socket;
      socket.setTimeout(5 * 60_000, () => close(id, stream));
      socket.on("connect", () => {
        relayed++;
        publish();
      });
      socket.on("data", (data) => {
        if (ws.readyState !== NodeWS.WebSocket.OPEN) {
          close(id, stream);
          return;
        }
        const frame = Buffer.allocUnsafe(5 + data.length);
        frame[0] = 2;
        frame.writeUInt32BE(id, 1);
        data.copy(frame, 5);
        ws.send(frame, resumeDrainedStreams);
        if (ws.bufferedAmount > MAX_BUFFER) socket.pause();
      });
      socket.on("error", () => close(id, stream));
      socket.on("close", () => close(id, stream));
      for (const data of stream.pending) socket.write(data);
      stream.pending = [];
      stream.bytes = 0;
      if (stream.ended) socket.end();
    } catch {
      close(id, stream);
    }
  };
  ws.on("open", () => {
    heard = input.now();
    ws.ping();
  });
  const alive = () => {
    if (stopped) return;
    heard = input.now();
    state = "connected";
    publish();
  };
  ws.on("ping", alive);
  ws.on("pong", alive);
  ws.on("message", (data, binary) => {
    alive();
    if (!binary) return;
    const bytes = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    const frame = egressFrame(bytes);
    if (!frame) return;
    if (frame.kind === "open") {
      if (
        !Number.isInteger(frame.port) ||
        frame.port === 0 ||
        !/^[a-z\d.:-]{1,253}$/i.test(frame.host)
      ) {
        send(closeFrame(frame.id));
        return;
      }
      void open(frame.id, frame.host, frame.port);
      return;
    }
    const stream = streams.get(frame.id);
    if (!stream) return;
    if (frame.kind === "close") {
      if (stream.socket) stream.socket.end();
      else stream.ended = true;
      return;
    }
    if (stream.socket) {
      if (stream.socket.writableLength + frame.data.length > MAX_BUFFER) close(frame.id);
      else stream.socket.write(frame.data);
    } else {
      stream.bytes += frame.data.length;
      if (stream.bytes > MAX_BUFFER) close(frame.id);
      else stream.pending.push(frame.data);
    }
  });
  ws.on("unexpected-response", (_request, response) => {
    if (stopped) return;
    state = response.statusCode === 409 ? "standby" : "error";
    ws.terminate();
    publish();
  });
  ws.on("error", () => {
    if (stopped) return;
    if (state !== "standby") state = "error";
    publish();
  });
  ws.on("close", (code) => {
    for (const stream of streams.values()) stream.socket?.destroy();
    streams.clear();
    if (!stopped) {
      state = code === 4001 || code === 4002 || state === "standby" ? "standby" : "error";
      publish();
    }
  });
  publish();
  return {
    isAlive: () =>
      ws.readyState === NodeWS.WebSocket.OPEN || ws.readyState === NodeWS.WebSocket.CONNECTING,
    heartbeat: () => {
      resumeDrainedStreams();
      // A stalled DNS lookup must not hold a stream slot indefinitely.
      for (const [id, stream] of streams)
        if (!stream.socket && input.now() - stream.openedAt > 30_000) close(id);
      if (input.now() - heard > 45000) ws.terminate();
      else if (ws.readyState === NodeWS.WebSocket.OPEN) ws.ping();
    },
    stop: () => {
      stopped = true;
      for (const stream of streams.values()) stream.socket?.destroy();
      streams.clear();
      ws.terminate();
    },
  };
}
