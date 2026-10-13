import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vite-plus/test";
import * as Config from "../config.ts";
import * as Native from "./GrokBotNativeService.ts";
import * as Network from "./GrokBotNetworkService.ts";
import { egressAllows, type startEgressClient } from "./GrokBotEgressClient.ts";

type ClientInput = Parameters<typeof startEgressClient>[0];
const clients = vi.hoisted(() => ({ start: vi.fn<typeof startEgressClient>() }));
vi.mock("./GrokBotEgressClient.ts", async (original) => ({
  ...(await original<typeof import("./GrokBotEgressClient.ts")>()),
  startEgressClient: clients.start,
}));
beforeEach(() => {
  clients.start.mockReset();
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const starts = yield* Queue.unbounded<ClientInput>();
  const fetched = yield* Queue.unbounded<void>();
  const pending = yield* Deferred.make<void>();
  const accountStarted = yield* Deferred.make<void>();
  const baseline = {
    restricted: true,
    allowedDomains: ["keep.example", "removed.example"],
    allowedTcpDestinations: [
      { cidr: "8.8.0.0/16", port: 53 },
      { cidr: "9.9.9.0/24", port: 53 },
    ],
  };
  const current = {
    binding: "first",
    connection: {
      url: "wss://box.fixture.invalid",
      headers: {},
      allowed: true,
      policy: baseline,
      clientId: "fixture-id",
    },
    hold: false,
    stallAccount: false,
    failure: undefined as Native.NativeReadError | undefined,
    reads: 0,
    stops: 0,
  };
  clients.start.mockImplementation((input) => {
    Queue.offerUnsafe(starts, input);
    input.status("connecting", 0, 0);
    let stopped = false;
    return {
      isAlive: () => !stopped,
      heartbeat: () => {},
      stop: () => {
        stopped = true;
        current.stops++;
      },
    };
  });
  const native = Layer.mock(Native.GrokBotNativeService)({
    accountBinding: Effect.gen(function* () {
      if (current.stallAccount) {
        yield* Deferred.succeed(accountStarted, undefined);
        return yield* Effect.never;
      }
      return current.binding;
    }),
    egressConnection: () =>
      Effect.gen(function* () {
        current.reads++;
        yield* Queue.offer(fetched, undefined);
        if (current.hold) yield* Deferred.await(pending);
        if (current.failure) return yield* current.failure;
        return current.connection;
      }),
  });
  const context = yield* Layer.build(
    Network.layer.pipe(Layer.provide(native), Layer.provide(Config.layerTest(root, root))),
  );
  return {
    service: Context.get(context, Network.GrokBotNetworkService),
    current,
    starts,
    fetched,
    pending,
    accountStarted,
  };
});

it.effect.each(["write", "rename"] as const)(
  "a failed %s keeps routing state and the saved opt-in unchanged until disabling succeeds",
  (operation) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let fail = false;
      let savedFile = "";
      const { service, current, starts } = yield* fixture.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (path, contents, options) =>
            fs.writeFileString(
              fail && operation === "write" ? `${path}/blocked` : path,
              contents,
              options,
            ),
          rename: (from, to) => {
            savedFile = to;
            return fs.rename(fail && operation === "rename" ? `${from}.missing` : from, to);
          },
        }),
      );
      yield* service.set(true);
      const client = yield* Queue.take(starts);
      client.status("connected", 2, 3);
      const previous = yield* service.read();
      const persisted = yield* fs.readFileString(savedFile);
      const stops = current.stops;
      fail = true;
      const result = yield* Effect.result(service.set(false));
      assert.strictEqual(result._tag, "Failure");
      assert.deepEqual(yield* service.read(), previous);
      assert.strictEqual(current.stops, stops);
      assert.strictEqual(yield* fs.readFileString(savedFile), persisted);
      fail = false;
      assert.strictEqual((yield* service.set(false)).state, "off");
      assert.strictEqual((yield* service.read()).enabled, false);
      assert.strictEqual(JSON.parse(yield* fs.readFileString(savedFile)).enabled, false);
      assert.strictEqual(current.stops, stops + 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("observed sign-out stops routing and does not enable it again on sign-in", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    let signedIn = true;
    const native = Layer.mock(Native.GrokBotNativeService)({
      accountBinding: Effect.suspend(() =>
        signedIn ? Effect.succeed("account") : Effect.fail(new Native.NativeSignedOutError({})),
      ),
      egressConnection: () => Effect.never,
    });
    yield* Effect.gen(function* () {
      const service = yield* Network.GrokBotNetworkService;
      yield* service.set(true);
      signedIn = false;
      assert.strictEqual((yield* service.read()).state, "off");
      signedIn = true;
      assert.strictEqual((yield* service.read()).enabled, false);
      const config = yield* Config.ServerConfig;
      assert.strictEqual(
        JSON.parse(yield* fs.readFileString(`${config.stateDir}/grokbot-network.json`)).enabled,
        false,
      );
    }).pipe(
      Effect.provide(
        Network.layer.pipe(Layer.provide(native), Layer.provideMerge(Config.layerTest(root, root))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "disabled routing does not read the account and can stop a pending connection after sign-out",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const started = yield* Deferred.make<void>();
      let signedIn = true;
      let accountReads = 0;
      const native = Layer.mock(Native.GrokBotNativeService)({
        accountBinding: Effect.suspend(() => {
          accountReads++;
          return signedIn
            ? Effect.succeed("account")
            : Effect.fail(new Native.NativeReadError({ stage: "session" }));
        }),
        egressConnection: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.gen(function* () {
        const service = yield* Network.GrokBotNetworkService;
        assert.strictEqual((yield* service.read()).state, "off");
        assert.strictEqual(accountReads, 0);
        yield* service.set(true);
        yield* Deferred.await(started);
        signedIn = false;
        assert.strictEqual((yield* service.set(false)).state, "off");
        assert.strictEqual((yield* service.read()).enabled, false);
      }).pipe(
        Effect.provide(
          Network.layer.pipe(Layer.provide(native), Layer.provide(Config.layerTest(root, root))),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("an account change persists routing off instead of silently resuming later", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    let binding = "first";
    const native = Layer.mock(Native.GrokBotNativeService)({
      accountBinding: Effect.sync(() => binding),
      egressConnection: () => Effect.never,
    });
    yield* Effect.gen(function* () {
      const service = yield* Network.GrokBotNetworkService;
      yield* service.set(true);
      binding = "second";
      assert.strictEqual((yield* service.read()).enabled, false);
      binding = "first";
      assert.strictEqual((yield* service.read()).state, "off");
      const config = yield* Config.ServerConfig;
      const saved = JSON.parse(yield* fs.readFileString(`${config.stateDir}/grokbot-network.json`));
      assert.strictEqual(saved.enabled, false);
    }).pipe(
      Effect.provide(
        Network.layer.pipe(Layer.provide(native), Layer.provideMerge(Config.layerTest(root, root))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refresh applies mixed removals/narrowing without granting additions or unrestricted policy",
  () =>
    Effect.gen(function* () {
      const { service, current, starts } = yield* fixture;
      yield* service.set(true);
      yield* Queue.take(starts);
      current.connection = {
        ...current.connection,
        headers: { fixture: "rotated" },
        policy: {
          restricted: true,
          allowedDomains: ["keep.example", "added.example"],
          allowedTcpDestinations: [
            { cidr: "8.8.8.0/24", port: 53 },
            { cidr: "1.1.1.0/24", port: 53 },
          ],
        },
      };
      yield* TestClock.adjust("30 seconds");
      const tightened = yield* Queue.take(starts);
      assert.isTrue(egressAllows("keep.example", 443, tightened.policy));
      for (const host of ["removed.example", "added.example"])
        assert.isFalse(egressAllows(host, 443, tightened.policy));
      assert.isTrue(egressAllows("8.8.8.8", 53, tightened.policy));
      for (const host of ["8.8.9.8", "9.9.9.9", "1.1.1.1"])
        assert.isFalse(egressAllows(host, 53, tightened.policy));
      current.connection = {
        ...current.connection,
        headers: { fixture: "rotated-again" },
        policy: {
          restricted: false,
          allowedDomains: [],
          allowedTcpDestinations: [],
        },
      };
      yield* TestClock.adjust("30 seconds");
      const refreshed = yield* Queue.take(starts);
      assert.deepStrictEqual(refreshed.policy, tightened.policy);
      yield* service.set(true);
      assert.isFalse((yield* Queue.take(starts)).policy.restricted);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("only explicit box/account resets establish a new policy and clear ownership", () =>
  Effect.gen(function* () {
    const { service, current, starts } = yield* fixture;
    yield* service.set(true);
    const first = yield* Queue.take(starts);
    first.ownership!.generation = "7";
    current.connection = {
      ...current.connection,
      url: "wss://new-box.fixture.invalid",
      policy: {
        restricted: false,
        allowedDomains: [],
        allowedTcpDestinations: [],
      },
    };
    yield* TestClock.adjust("30 seconds");
    const next = yield* Queue.take(starts);
    assert.isFalse(next.policy.restricted);
    assert.isNull(next.ownership!.generation);
    current.binding = "second";
    assert.isFalse((yield* service.read()).enabled);
    const before = clients.start.mock.calls.length;
    yield* service.claimIfEnabled("first");
    yield* TestClock.adjust("30 seconds");
    assert.strictEqual(clients.start.mock.calls.length, before);
    yield* service.set(true);
    const second = yield* Queue.take(starts);
    assert.isNull(second.ownership!.generation);
    assert.strictEqual(second.attachMode, "if-free");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "claims an occupied opted-in tunnel, while disabled, denied and stale bindings cannot claim",
  () =>
    Effect.gen(function* () {
      const { service, current, starts, fetched } = yield* fixture;
      yield* service.claimIfEnabled("first");
      assert.strictEqual(current.reads, 0);
      yield* service.set(true);
      const first = yield* Queue.take(starts);
      first.status("standby", 0, 0);
      yield* service.claimIfEnabled("stale");
      assert.strictEqual(clients.start.mock.calls.length, 1);
      yield* service.claimIfEnabled("first");
      assert.strictEqual((yield* Queue.take(starts)).attachMode, "claim");
      current.connection = { ...current.connection, allowed: false };
      yield* Queue.take(fetched);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(fetched);
      const before = clients.start.mock.calls.length;
      yield* service.claimIfEnabled("first");
      assert.strictEqual(clients.start.mock.calls.length, before);
      yield* service.set(false);
      yield* service.claimIfEnabled("first");
      assert.isFalse((yield* service.read()).enabled);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([0, 60_000])(
  "initial setup retains a claim for at most one minute (%s ms)",
  (delay) =>
    Effect.gen(function* () {
      const { service, current, starts, fetched, pending } = yield* fixture;
      current.hold = true;
      yield* service.set(true);
      yield* Queue.take(fetched);
      yield* service.claimIfEnabled("first");
      if (delay > 0) yield* TestClock.adjust(delay);
      yield* Deferred.succeed(pending, undefined);
      const attached = yield* Queue.take(starts);
      assert.strictEqual(attached.attachMode, delay === 0 ? "claim" : "if-free");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "transport recovery keeps context, uses 2s backoff, ignores old callbacks and stops on disable",
  () =>
    Effect.gen(function* () {
      const { service, current, starts } = yield* fixture;
      yield* service.set(true);
      const first = yield* Queue.take(starts);
      first.ownership!.generation = "12";
      first.status("error", 0, 0);
      first.disconnected!("error");
      yield* TestClock.adjust(1_999);
      assert.strictEqual(clients.start.mock.calls.length, 1);
      yield* TestClock.adjust(1);
      const second = yield* Queue.take(starts);
      assert.strictEqual(second.ownership!.generation, "12");
      assert.strictEqual(second.clientId, first.clientId);
      assert.strictEqual(current.reads, 1);
      first.status("standby", 0, 0);
      first.disconnected!("standby");
      assert.strictEqual((yield* service.read()).state, "connecting");
      second.status("error", 0, 0);
      second.disconnected!("error");
      yield* service.set(false);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(clients.start.mock.calls.length, 2);
      assert.strictEqual((yield* service.read()).state, "off");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("standby rechecks after 45s without the policy refresh bypassing that delay", () =>
  Effect.gen(function* () {
    const { service, starts } = yield* fixture;
    yield* service.set(true);
    const first = yield* Queue.take(starts);
    first.status("standby", 0, 0);
    first.disconnected!("standby");
    yield* TestClock.adjust(44_999);
    assert.strictEqual(clients.start.mock.calls.length, 1);
    yield* TestClock.adjust(1);
    assert.strictEqual((yield* Queue.take(starts)).attachMode, "if-free");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a failed refresh detaches but cannot erase the policy baseline on the next success",
  () =>
    Effect.gen(function* () {
      const { service, current, starts } = yield* fixture;
      yield* service.set(true);
      const first = yield* Queue.take(starts);
      current.failure = new Native.NativeReadError({ stage: "request", status: 403 });
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* service.read()).state, "error");
      current.failure = undefined;
      current.connection = {
        ...current.connection,
        policy: {
          restricted: false,
          allowedDomains: [],
          allowedTcpDestinations: [],
        },
      };
      yield* TestClock.adjust("30 seconds");
      const next = yield* Queue.take(starts);
      assert.deepStrictEqual(next.policy, first.policy);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("replacing standby with a claim cancels the old retry wait", () =>
  Effect.gen(function* () {
    const { service, starts } = yield* fixture;
    yield* service.set(true);
    const first = yield* Queue.take(starts);
    first.status("standby", 0, 0);
    first.disconnected!("standby");
    yield* TestClock.adjust(1);
    yield* service.claimIfEnabled("first");
    const claimed = yield* Queue.take(starts);
    assert.strictEqual(claimed.attachMode, "claim");
    claimed.status("error", 0, 0);
    claimed.disconnected!("error");
    yield* TestClock.adjust(4_000);
    assert.strictEqual((yield* Queue.take(starts)).attachMode, "claim");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repeated transport failures back off from 2s to a 30s cap independently of refresh",
  () =>
    Effect.gen(function* () {
      const { service, starts } = yield* fixture;
      yield* service.set(true);
      let attached = yield* Queue.take(starts);
      for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        attached.status("error", 0, 0);
        attached.disconnected!("error");
        const before = clients.start.mock.calls.length;
        yield* TestClock.adjust(delay - 1);
        assert.strictEqual(clients.start.mock.calls.length, before);
        yield* TestClock.adjust(1);
        attached = yield* Queue.take(starts);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a stale current account cannot claim, and an opened claim is consumed even before confirmation",
  () =>
    Effect.gen(function* () {
      const { service, current, starts } = yield* fixture;
      yield* service.set(true);
      yield* Queue.take(starts);
      current.binding = "second";
      yield* service.claimIfEnabled("first");
      assert.strictEqual(clients.start.mock.calls.length, 1);
      current.binding = "first";
      yield* service.claimIfEnabled("first");
      const claimed = yield* Queue.take(starts);
      claimed.opened!();
      claimed.status("error", 0, 0);
      claimed.disconnected!("error");
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual((yield* Queue.take(starts)).attachMode, "if-free");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a stalled account check expires the claim after two seconds without changing opt-in",
  () =>
    Effect.gen(function* () {
      const { service, current, starts, accountStarted } = yield* fixture;
      yield* service.set(true);
      yield* Queue.take(starts);
      current.stallAccount = true;
      const claim = yield* service.claimIfEnabled("first").pipe(Effect.forkChild);
      yield* Deferred.await(accountStarted);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(claim);
      assert.strictEqual(clients.start.mock.calls.length, 1);
      current.stallAccount = false;
      assert.isTrue((yield* service.read()).enabled);
    }).pipe(Effect.provide(NodeServices.layer)),
);
