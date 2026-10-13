import { expect, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import { beforeEach, vi } from "vite-plus/test";
import { egressAllows, egressFrame, startEgressClient } from "./GrokBotEgressClient.ts";

const transport = vi.hoisted(() => ({
  sockets: [] as {
    emit: (event: string, ...args: unknown[]) => boolean;
    send: ReturnType<typeof vi.fn>;
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
    send = vi.fn();
    ping = vi.fn();
    terminate = vi.fn(() => {
      this.readyState = 3;
      this.emit("close", 1006);
    });
    constructor() {
      super();
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
const start = (egressPolicy: Parameters<typeof startEgressClient>[0]["policy"]) => {
  const client = startEgressClient({
    url: "wss://fixture.invalid",
    headers: {},
    policy: egressPolicy,
    now: () => 0,
    status: () => {},
  });
  return { client, socket: transport.sockets.at(-1)! };
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

it.each([
  [
    "private-service.example",
    5432,
    { ...policy, allowedTcpDestinations: [{ cidr: "10.0.0.0/8", port: 5432 }] },
  ],
  ["example.com", 443, policy],
  ["private-service.example", 5432, { ...policy, restricted: false }],
])(
  "connects to a policy-approved private destination %s:%s using its resolved address",
  async (host, port, egressPolicy) => {
    const { client, socket } = start(egressPolicy);
    const connected = Promise.withResolvers<unknown>();
    transport.lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    const tcp = Object.assign(new NodeEvents.EventEmitter(), {
      setTimeout: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    });
    transport.connect.mockImplementation((destination) => {
      connected.resolve(destination);
      return tcp;
    });
    try {
      socket.emit("message", openFrame(host, port), true);
      expect(await connected.promise).toEqual({ host: "10.1.2.3", port });
      expect(transport.lookup).toHaveBeenCalledExactlyOnceWith(host, { all: true });
      expect(transport.connect).toHaveBeenCalledOnce();
    } finally {
      client.stop();
    }
  },
);

it.each(["10.1.2.3", "8.8.9.8"])(
  "refuses a resolved destination %s outside the configured policy",
  async (address) => {
    const { client, socket } = start(policy);
    const closed = Promise.withResolvers<unknown>();
    socket.send.mockImplementation((frame) => closed.resolve(frame));
    transport.lookup.mockResolvedValue([{ address, family: 4 }]);
    try {
      socket.emit("message", openFrame("unlisted.example", 53), true);
      expect(await closed.promise).toEqual(Buffer.from([3, 0, 0, 0, 1]));
      expect(transport.connect).not.toHaveBeenCalled();
    } finally {
      client.stop();
    }
  },
);
