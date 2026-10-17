import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { museAgentBrowserBridge } from "./MuseAgentBrowserBridge.ts";
import { MUSE_AGENT_AVATAR_MAX_BYTES } from "./MuseAgentAvatar.ts";

type Params = Record<string, unknown>;
interface Bridge {
  authority(): string;
  observeDisconnect(input: Params): void;
  connectionId(input: Params): string;
  watch(input: Params): Promise<unknown>;
  request(input: Params): Promise<unknown>;
  cancelOwned(input: Params): Promise<void>;
  releaseOwned(input: Params): Promise<void>;
  register(input: Params): Promise<unknown>;
  unregister(input: Params): Promise<void>;
  readAvatar(input: Params): Promise<{ base64: string; contentType: string }>;
  readComputerPreview(input: Params): Promise<{ base64: string; contentType: string }>;
  openComputerStream(input: Params): Promise<unknown>;
  sendComputerStream(input: Params): Promise<unknown>;
  closeComputerStream(input: Params): void;
}

const fixture = () => {
  const handlers = new Map<string, (payload: Params, meta: Params) => void>();
  const invokes = new Map<string, (payload: Params, meta: Params) => Promise<void>>();
  const calls: { method: string; params: Params; options: Params }[] = [];
  let blob: unknown = new Blob(["synthetic-avatar"], { type: "image/webp" });
  let computerState: Params = {
    session_id: "worker",
    presented_task_id: "task",
    lease: {
      control_owner: "user",
      task_id: "task",
      takeover_id: "takeover",
      control_expires_at_ms: 4102444800000,
    },
  };
  const send = vi.fn(async (method: string, params: Params, options: Params) => {
    calls.push({ method, params, options });
    if (method === "chat.subscribe") return { session_id: params.session_id };
    if (method === "chat.stream")
      return {
        session_id: params.session_id,
        message_id: "user-1",
        reply_to_message_id: "carrier-1",
      };
    if (method === "chat.cancel") return { cancelled: true };
    if (method === "fs.raw" || method === "computer.preview") return blob;
    if (method === "browser_task.get") return computerState;
    if (method === "client.register_capabilities")
      return {
        accepted_device_commands: Object.keys(
          (params.capabilities as { device_commands: Params }).device_commands,
        ).length,
        rejected_ids: [],
      };
    return {};
  });
  const rpc = {
    isReady: true,
    connectionAuthority: { targetKey: "synthetic-target" },
    gatewayScopeKey: "synthetic-scope",
    gatewayUrl: "https://gateway.invalid",
    vmName: "synthetic-vm",
    sendRequest: send,
    onEvent: (name: string, handler: (payload: Params, meta: Params) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    onClientInvoke: (name: string, handler: (payload: Params, meta: Params) => Promise<void>) => {
      invokes.set(name, handler);
      return () => invokes.delete(name);
    },
  };
  const value = { isAuthenticated: true, userId: "synthetic-account" };
  const fiber = { memoizedProps: { value: rpc }, child: { memoizedProps: { value } } };
  const hostRoot = { child: fiber, stateNode: { current: { child: fiber } } };
  const events: Params[] = [];
  const invoke = vi.fn(async (input: Params) => ({
    method: "client.invoke.result",
    params: { invoke_id: (input.payload as Params).invoke_id, ok: true, payload_json: "{}" },
    options: { expectedConnectionId: input.connectionId },
  }));
  const window: {
    __t3Muse?: Bridge;
    __t3MuseEvent: (value: Params) => Promise<void>;
    __t3MuseInvoke: typeof invoke;
    __t3MuseNativeComputerStream?: (input: Params) => {
      connect: () => Promise<typeof socket>;
      teardown: () => void;
    };
    __t3MuseComputerStreamEvent: (input: Params) => Promise<void>;
  } = {
    __t3MuseEvent: async (event) => {
      events.push(event);
    },
    __t3MuseInvoke: invoke,
    __t3MuseComputerStreamEvent: async (event) => {
      computerEvents.push(event);
    },
  };
  const computerEvents: Params[] = [],
    computerConnections: Params[] = [],
    computerSends: Uint8Array[] = [];
  let computerClosed = 0;
  const socket: {
    onmessage: ((event: { data: ArrayBuffer }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    send: (data: Uint8Array) => void;
  } = {
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => {
      computerSends.push(data);
    },
  };
  window.__t3MuseNativeComputerStream = (input) => {
    computerConnections.push(input);
    return {
      connect: async () => socket,
      teardown: () => {
        computerClosed++;
      },
    };
  };
  let tick: (() => Promise<void>) | undefined;
  let generation = 0;
  let now = 30000;
  NodeVM.runInNewContext(museAgentBrowserBridge, {
    location: { origin: "https://muse.ai" },
    document: { querySelectorAll: () => [{ __reactFiber$fixture: hostRoot }] },
    window,
    crypto: { randomUUID: () => `generation-${++generation}` },
    Blob,
    Uint8Array,
    ArrayBuffer,
    AbortController,
    btoa,
    atob,
    Date: { now: () => now },
    setInterval: (fn: () => Promise<void>) => {
      tick = fn;
    },
  });
  const bridge = window.__t3Muse!;
  const authority = bridge.authority();
  return {
    bridge,
    authority,
    rpc,
    value,
    handlers,
    invokes,
    calls,
    events,
    invoke,
    send,
    computerEvents,
    computerConnections,
    computerSends,
    socket,
    computerClosed: () => computerClosed,
    setComputerState: (value: Params) => {
      computerState = value;
    },
    removeComputerConstructor: () => {
      delete window.__t3MuseNativeComputerStream;
    },
    tick: () => tick!(),
    advanceTime: (milliseconds: number) => {
      now += milliseconds;
    },
    setBlob: (next: unknown) => {
      blob = next;
    },
    setAttachedReadiness: (isReady: boolean) => {
      hostRoot.child = { ...fiber, memoizedProps: { value: { ...rpc, isReady } } };
    },
    setCommittedAccount: (userId: string) => {
      hostRoot.stateNode.current = {
        child: { ...fiber, child: { memoizedProps: { value: { ...value, userId } } } },
      };
    },
    emit: (event: string, payload: Params, seq = 1, time = 1234) =>
      handlers.get(event)?.(payload, {
        seq,
        ts_ms: time,
        websocketConnectionID: "physical-1",
      }),
  };
};

it("releases only the exact local admission without cancelling or clearing a newer delivery", async () => {
  const f = fixture();
  await f.bridge.watch({ authority: f.authority, session: "primary" });
  const receipt = { sessionId: "primary", messageId: "user-1", replyToMessageId: "carrier-1" };
  await f.bridge.request({
    authority: f.authority,
    method: "chat.stream",
    params: { session_id: "primary" },
    deliveryKey: "old-attempt",
  });
  await expect(
    f.bridge.releaseOwned({
      authority: f.authority,
      session: "primary",
      deliveryKey: "foreign-attempt",
      receipt,
    }),
  ).rejects.toThrow("release_scope_changed");
  await expect(
    f.bridge.request({
      authority: f.authority,
      method: "chat.stream",
      params: { session_id: "primary" },
      deliveryKey: "new-attempt",
    }),
  ).rejects.toThrow("owned_session_busy");
  await f.bridge.releaseOwned({
    authority: f.authority,
    session: "primary",
    deliveryKey: "old-attempt",
    receipt,
  });
  await f.bridge.request({
    authority: f.authority,
    method: "chat.stream",
    params: { session_id: "primary" },
    deliveryKey: "new-attempt",
  });
  await f.bridge.releaseOwned({
    authority: f.authority,
    session: "primary",
    deliveryKey: "old-attempt",
    receipt,
  });
  await expect(
    f.bridge.request({
      authority: f.authority,
      method: "chat.stream",
      params: { session_id: "primary" },
      deliveryKey: "third-attempt",
    }),
  ).rejects.toThrow("owned_session_busy");
  expect(f.calls.filter((call) => call.method === "chat.cancel")).toHaveLength(0);
});

it("does not resurrect released local ownership when a pending acknowledgement arrives late", async () => {
  const f = fixture();
  await f.bridge.watch({ authority: f.authority, session: "primary" });
  let acknowledge: (value: unknown) => void = () => {};
  f.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const first = f.bridge.request({
    authority: f.authority,
    method: "chat.stream",
    params: { session_id: "primary" },
    deliveryKey: "released-attempt",
  });
  await f.bridge.releaseOwned({
    authority: f.authority,
    session: "primary",
    deliveryKey: "released-attempt",
    receipt: null,
  });
  await f.bridge.request({
    authority: f.authority,
    method: "chat.stream",
    params: { session_id: "primary" },
    deliveryKey: "new-attempt",
  });
  acknowledge({
    session_id: "primary",
    message_id: "late-user",
    reply_to_message_id: "late-carrier",
  });
  await first;
  await expect(
    f.bridge.releaseOwned({
      authority: f.authority,
      session: "primary",
      deliveryKey: "new-attempt",
      receipt: { sessionId: "primary", messageId: "late-user", replyToMessageId: "late-carrier" },
    }),
  ).rejects.toThrow("release_scope_changed");
  await f.bridge.releaseOwned({
    authority: f.authority,
    session: "primary",
    deliveryKey: "new-attempt",
    receipt: { sessionId: "primary", messageId: "user-1", replyToMessageId: "carrier-1" },
  });
  expect(f.calls.filter((call) => call.method === "chat.cancel")).toHaveLength(0);
});

it("observes the hosted primary subscription without replacing its native stream", async () => {
  const f = fixture();
  expect(await f.bridge.watch({ authority: f.authority, session: "primary" })).toEqual({
    session_id: "primary",
  });
  expect(f.calls.some((call) => call.method === "chat.subscribe")).toBe(false);
  f.emit("delta.message_start", { session_id: "primary", message_id: "native-assistant" });
  expect(f.events).toHaveLength(1);
});

it("observes native file presentations and retires owned cancellation after root completion", async () => {
  const f = fixture();
  await admission(f);
  f.emit(
    "task.status",
    {
      session_id: "primary",
      task_id: "root-task",
      agent_id: "root-task",
      root_agent_id: "root-task",
      active_subagent_count: 0,
      status: "running",
    },
    2,
    1300,
  );
  f.emit(
    "delta.presentation",
    {
      session_id: "primary",
      message_id: "presentation-1",
      host_message_id: "assistant-file",
      agent_id: "root-task",
      kind: "file",
      data: {
        file: { path: "sandbox://workspace/user/report.txt", label: "Report", missing: false },
      },
    },
    3,
    1400,
  );
  expect(f.events.some((event) => event.event === "delta.presentation")).toBe(true);
  f.emit(
    "task.status",
    {
      session_id: "primary",
      task_id: "root-task",
      agent_id: "root-task",
      root_agent_id: "root-task",
      active_subagent_count: 0,
      status: "completed",
    },
    4,
    1500,
  );
  await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
    "turn_not_owned",
  );
});

it("heartbeats a registered device and stops renewing it after native removal", async () => {
  const f = fixture();
  await f.bridge.watch({ authority: f.authority, session: "primary" });
  const connectionId = f.bridge.connectionId({ authority: f.authority });
  await f.bridge.register({
    authority: f.authority,
    clientId: "device-uuid",
    nativeSessionId: "primary",
    connectionId,
    commands: { "t3.probe": {} },
  });
  expect(
    f.calls.filter((call) => call.method === "node.heartbeat").map((call) => call.params),
  ).toEqual([{ node_id: "device-uuid" }]);
  await f.bridge.unregister({ authority: f.authority, clientId: "device-uuid", connectionId });
  await f.tick();
  expect(f.calls.filter((call) => call.method === "node.heartbeat")).toHaveLength(1);
});

it("reattaches after a failed heartbeat on an otherwise unchanged native connection", async () => {
  const f = fixture();
  await admission(f);
  const before = f.bridge.connectionId({ authority: f.authority });
  const registration = {
    authority: f.authority,
    clientId: "device-uuid",
    nativeSessionId: "primary",
    connectionId: before,
    commands: { "t3.probe": {} },
  };
  await f.bridge.register(registration);
  f.advanceTime(15000);
  f.send.mockRejectedValueOnce(new Error("temporary heartbeat failure"));
  await f.tick();
  expect(f.invokes.size).toBe(0);
  expect(f.events.at(-1)?.event).toBe("transport.disconnected");

  await f.tick();
  expect(f.events.at(-1)?.event).toBe("transport.reconnected");
  const after = f.bridge.connectionId({ authority: f.authority });
  expect(after).not.toBe(before);
  await expect(f.bridge.register(registration)).rejects.toThrow("registration_scope_changed");
  await f.bridge.register({ ...registration, connectionId: after });
  expect(f.invokes.size).toBe(1);
  await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
    "turn_not_owned",
  );
  expect(f.calls.filter((call) => call.method === "chat.stream")).toHaveLength(1);
  expect(f.calls.filter((call) => call.method === "chat.subscribe")).toHaveLength(0);
});

it("does not disconnect a replacement registration when an older heartbeat fails", async () => {
  const f = fixture();
  await f.bridge.watch({ authority: f.authority, session: "primary" });
  const connectionId = f.bridge.connectionId({ authority: f.authority });
  const registration = {
    authority: f.authority,
    clientId: "device-uuid",
    nativeSessionId: "primary",
    connectionId,
    commands: { "t3.probe": {} },
  };
  await f.bridge.register(registration);
  const heartbeat = Promise.withResolvers<void>();
  f.send.mockImplementationOnce(async () => {
    await heartbeat.promise;
    return {};
  });
  f.advanceTime(15000);
  const pendingTick = f.tick();
  await f.bridge.unregister({ authority: f.authority, clientId: "device-uuid", connectionId });
  await f.bridge.register(registration);
  heartbeat.reject(new Error("old heartbeat failure"));
  await pendingTick;
  expect(f.invokes.size).toBe(1);
  expect(f.bridge.connectionId({ authority: f.authority })).toBe(connectionId);
  expect(f.events.some((event) => event.event === "transport.disconnected")).toBe(false);
});
const receipt = { sessionId: "primary", messageId: "user-1", replyToMessageId: "carrier-1" };
const admission = async (f: ReturnType<typeof fixture>) => {
  await f.bridge.watch({ authority: f.authority, session: "primary" });
  await f.bridge.request({
    authority: f.authority,
    method: "chat.stream",
    params: { session_id: "primary", items: [{ type: "text", text: "Synthetic task" }] },
  });
  f.emit("message.user", {
    session_id: "primary",
    message_id: receipt.messageId,
    parent_agent_id: "root-task",
  });
};

it("recovers a host-observed readiness gap between interval ticks through the real bridge loop", async () => {
  const f = fixture();
  await admission(f);
  const before = f.bridge.connectionId({ authority: f.authority });
  await f.bridge.register({
    authority: f.authority,
    clientId: "device-before-gap",
    nativeSessionId: "primary",
    connectionId: before,
    commands: { "t3.probe": {} },
  });
  f.rpc.isReady = false;
  expect(f.bridge.authority()).toBeNull();
  f.bridge.observeDisconnect({ authority: f.authority });
  f.emit("delta.turn_done", {
    session_id: "primary",
    reply_to_message_id: "user-1",
    status: "completed",
  });
  expect(f.events.filter((event) => event.event === "delta.turn_done")).toHaveLength(0);
  expect(f.invokes.size).toBe(0);
  f.rpc.isReady = true;
  await f.tick();
  expect(f.events.some((event) => event.event === "transport.reconnected")).toBe(true);
  expect(f.bridge.connectionId({ authority: f.authority })).not.toBe(before);
  f.emit("delta.turn_done", {
    session_id: "primary",
    reply_to_message_id: "user-1",
    status: "completed",
  });
  expect(f.events.filter((event) => event.event === "delta.turn_done")).toHaveLength(1);
  expect(f.invokes.size).toBe(0);
  expect(f.calls.filter((call) => call.method === "chat.stream")).toHaveLength(1);
  expect(f.calls.filter((call) => call.method === "chat.subscribe")).toHaveLength(0);
});

it("never recovers a host-observed gap into a different committed account", async () => {
  const f = fixture();
  await admission(f);
  f.rpc.isReady = false;
  f.bridge.observeDisconnect({ authority: f.authority });
  f.setCommittedAccount("foreign-account");
  f.rpc.isReady = true;
  await f.tick();
  f.emit("delta.turn_done", {
    session_id: "primary",
    reply_to_message_id: "user-1",
    status: "completed",
  });
  expect(f.events.some((event) => event.event === "transport.reconnected")).toBe(false);
  expect(f.events.filter((event) => event.event === "delta.turn_done")).toHaveLength(0);
  expect(() => f.bridge.connectionId({ authority: f.authority })).toThrow("account_changed");
});

describe("native root task ownership", () => {
  const rootTask = (status: string) => ({
    session_id: "primary",
    task_id: "root-task",
    agent_id: "root-task",
    root_agent_id: "root-task",
    active_subagent_count: 0,
    status,
  });
  const answer = {
    session_id: "primary",
    message_id: "native-answer",
    agent_id: "root-task",
    reply_to_message_id: "",
  };

  it("retires stop authority after root completion and canonical answer in either order", async () => {
    for (const terminalFirst of [false, true]) {
      const f = fixture();
      await admission(f);
      f.emit("task.status", rootTask("running"), 2, 1300);
      if (terminalFirst) f.emit("task.status", rootTask("completed"), 4, 1500);
      else f.emit("delta.message_done", answer, 3, 1400);
      await f.bridge.cancelOwned({ authority: f.authority, receipt });
      if (terminalFirst) f.emit("delta.message_done", answer, 5, 1600);
      else f.emit("task.status", rootTask("completed"), 4, 1500);
      await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
        "turn_not_owned",
      );
    }
  });

  it("handles running before user and ignores older history without accepting a foreign root", async () => {
    const f = fixture();
    await f.bridge.watch({ authority: f.authority, session: "primary" });
    await f.bridge.request({
      authority: f.authority,
      method: "chat.stream",
      params: { session_id: "primary" },
    });
    f.emit("task.status", rootTask("running"), 5, 1300);
    f.emit("message.user", { session_id: "primary", message_id: "old-user" }, 1, 900);
    f.emit(
      "message.user",
      { session_id: "primary", message_id: receipt.messageId, parent_agent_id: "root-task" },
      2,
      1200,
    );
    f.emit("task.status", { ...rootTask("completed"), agent_id: "child" }, 6, 1400);
    f.emit("delta.message_done", answer, 7, 1450);
    await f.bridge.cancelOwned({ authority: f.authority, receipt });
    f.emit("task.status", rootTask("completed"), 8, 1500);
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
      "turn_not_owned",
    );
  });

  it("fails cancellation safely while a foreign user precedes an unknown owned boundary", async () => {
    const f = fixture();
    await f.bridge.watch({ authority: f.authority, session: "primary" });
    await f.bridge.request({
      authority: f.authority,
      method: "chat.stream",
      params: { session_id: "primary" },
    });
    f.emit("message.user", { session_id: "primary", message_id: "foreign-user" }, 3, 1400);
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
      "turn_not_owned",
    );
    f.emit(
      "message.user",
      { session_id: "primary", message_id: receipt.messageId, parent_agent_id: "root-task" },
      2,
      1200,
    );
    expect(f.events.find((event) => event.event === "transport.turn_superseded")).toEqual({
      event: "transport.turn_superseded",
      authority: f.authority,
      payload: {
        session_id: receipt.sessionId,
        message_id: receipt.messageId,
        reply_to_message_id: receipt.replyToMessageId,
      },
    });
    expect(f.calls.some((call) => call.method === "chat.cancel")).toBe(false);
  });
});

describe("owned native cancellation", () => {
  it("refuses cancellation on an unseen physical reconnect before another native event", async () => {
    const f = fixture();
    await admission(f);
    const original = f.send.getMockImplementation()!;
    let cancellations = 0;
    // Muse's runtime callback and target remain stable when only its socket changes.
    f.send.mockImplementation(async (method, params, options) => {
      if (method === "chat.cancel") {
        if (
          options.expectedConnectionId !== undefined &&
          options.expectedConnectionId !== "physical-2"
        )
          throw new Error("gateway_target_changed");
        cancellations++;
      }
      return original(method, params, options);
    });
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow();
    expect(cancellations).toBe(0);
  });

  it("requires trusted physical connection metadata before cancelling", async () => {
    const f = fixture();
    await f.bridge.watch({ authority: f.authority, session: "primary" });
    await f.bridge.request({
      authority: f.authority,
      method: "chat.stream",
      params: { session_id: "primary" },
    });
    f.handlers.get("message.user")?.(
      { session_id: "primary", message_id: receipt.messageId },
      { seq: 1, ts_ms: 1234 },
    );
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
      "turn_not_owned",
    );
    expect(f.calls.some((call) => call.method === "chat.cancel")).toBe(false);
  });

  it("cancels only the exact admitted turn, and acknowledgement never produces terminal", async () => {
    const f = fixture();
    await admission(f);
    await expect(
      f.bridge.cancelOwned({ authority: f.authority, receipt: { ...receipt, messageId: "other" } }),
    ).rejects.toThrow("turn_not_owned");
    await f.bridge.cancelOwned({ authority: f.authority, receipt });
    expect(f.calls.filter((call) => call.method === "chat.cancel")).toHaveLength(1);
    expect(
      f.calls.find((call) => call.method === "chat.cancel")?.options.expectedConnectionId,
    ).toBe("physical-1");
    expect(f.events.filter((event) => event.event === "delta.turn_done")).toHaveLength(0);
    f.emit("delta.turn_done", {
      session_id: "primary",
      reply_to_message_id: "user-1",
      status: "cancelled",
    });
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
      "turn_not_owned",
    );
  });
  it("refuses cancellation after a replacement user turn or reconnect", async () => {
    const f = fixture();
    await admission(f);
    f.emit("message.user", { session_id: "primary", message_id: "another-user-turn" });
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
      "turn_not_owned",
    );
    await f.bridge.request({
      authority: f.authority,
      method: "chat.stream",
      params: { session_id: "primary" },
    });
    f.rpc.isReady = false;
    await f.tick();
    f.rpc.isReady = true;
    await f.tick();
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
      "turn_not_owned",
    );
    expect(f.calls.some((call) => call.method === "chat.cancel")).toBe(false);
  });
  it("accounts for native completion arriving before admission returns", async () => {
    const f = fixture();
    await f.bridge.watch({ authority: f.authority, session: "primary" });
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params, options) => {
      if (method === "chat.stream")
        f.emit("delta.turn_done", {
          session_id: "primary",
          reply_to_message_id: "user-1",
          status: "completed",
        });
      return original(method, params, options);
    });
    await f.bridge.request({
      authority: f.authority,
      method: "chat.stream",
      params: { session_id: "primary" },
    });
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
      "turn_not_owned",
    );
  });
});

describe("native direct tool callbacks", () => {
  it("removes handlers and advertisements when native capability acceptance is rejected", async () => {
    const f = fixture();
    await f.bridge.watch({ authority: f.authority, session: "primary" });
    const connectionId = f.bridge.connectionId({ authority: f.authority });
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params, options) => {
      if (
        method === "client.register_capabilities" &&
        Object.keys((params.capabilities as { device_commands: Params }).device_commands).length
      )
        return { accepted_device_commands: 0, rejected_ids: ["t3.probe"] };
      return original(method, params, options);
    });
    await expect(
      f.bridge.register({
        authority: f.authority,
        clientId: "t3-turn",
        nativeSessionId: "primary",
        connectionId,
        commands: { "t3.probe": {} },
      }),
    ).rejects.toThrow("capabilities_rejected");
    expect(f.invokes.size).toBe(0);
    const last = f.calls.at(-1);
    expect(last).toBeDefined();
    expect((last!.params.capabilities as { device_commands: Params }).device_commands).toEqual({});
  });
  it("keeps stable target identity separate from React object identity", async () => {
    const f = fixture();
    await f.bridge.watch({ authority: f.authority, session: "primary" });
    const before = f.bridge.connectionId({ authority: f.authority });
    f.rpc.connectionAuthority = { targetKey: "synthetic-target" };
    await f.tick();
    expect(f.bridge.connectionId({ authority: f.authority })).toBe(before);
    expect(f.events.some((event) => event.event === "transport.disconnected")).toBe(false);
  });
  it("discovers the committed React root when the DOM attachment belongs to a stale alternate", async () => {
    const f = fixture();
    await admission(f);
    const connectionId = f.bridge.connectionId({ authority: f.authority });
    f.setAttachedReadiness(false);
    await f.tick();
    expect(f.bridge.authority()).toBe(f.authority);
    expect(f.bridge.connectionId({ authority: f.authority })).toBe(connectionId);
    expect(f.events.some((event) => event.event === "transport.disconnected")).toBe(false);
    await f.bridge.cancelOwned({ authority: f.authority, receipt });
    expect(f.calls.at(-1)?.options.expectedConnectionId).toBe("physical-1");
  });
  it("revokes ownership when the committed account changes despite a stale authenticated DOM tree", async () => {
    const f = fixture();
    await admission(f);
    f.setCommittedAccount("different-synthetic-account");
    await f.tick();
    expect(f.events.some((event) => event.event === "transport.disconnected")).toBe(true);
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
      "account_changed",
    );
    expect(f.calls.some((call) => call.method === "chat.cancel")).toBe(false);
  });
  it("attaches captured session metadata and pins result to the invoking physical connection", async () => {
    const f = fixture();
    await f.bridge.watch({ authority: f.authority, session: "primary" });
    const connectionId = f.bridge.connectionId({ authority: f.authority });
    await f.bridge.register({
      authority: f.authority,
      clientId: "t3-turn",
      nativeSessionId: "primary",
      connectionId,
      commands: { "t3.probe": {} },
    });
    await f.bridge.request({
      authority: f.authority,
      method: "chat.stream",
      params: { session_id: "primary", node_id: "t3-turn" },
    });
    await f.invokes.get("t3.probe")!(
      {
        invoke_id: "invoke-1",
        command_id: "t3.probe",
        params_json: "{}",
        nativeSessionId: "attacker",
      },
      { websocketConnectionID: "physical-1" },
    );
    expect(f.invoke.mock.calls[0]?.[0].nativeSessionId).toBe("primary");
    expect(
      f.calls.find((call) => call.method === "client.invoke.result")?.options.expectedConnectionId,
    ).toBe("physical-1");
    await f.bridge.unregister({ authority: f.authority, clientId: "t3-turn", connectionId });
    expect(f.invokes.size).toBe(0);
    const last = f.calls.at(-1);
    expect(last).toBeDefined();
    expect((last!.params.capabilities as { device_commands: Params }).device_commands).toEqual({});
  });
  it("revokes native handlers on reconnect and refuses a stale registration", async () => {
    const f = fixture();
    await f.bridge.watch({ authority: f.authority, session: "primary" });
    const connectionId = f.bridge.connectionId({ authority: f.authority });
    await f.bridge.register({
      authority: f.authority,
      clientId: "t3-turn",
      nativeSessionId: "primary",
      connectionId,
      commands: { "t3.probe": {} },
    });
    const stale = f.invokes.get("t3.probe")!;
    f.rpc.isReady = false;
    await f.tick();
    f.rpc.isReady = true;
    await f.tick();
    await stale(
      { invoke_id: "stale", command_id: "t3.probe" },
      { websocketConnectionID: "physical-old" },
    );
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.invokes.size).toBe(0);
    await expect(
      f.bridge.register({
        authority: f.authority,
        clientId: "old",
        nativeSessionId: "primary",
        connectionId,
        commands: {},
      }),
    ).rejects.toThrow("registration_scope_changed");
  });
  it("pins the first invocation's physical connection even before a chat event arrives", async () => {
    const f = fixture();
    await f.bridge.watch({ authority: f.authority, session: "primary" });
    const connectionId = f.bridge.connectionId({ authority: f.authority });
    await f.bridge.register({
      authority: f.authority,
      clientId: "t3-turn",
      nativeSessionId: "primary",
      connectionId,
      commands: { "t3.probe": {} },
    });
    await f.bridge.request({
      authority: f.authority,
      method: "chat.stream",
      params: { session_id: "primary", node_id: "t3-turn" },
    });
    const handler = f.invokes.get("t3.probe")!;
    await handler(
      { invoke_id: "first", command_id: "t3.probe", params_json: "{}" },
      { websocketConnectionID: "physical-1" },
    );
    await handler(
      { invoke_id: "replacement", command_id: "t3.probe", params_json: "{}" },
      { websocketConnectionID: "physical-2" },
    );
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.invokes.size).toBe(0);
    expect(f.bridge.connectionId({ authority: f.authority })).not.toBe(connectionId);
    await expect(f.bridge.cancelOwned({ authority: f.authority, receipt })).rejects.toThrow(
      "turn_not_owned",
    );
  });
});

describe("authenticated avatar transport", () => {
  it("transfers a bounded image without a cloud URL", async () => {
    const f = fixture();
    const result = await f.bridge.readAvatar({
      authority: f.authority,
      path: "workspace/avatars/muse.webp",
    });
    expect(result).toEqual({ base64: btoa("synthetic-avatar"), contentType: "image/webp" });
    expect(f.calls[0]?.params).toEqual({ path: "workspace/avatars/muse.webp" });
  });
  it("rejects traversal, absolute foreign paths and URI encodings before RPC", async () => {
    const f = fixture();
    for (const path of [
      "/etc/passwd",
      "workspace/avatars/../secrets",
      "workspace/avatars/sub/../../secrets",
      "workspace/avatars/%2e%2e/file",
      "https://muse.ai/avatar",
    ]) {
      await expect(f.bridge.readAvatar({ authority: f.authority, path })).rejects.toThrow(
        "avatar_path_refused",
      );
    }
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects unsupported MIME and oversize Blob before arrayBuffer", async () => {
    const f = fixture();
    const unsupported = new Blob(["html"], { type: "text/html" });
    const readUnsupported = vi.spyOn(unsupported, "arrayBuffer");
    f.setBlob(unsupported);
    await expect(
      f.bridge.readAvatar({ authority: f.authority, path: "workspace/avatars/muse.webp" }),
    ).rejects.toThrow("avatar_content_refused");
    expect(readUnsupported).not.toHaveBeenCalled();
    const oversize = new Blob(["fixture"], { type: "video/mp4" });
    Object.defineProperty(oversize, "size", { value: MUSE_AGENT_AVATAR_MAX_BYTES + 1 });
    const readOversize = vi.spyOn(oversize, "arrayBuffer");
    f.setBlob(oversize);
    await expect(
      f.bridge.readAvatar({ authority: f.authority, path: "workspace/avatars/muse.mp4" }),
    ).rejects.toThrow("avatar_content_refused");
    expect(readOversize).not.toHaveBeenCalled();
  });
  it("refuses an account switch during avatar acquisition", async () => {
    const f = fixture();
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params, options) => {
      const result = await original(method, params, options);
      if (method === "fs.raw") f.value.userId = "different-synthetic-account";
      return result;
    });
    await expect(
      f.bridge.readAvatar({ authority: f.authority, path: "workspace/avatars/muse.webp" }),
    ).rejects.toThrow("account_changed");
  });
});

describe("authenticated computer preview transport", () => {
  const sha256 = "a".repeat(64);
  it("reads the exact preview through the native binary media request", async () => {
    const f = fixture();
    f.setBlob(new Blob(["synthetic-preview"], { type: "image/png" }));
    expect(
      await f.bridge.readComputerPreview({ authority: f.authority, taskId: "task-1", sha256 }),
    ).toEqual({ base64: btoa("synthetic-preview"), contentType: "image/png" });
    expect(f.calls[0]).toEqual({
      method: "computer.preview",
      params: { task_id: "task-1", sha256 },
      options: {
        expectedGatewayTargetKey: JSON.stringify(["https://gateway.invalid", "synthetic-vm"]),
      },
    });
  });
  it("rejects route escapes and hashes before a native request", async () => {
    const f = fixture();
    for (const taskId of ["../other", "other/task", "other\\task", "\u0000task"])
      await expect(
        f.bridge.readComputerPreview({ authority: f.authority, taskId, sha256 }),
      ).rejects.toThrow("computer_preview_refused");
    await expect(
      f.bridge.readComputerPreview({ authority: f.authority, taskId: "task-1", sha256: "invalid" }),
    ).rejects.toThrow("computer_preview_refused");
    expect(f.calls).toEqual([]);
    expect(
      await f.bridge.readComputerPreview({ authority: f.authority, taskId: "task-1", sha256 }),
    ).toEqual({ base64: btoa("synthetic-avatar"), contentType: "image/webp" });
  });
  it("refuses nonimages and oversized blobs before allocating their bytes", async () => {
    const f = fixture();
    const html = new Blob(["html"], { type: "text/html" });
    const readHtml = vi.spyOn(html, "arrayBuffer");
    f.setBlob(html);
    await expect(
      f.bridge.readComputerPreview({ authority: f.authority, taskId: "task-1", sha256 }),
    ).rejects.toThrow("computer_preview_content_refused");
    expect(readHtml).not.toHaveBeenCalled();
    const oversize = new Blob(["image"], { type: "image/png" });
    Object.defineProperty(oversize, "size", { value: 20 * 1024 * 1024 + 1 });
    const readOversize = vi.spyOn(oversize, "arrayBuffer");
    f.setBlob(oversize);
    await expect(
      f.bridge.readComputerPreview({ authority: f.authority, taskId: "task-1", sha256 }),
    ).rejects.toThrow("computer_preview_content_refused");
    expect(readOversize).not.toHaveBeenCalled();
    f.setBlob(new Blob(["accepted"], { type: "image/jpeg" }));
    expect(
      await f.bridge.readComputerPreview({ authority: f.authority, taskId: "task-1", sha256 }),
    ).toEqual({ base64: btoa("accepted"), contentType: "image/jpeg" });
  });
  it("fences account changes while the media request is in flight", async () => {
    const f = fixture(),
      original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params, options) => {
      const value = await original(method, params, options);
      if (method === "computer.preview") f.value.userId = "other-account";
      return value;
    });
    await expect(
      f.bridge.readComputerPreview({ authority: f.authority, taskId: "task-1", sha256 }),
    ).rejects.toThrow("account_changed");
    expect(f.calls[0]?.params).toEqual({ task_id: "task-1", sha256 });
  });
});

describe("native encrypted computer streams", () => {
  const open = async (f: ReturnType<typeof fixture>) => {
    const connectionId = f.bridge.connectionId({ authority: f.authority });
    const input = {
      authority: f.authority,
      id: "stream",
      connectionId,
      sessionId: "worker",
      taskId: "task",
      takeoverId: "takeover",
    };
    await f.bridge.openComputerStream(input);
    return input;
  };
  it("uses the original native constructor and carries decrypted bytes without exposing credentials", async () => {
    const f = fixture(),
      input = await open(f);
    expect(f.computerConnections).toEqual([
      { gatewayUrl: "https://gateway.invalid", taskId: "task", vmName: "synthetic-vm" },
    ]);
    f.socket.onmessage!({ data: new Uint8Array([82, 70, 66]).buffer });
    expect(f.computerEvents).toEqual([
      {
        authority: f.authority,
        id: "stream",
        connectionId: input.connectionId,
        type: "data",
        base64: "UkZC",
      },
    ]);
    await f.bridge.sendComputerStream({ ...input, base64: "AQID" });
    expect(f.computerSends).toEqual([new Uint8Array([1, 2, 3])]);
    expect(f.calls.map((call) => call.method)).toEqual(["browser_task.get", "browser_task.get"]);
    f.bridge.closeComputerStream(input);
    expect(f.computerClosed()).toBe(1);
  });
  it("fails closed without the verified native module constructor", async () => {
    const f = fixture();
    f.removeComputerConstructor();
    await expect(open(f)).rejects.toThrow("computer_stream_unavailable");
    expect(f.computerConnections).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it("does not construct a native stream after its pending lease check was closed", async () => {
    const f = fixture();
    let resolveState!: (value: Params) => void;
    f.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveState = resolve;
        }),
    );
    const connectionId = f.bridge.connectionId({ authority: f.authority });
    const input = {
      authority: f.authority,
      id: "stream",
      connectionId,
      sessionId: "worker",
      taskId: "task",
      takeoverId: "takeover",
    };
    const pending = f.bridge.openComputerStream(input);
    f.bridge.closeComputerStream(input);
    resolveState({
      session_id: "worker",
      presented_task_id: "task",
      lease: {
        control_owner: "user",
        task_id: "task",
        takeover_id: "takeover",
        control_expires_at_ms: 4102444800000,
      },
    });
    await expect(pending).rejects.toThrow();
    expect(f.computerConnections).toEqual([]);
    expect(f.computerEvents.map((event) => event.type)).toEqual(["close"]);
  });
  it("retires the stream when task presentation or takeover authority changes before input", async () => {
    const f = fixture(),
      input = await open(f);
    f.setComputerState({
      session_id: "worker",
      presented_task_id: "other",
      lease: {
        control_owner: "user",
        task_id: "task",
        takeover_id: "takeover",
        control_expires_at_ms: 4102444800000,
      },
    });
    await expect(f.bridge.sendComputerStream({ ...input, base64: "AQID" })).rejects.toThrow(
      "computer_lease_changed",
    );
    expect(f.computerSends).toEqual([]);
    expect(f.computerClosed()).toBe(1);
    expect(f.computerEvents.at(-1)?.type).toBe("close");
  });
  it("refuses a stale account and bounded-output overflow without native input", async () => {
    const f = fixture();
    await open(f);
    f.socket.onmessage!({ data: new ArrayBuffer(4 * 1024 * 1024 + 1) });
    expect(f.computerClosed()).toBe(1);
    const other = fixture(),
      otherInput = await open(other);
    other.setCommittedAccount("other-account");
    await expect(
      other.bridge.sendComputerStream({ ...otherInput, base64: "AQID" }),
    ).rejects.toThrow("account_changed");
    await other.tick();
    expect(other.computerSends).toEqual([]);
    expect(other.computerClosed()).toBe(1);
  });
});
