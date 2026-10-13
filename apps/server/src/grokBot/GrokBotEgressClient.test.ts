import { expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";
import * as NodeEvents from "node:events";
import {
  egressAllows,
  egressFrame,
  intersectEgressPolicies,
  startEgressClient,
} from "./GrokBotEgressClient.ts";

const transport = vi.hoisted(() => ({
  sockets: [] as {
    emit: (event: string, ...args: unknown[]) => boolean;
    headers: Record<string, string>;
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }[],
  lookup: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: transport.lookup }));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  createConnection: transport.connect,
}));
vi.mock("@effect/platform-node/NodeSocket", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    bufferedAmount = 0;
    headers: Record<string, string>;
    send = vi.fn();
    ping = vi.fn();
    terminate = vi.fn(() => {
      this.readyState = 3;
      this.emit("close", 1006);
    });
    constructor(_url: string, options: { headers: Record<string, string> }) {
      super();
      this.headers = options.headers;
      transport.sockets.push(this);
    }
  }
  return { NodeWS: { WebSocket: Socket } };
});
beforeEach(() => {
  transport.sockets.length = 0;
  transport.lookup.mockReset();
  transport.connect.mockReset();
});

const openFrame = (host: string, port: number) => {
  const frame = Buffer.alloc(7 + Buffer.byteLength(host));
  frame[0] = 1;
  frame.writeUInt32BE(1, 1);
  frame.writeUInt16BE(port, 5);
  frame.write(host, 7);
  return frame;
};
const start = (options: Partial<Parameters<typeof startEgressClient>[0]> = {}) => {
  const client = startEgressClient({
    url: "wss://fixture.invalid",
    headers: {},
    policy,
    now: () => 0,
    status: () => {},
    ...options,
  });
  const socket = transport.sockets.at(-1)!;
  return { client, socket };
};
const policy = {
  restricted: true,
  allowedDomains: ["example.com", "*.allowed.example"],
  allowedTcpDestinations: [{ cidr: "8.8.8.0/24", port: 53 }],
};
it("enforces the native domain and TCP policy", () => {
  expect(egressAllows("example.com", 443, policy)).toBe(true);
  expect(egressAllows("sub.allowed.example", 80, policy)).toBe(true);
  expect(egressAllows("allowed.example", 443, policy)).toBe(false);
  expect(egressAllows("notexample.com", 443, policy)).toBe(false);
  expect(egressAllows("example.com", 22, policy)).toBe(false);
  expect(egressAllows("8.8.8.8", 53, policy)).toBe(true);
  expect(egressAllows("8.8.9.8", 53, policy)).toBe(false);
  expect(egressAllows("example.com", 65536, { ...policy, restricted: false })).toBe(false);
});
it("decodes native open/data/close frames and refuses short frames", () => {
  const open = Buffer.alloc(18);
  open[0] = 1;
  open.writeUInt32BE(10, 1);
  open.writeUInt16BE(443, 5);
  open.write("example.com", 7);
  expect(egressFrame(open)).toEqual({ kind: "open", id: 10, port: 443, host: "example.com" });
  const data = Buffer.from([2, 0, 0, 0, 10, 65]);
  expect(egressFrame(data)).toEqual({ kind: "data", id: 10, data: Buffer.from([65]) });
  expect(egressFrame(Buffer.from([3, 0, 0, 0, 10]))).toEqual({ kind: "close", id: 10 });
  expect(egressFrame(Buffer.from([1, 0, 0, 0, 10]))).toBeNull();
  expect(egressFrame(Buffer.from([9, 0, 0, 0, 10]))).toBeNull();
});

it("refuses unlisted HTTP domains before DNS even when their IP has an allowed CIDR", () => {
  const { client, socket } = start({
    policy: {
      ...policy,
      allowedTcpDestinations: [{ cidr: "8.8.8.8/32", port: 443 }],
    },
  });
  transport.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  socket.emit("message", openFrame("unlisted.example", 443), true);
  expect(transport.lookup).not.toHaveBeenCalled();
  expect(transport.connect).not.toHaveBeenCalled();
  expect(socket.send).toHaveBeenCalledWith(Buffer.from([3, 0, 0, 0, 1]));
  client.stop();
});

it.each([
  ["unlisted.example", 53],
  ["8.8.8.8", 53],
  ["example.com", 443],
])("resolves %s:%s once and connects to the exact allowed public address", async (host, port) => {
  const { client, socket } = start();
  const connected = Promise.withResolvers<unknown>();
  transport.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  const tcp = Object.assign(new NodeEvents.EventEmitter(), {
    setTimeout: vi.fn(),
    write: vi.fn(),
    destroy: vi.fn(),
  });
  transport.connect.mockImplementation((destination) => {
    connected.resolve(destination);
    return tcp;
  });
  socket.emit("message", openFrame(host, port), true);
  expect(await connected.promise).toEqual({ host: "8.8.8.8", port });
  expect(transport.lookup).toHaveBeenCalledExactlyOnceWith(host, { all: true });
  client.stop();
});

it.each(["127.0.0.1", "8.8.9.8"])(
  "refuses a resolved private or disallowed TCP address %s",
  async (address) => {
    const { client, socket } = start();
    const closed = Promise.withResolvers<unknown>();
    socket.send.mockImplementation((frame) => closed.resolve(frame));
    transport.lookup.mockResolvedValue([{ address, family: 4 }]);
    socket.emit("message", openFrame("unlisted.example", 53), true);
    expect(await closed.promise).toEqual(Buffer.from([3, 0, 0, 0, 1]));
    expect(transport.connect).not.toHaveBeenCalled();
    client.stop();
  },
);

it("intersects simultaneous domain/CIDR additions and removals, including nested rules", () => {
  const effective = intersectEgressPolicies(
    {
      restricted: true,
      allowedDomains: ["*.example.com", "removed.example"],
      allowedTcpDestinations: [
        { cidr: "8.8.0.0/16", port: 53 },
        { cidr: "9.9.9.0/24", port: 53 },
      ],
    },
    {
      restricted: true,
      allowedDomains: ["*.sub.example.com", "added.example"],
      allowedTcpDestinations: [
        { cidr: "8.8.8.0/24", port: 53 },
        { cidr: "1.1.1.0/24", port: 53 },
      ],
    },
  );
  expect(egressAllows("a.sub.example.com", 443, effective)).toBe(true);
  for (const host of ["a.example.com", "removed.example", "added.example"])
    expect(egressAllows(host, 443, effective)).toBe(false);
  expect(egressAllows("8.8.8.8", 53, effective)).toBe(true);
  for (const host of ["8.8.9.8", "9.9.9.9", "1.1.1.1"])
    expect(egressAllows(host, 53, effective)).toBe(false);
  const widened = intersectEgressPolicies(effective, {
    restricted: true,
    allowedDomains: ["*.example.com"],
    allowedTcpDestinations: [{ cidr: "8.8.0.0/16", port: 53 }],
  });
  expect(widened).toEqual(effective);
  expect(intersectEgressPolicies(effective, { ...effective, restricted: false })).toEqual(
    effective,
  );
});

it.each(["1", "12345678901234567890", "", "1e2", "-1", "1.5", "123456789012345678901", ["1"]])(
  "retains only a validated, confirmed attachment generation %j",
  (generation) => {
    const ownership = { generation: null as string | null };
    const { client, socket } = start({ clientId: "fixture-client", ownership });
    socket.emit("upgrade", { headers: { "x-sand-egress-attach-gen": generation } });
    socket.emit("open");
    expect(ownership.generation).toBeNull();
    socket.emit("pong");
    const valid = typeof generation === "string" && /^\d{1,20}$/.test(generation);
    expect(ownership.generation).toBe(valid ? generation : null);
    client.stop();
    const recovered = start({ clientId: "fixture-client", ownership });
    expect(recovered.socket.headers["x-sand-egress-client"]).toBe("fixture-client");
    expect(recovered.socket.headers["x-sand-egress-if-match"]).toBe(valid ? generation : undefined);
    recovered.client.stop();
  },
);

it.each([409, 4001, 4002])(
  "clears confirmed ownership after occupied/replaced response %s",
  (code) => {
    const ownership = { generation: "7" as string | null };
    const { client, socket } = start({ ownership });
    if (code === 409) socket.emit("unexpected-response", {}, { statusCode: code });
    else socket.emit("close", code);
    expect(ownership.generation).toBeNull();
    client.stop();
  },
);

it("keeps reclaim state after a stale link, ignores retired events, and omits if-match on claim", () => {
  let now = 0;
  const ownership = { generation: null as string | null };
  const { client, socket } = start({ ownership, now: () => now });
  socket.emit("upgrade", { headers: { "x-sand-egress-attach-gen": "8" } });
  socket.emit("pong");
  now = 46_000;
  client.heartbeat();
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(ownership.generation).toBe("8");
  client.stop();
  socket.emit("upgrade", { headers: { "x-sand-egress-attach-gen": "9" } });
  socket.emit("pong");
  socket.emit("close", 4001);
  expect(ownership.generation).toBe("8");
  const claimed = start({ attachMode: "claim", ownership });
  expect(claimed.socket.headers["x-sand-egress-attach"]).toBe("claim");
  expect(claimed.socket.headers["x-sand-egress-if-match"]).toBeUndefined();
  claimed.client.stop();
});
