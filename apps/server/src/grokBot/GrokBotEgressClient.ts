// @effect-diagnostics nodeBuiltinImport:off -- Native egress is a binary WebSocket-to-TCP adapter.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import { NodeWS } from "@effect/platform-node/NodeSocket";

export type EgressPolicy = {
  readonly restricted: boolean;
  readonly allowedDomains: readonly string[];
  readonly allowedTcpDestinations: readonly { readonly cidr: string; readonly port: number }[];
};
const domainMatches = (name: string, domain: string) => {
  const rule = domain.trim().toLowerCase().replace(/\.$/, "");
  return rule.length > 0 && (rule.startsWith("*.") ? name.endsWith(rule.slice(1)) : name === rule);
};
const ipv4 = (host: string) => host.split(".").reduce((a, n) => (a << 8) | Number(n), 0) >>> 0;
const cidr = (value: string) => {
  const [host, prefix = "32"] = value.split("/");
  const bits = Number(prefix);
  if (!host || NodeNet.isIP(host) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32)
    return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { bits, mask, network: (ipv4(host) & mask) >>> 0 };
};
/** Refreshes can remove permissions, but loosening requires a new account/box connection context. */
export function intersectEgressPolicies(current: EgressPolicy, next: EgressPolicy): EgressPolicy {
  if (!current.restricted) return next;
  if (!next.restricted) return current;
  const domainCovered = (domain: string, rules: readonly string[]) => {
    const name = domain.trim().toLowerCase().replace(/\.$/, "");
    return name.startsWith("*.")
      ? rules.some((rule) => {
          const normalized = rule.trim().toLowerCase().replace(/\.$/, "");
          return (
            normalized.startsWith("*.") &&
            (name === normalized || name.slice(2).endsWith(normalized.slice(1)))
          );
        })
      : rules.some((rule) => domainMatches(name, rule));
  };
  const tcpCovered = (
    destination: EgressPolicy["allowedTcpDestinations"][number],
    rules: EgressPolicy["allowedTcpDestinations"],
  ) => {
    const candidate = cidr(destination.cidr);
    return (
      candidate !== null &&
      rules.some((rule) => {
        const allowed = cidr(rule.cidr);
        return (
          rule.port === destination.port &&
          allowed !== null &&
          allowed.bits <= candidate.bits &&
          (candidate.network & allowed.mask) >>> 0 === allowed.network
        );
      })
    );
  };
  const domains = [
    ...next.allowedDomains.filter((rule) => domainCovered(rule, current.allowedDomains)),
    ...current.allowedDomains.filter((rule) => domainCovered(rule, next.allowedDomains)),
  ];
  const destinations = [
    ...next.allowedTcpDestinations.filter((rule) =>
      tcpCovered(rule, current.allowedTcpDestinations),
    ),
    ...current.allowedTcpDestinations.filter((rule) =>
      tcpCovered(rule, next.allowedTcpDestinations),
    ),
  ];
  return {
    restricted: true,
    allowedDomains: [...new Set(domains)],
    allowedTcpDestinations: [
      ...new Map(destinations.map((rule) => [`${rule.cidr}:${rule.port}`, rule])).values(),
    ],
  };
}
export function egressAllows(host: string, port: number, policy: EgressPolicy): boolean {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    host.length === 0 ||
    host.length > 253 ||
    !/^[a-z\d.:-]+$/i.test(host)
  )
    return false;
  if (!policy.restricted) return true;
  const name = host.toLowerCase().replace(/\.$/, "");
  if (
    (port === 80 || port === 443) &&
    policy.allowedDomains.some((domain) => domainMatches(name, domain))
  )
    return true;
  if (NodeNet.isIP(host) !== 4) return false;
  const value = ipv4(host);
  return policy.allowedTcpDestinations.some((rule) => {
    const allowed = cidr(rule.cidr);
    return (
      rule.port === port && allowed !== null && (value & allowed.mask) >>> 0 === allowed.network
    );
  });
}
function egressDecision(host: string, port: number, policy: EgressPolicy) {
  if (egressAllows(host, port, policy)) return "allow";
  if (
    port !== 80 &&
    port !== 443 &&
    NodeNet.isIP(host) === 0 &&
    policy.allowedTcpDestinations.some((rule) => rule.port === port)
  )
    return "recheck-after-resolve";
  return "refuse";
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

/** One transport attachment; its controller retains only confirmed ownership across recovery. */
export function startEgressClient(input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly policy: EgressPolicy;
  readonly now: () => number;
  readonly attachMode?: "if-free" | "claim";
  readonly clientId?: string;
  readonly ownership?: { generation: string | null };
  readonly opened?: () => void;
  readonly disconnected?: (state: "standby" | "error") => void;
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
  let attachGeneration: string | null = null;
  let confirmed = false;
  const streams = new Map<
    number,
    { socket?: NodeNet.Socket; pending: Buffer[]; bytes: number; ended: boolean; openedAt: number }
  >();
  const resumeDrainedStreams = () => {
    if (ws.bufferedAmount > MAX_BUFFER) return;
    for (const stream of streams.values()) if (stream.socket?.isPaused()) stream.socket.resume();
  };
  const ws = new NodeWS.WebSocket(input.url, {
    headers: {
      ...input.headers,
      "x-sand-egress-attach": input.attachMode ?? "if-free",
      ...(input.clientId === undefined ? {} : { "x-sand-egress-client": input.clientId }),
      ...(input.attachMode !== "claim" && input.ownership?.generation != null
        ? { "x-sand-egress-if-match": input.ownership.generation }
        : {}),
    },
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
    const decision = egressDecision(host, port, input.policy);
    if (decision === "refuse") {
      send(closeFrame(id));
      return;
    }
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
      // Resolve once and connect to that exact policy-approved address, preventing DNS rebinding.
      const addresses = await NodeDnsPromises.lookup(host, { all: true });
      const address = addresses.find(
        (entry) => decision === "allow" || egressAllows(entry.address, port, input.policy),
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
  ws.on("upgrade", (response) => {
    if (stopped) return;
    const value = response.headers["x-sand-egress-attach-gen"];
    attachGeneration = typeof value === "string" && /^\d{1,20}$/.test(value) ? value : null;
  });
  ws.on("open", () => {
    if (stopped) return;
    heard = input.now();
    input.opened?.();
    ws.ping();
  });
  const alive = () => {
    if (stopped) return;
    heard = input.now();
    if (!confirmed) {
      confirmed = true;
      if (input.ownership) input.ownership.generation = attachGeneration;
    }
    state = "connected";
    publish();
  };
  ws.on("ping", alive);
  ws.on("pong", alive);
  ws.on("message", (data, binary) => {
    if (stopped) return;
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
    if (response.statusCode === 409 && input.ownership) input.ownership.generation = null;
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
      if (state === "standby" && input.ownership) input.ownership.generation = null;
      publish();
      input.disconnected?.(state);
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
