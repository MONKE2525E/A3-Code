// @effect-diagnostics nodeBuiltinImport:off -- Real loopback requests exercise the HTTP callback boundary.
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import { startLoopbackListener } from "./GrokBotOAuthLoopback.ts";

const requestStatus = (port: number, path: string) =>
  new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request({ hostname: "127.0.0.1", port, path }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end();
  });

it("rejects malformed request URLs and keeps serving OAuth callbacks", async () => {
  let calls = 0;
  const listener = await startLoopbackListener({
    ports: [0],
    handle: async () => {
      calls++;
      return true;
    },
  });
  assert.isNotNull(listener);
  if (listener === null) throw new Error("Expected a loopback listener.");
  try {
    assert.strictEqual(await requestStatus(listener.port, "http://["), 400);
    assert.strictEqual(calls, 0);
    assert.strictEqual(
      await requestStatus(listener.port, "/callback?state=fixture&code=fixture"),
      200,
    );
    assert.strictEqual(calls, 1);
  } finally {
    await listener.close();
  }
});

it("contains synchronous and asynchronous callback failures", async () => {
  let calls = 0;
  const listener = await startLoopbackListener({
    ports: [0],
    handle: () => {
      calls++;
      if (calls === 1) throw new Error("private-sentinel");
      if (calls === 2) return Promise.reject(new Error("private-sentinel"));
      return Promise.resolve(true);
    },
  });
  assert.isNotNull(listener);
  if (listener === null) throw new Error("Expected a loopback listener.");
  try {
    assert.strictEqual(
      await requestStatus(listener.port, "/callback?state=fixture&code=fixture"),
      400,
    );
    assert.strictEqual(
      await requestStatus(listener.port, "/callback?state=fixture&code=fixture"),
      400,
    );
    assert.strictEqual(
      await requestStatus(listener.port, "/callback?state=fixture&code=fixture"),
      200,
    );
  } finally {
    await listener.close();
  }
});
