import { expect, it } from "@effect/vitest";
import { egressAllows, egressFrame } from "./GrokBotEgressClient.ts";
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
