import { expect, it } from "vite-plus/test";
import { MuseAgentComputerStreamMailbox } from "./MuseAgentComputerStreamMailbox.ts";

it("delivers bounded bytes in arrival order and wakes a waiting reader", async () => {
  const box = new MuseAgentComputerStreamMailbox(),
    reader = box[Symbol.asyncIterator]();
  const waiting = reader.next();
  box.offer(new Uint8Array([82, 70, 66]));
  expect(await waiting).toEqual({ done: false, value: new Uint8Array([82, 70, 66]) });
  box.offer(new Uint8Array([1]));
  box.offer(new Uint8Array([2]));
  expect(await reader.next()).toEqual({ done: false, value: new Uint8Array([1]) });
  expect(await reader.next()).toEqual({ done: false, value: new Uint8Array([2]) });
  box.offer(new Uint8Array([3]));
  box.close();
  expect(await reader.next()).toEqual({ done: false, value: new Uint8Array([3]) });
  expect(await reader.next()).toEqual({ done: true, value: undefined });
});
it("fails the reader when aggregate bytes or frame count exceeds the native stream bound", async () => {
  const bytes = new MuseAgentComputerStreamMailbox();
  expect(bytes.offer(new Uint8Array(4 * 1024 * 1024))).toBe(true);
  expect(bytes.offer(new Uint8Array([1]))).toBe(false);
  bytes.close();
  await expect(bytes[Symbol.asyncIterator]().next()).rejects.toThrow(
    "Computer stream buffer exceeded.",
  );
  const frames = new MuseAgentComputerStreamMailbox();
  for (let n = 0; n < 256; n++) frames.offer(new Uint8Array([1]));
  expect(frames.offer(new Uint8Array([1]))).toBe(false);
  await expect(frames[Symbol.asyncIterator]().next()).rejects.toThrow(
    "Computer stream buffer exceeded.",
  );
});
