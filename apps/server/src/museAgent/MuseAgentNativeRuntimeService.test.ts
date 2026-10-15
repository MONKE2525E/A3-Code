import { assert, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native attachment fixtures verify bounded reads from real task-owned files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native attachment fixtures build their private paths alongside the SQLite boundary.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProviderPromptNotSubmittedError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import {
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ToolsPort from "./MuseAgentDirectToolsPort.ts";
import { createMuseAgentAdapterV2 } from "../orchestration-v2/Adapters/MuseAgentAdapterV2.ts";
import {
  makeTurn,
  options,
  policy,
  selection,
  threadId,
  host,
} from "../orchestration-v2/Adapters/MuseAgentAdapterV2.testkit.ts";
import * as Native from "./MuseAgentNativeRuntimeService.ts";
import * as Source from "./MuseAgentSessionSource.ts";
import * as Transport from "./MuseAgentTransport.ts";
import * as Delivery from "./MuseAgentDeliveryStore.ts";

const binding = "a".repeat(64);
const request = {
  binding,
  sessionId: "primary",
  deliveryKey: "attempt-1",
  text: "Synthetic task",
  clientId: "t3-muse-attempt-1",
};
const fixture = () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  const delivery = Delivery.makeMuseAgentDeliveryStore(db);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let authority = binding;
  let fingerprint = "session-a";
  let unreadable = false;
  let rotateDuringConnect = false;
  let failSend = false;
  let stageHook: Effect.Effect<void, Transport.MuseAgentTransportError> = Effect.void;
  let admissionHook: Effect.Effect<void, Transport.MuseAgentTransportError> = Effect.void;
  let watch: Transport.MuseAgentTransport["Service"]["watch"] = () =>
    Effect.succeed({ events: Stream.never, close: Effect.void });
  const remoteSizes = new Map<string, number>();
  const remoteBytes = new Map<string, Uint8Array>();
  let inspections = 0;
  let identity: unknown = {
    name: "Synthetic Muse",
    avatar: { image_path: "workspace/avatars/muse.webp", chat_theme_color: "#aabbcc" },
  };
  const cancellations: Delivery.MuseAgentReceipt[] = [];
  const localReleases: string[] = [];
  const transport = Transport.MuseAgentTransport.of({
    releaseOwned: (_, input) =>
      Effect.sync(() => {
        localReleases.push(input.deliveryKey);
      }),
    connect: Effect.sync(() => {
      if (rotateDuringConnect) fingerprint = "session-b";
      return authority;
    }),
    request: (_, method, params) =>
      Effect.gen(function* () {
        calls.push({ method, params });
        if (method === "sessions.list")
          return {
            sessions: [
              { session_id: "primary", is_primary: true, is_thread: false, status: "idle" },
            ],
          };
        if (method === "identity") return identity;
        if (method === "chat.history") return { chat_events: [], has_more: false };
        if (method === "chat.stream_events") return { events: [] };
        if (method === "fs.write") {
          yield* stageHook;
          const size = Buffer.from(String(params.data_base64), "base64").length;
          const path = String(params.path);
          remoteSizes.set(path, size + (params.append ? (remoteSizes.get(path) ?? 0) : 0));
          return {};
        }
        if (method === "fs.stat")
          return { kind: "file", size: remoteSizes.get(String(params.path)) };
        if (method === "fs.read") {
          const bytes = remoteBytes.get(String(params.path))!;
          const offset = Number(params.offset),
            len = Number(params.len);
          const chunk = bytes.subarray(offset, offset + len);
          return {
            data_base64: Buffer.from(chunk).toString("base64"),
            len: chunk.length,
            eof: offset + chunk.length >= bytes.length,
          };
        }
        if (method === "fs.rename") {
          remoteSizes.set(String(params.destination), remoteSizes.get(String(params.source))!);
          remoteSizes.delete(String(params.source));
          return {};
        }
        if (method === "fs.delete") {
          remoteSizes.delete(String(params.path));
          return {};
        }
        if (method === "chat.stream") yield* admissionHook;
        if (failSend) return yield* new Transport.MuseAgentTransportError({ kind: "uncertain" });
        return { session_id: "primary", message_id: "user-1", reply_to_message_id: "carrier-1" };
      }),
    watch: (binding, sessionId) => watch(binding, sessionId),
    connectionId: () => Effect.succeed("generation-1"),
    cancelOwned: (_, receipt) =>
      Effect.sync(() => {
        cancellations.push(receipt);
      }),
    readAvatar: () => Effect.fail(new Transport.MuseAgentTransportError({ kind: "unavailable" })),
    openComputerStream: () => Effect.die("unused openComputerStream"),
    readComputerPreview: () => Effect.die("unused readComputerPreview"),
    registerTools: (_, input) =>
      Effect.succeed({
        accepted: Object.keys(input.commands).length,
        connectionId: input.connectionId,
      }),
    unregisterTools: () => Effect.void,
  });
  const source = Source.MuseAgentSessionSource.of({
    inspect: Effect.sync(() => {
      inspections++;
      return { installed: true, sessionPresent: true };
    }),
    read: Effect.suspend(() =>
      unreadable
        ? Effect.fail(
            new Source.MuseAgentSessionSourceError({ stage: "read", cause: "synthetic failure" }),
          )
        : Effect.succeed({ profilePath: "/synthetic", cookies: [], fingerprint }),
    ),
  });
  const layer = Native.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Source.MuseAgentSessionSource, source),
        Layer.succeed(Transport.MuseAgentTransport, transport),
        Layer.succeed(Delivery.MuseAgentDeliveryStore, delivery),
      ),
    ),
  );
  return {
    layer,
    calls,
    cancellations,
    localReleases,
    refuseRelease: () =>
      db.exec(
        "CREATE TRIGGER refuse_release BEFORE UPDATE ON muse_deliveries WHEN NEW.status='released' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END",
      ),
    allowRelease: () => db.exec("DROP TRIGGER refuse_release"),
    deliveryRows: () => db.prepare("SELECT delivery_key, status FROM muse_deliveries").all(),
    setRemoteFile: (path: string, bytes: Uint8Array) => {
      remoteSizes.set(path, bytes.length);
      remoteBytes.set(path, bytes);
    },
    setStageHook: (hook: typeof stageHook) => {
      stageHook = hook;
    },
    setAdmissionHook: (hook: typeof admissionHook) => {
      admissionHook = hook;
    },
    setWatch: (next: typeof watch) => {
      watch = next;
    },
    close: () => db.close(),
    setUnreadable: () => {
      unreadable = true;
    },
    rotateDuringConnect: () => {
      rotateDuringConnect = true;
    },
    switchAccount: () => {
      fingerprint = "session-b";
      authority = "b".repeat(64);
    },
    setFailSend: () => {
      failSend = true;
    },
    inspections: () => inspections,
    setIdentity: (next: unknown) => {
      identity = next;
    },
  };
};

const ownershipContext = (turn: Effect.Success<typeof makeTurn>) => ({
  threadId: turn.threadId,
  providerInstanceId: turn.modelSelection.instanceId,
  runId: turn.runId,
  nodeId: turn.rootNodeId,
  providerThreadId: turn.providerThread.id,
  providerTurnId: ProviderTurnId.make(
    `provider-turn/muse-agent/${encodeURIComponent(turn.attemptId)}`,
  ),
  userMessageId: turn.message.messageId,
});

it.effect.each(["success", "error", "interrupt"] as const)(
  "releases matching receipt readers after admission %s",
  (outcome) => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const turn = yield* makeTurn;
        const context = ownershipContext(turn);
        f.setAdmissionHook(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const sending = yield* native.send({ ...request, context }).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const scope = {
          binding,
          sessionId: "primary",
          threadId,
          providerInstanceId: selection.instanceId,
        };
        const options = { awaitAdmissions: true, receiptsOnly: true };
        // Other thread and instance readers must not wait behind this delivery.
        assert.deepStrictEqual(
          yield* native.historyOwnership(
            { ...scope, threadId: ThreadId.make("other-thread") },
            options,
          ),
          { receipts: [], messages: [] },
        );
        assert.deepStrictEqual(
          yield* native.historyOwnership(
            { ...scope, providerInstanceId: ProviderInstanceId.make("other-instance") },
            options,
          ),
          { receipts: [], messages: [] },
        );
        const readFinished = yield* Deferred.make<void>();
        const reading = yield* native.historyOwnership(scope, options).pipe(
          Effect.tap(() => Deferred.succeed(readFinished, undefined)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Deferred.poll(readFinished)));
        if (outcome === "interrupt") yield* Fiber.interrupt(sending);
        else {
          if (outcome === "error") f.setFailSend();
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(sending).pipe(Effect.exit);
          assert.strictEqual(Exit.isSuccess(result), outcome === "success");
        }
        const ownership = yield* Fiber.join(reading);
        assert.strictEqual(ownership.receipts.length, outcome === "success" ? 1 : 0);
        assert.deepStrictEqual(ownership.messages, []);
      }),
    ).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
  },
);

it.effect("refuses a stale account after a matching admission wait completes", () => {
  const f = fixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const native = yield* Native.MuseAgentNativeRuntimeService;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.setAdmissionHook(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const context = ownershipContext(yield* makeTurn);
      const sending = yield* native.send({ ...request, context }).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const reading = yield* native
        .historyOwnership(
          { binding, sessionId: "primary", threadId, providerInstanceId: selection.instanceId },
          { awaitAdmissions: true, receiptsOnly: true },
        )
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      f.switchAccount();
      yield* Fiber.interrupt(sending);
      assert.strictEqual((yield* Fiber.join(reading).pipe(Effect.flip)).kind, "account_changed");
    }),
  ).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
});

it.effect(
  "an observer opened before managed admission renders one original user and retains a foreign native user",
  () => {
    const f = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        const watchers = new Set<Queue.Queue<Transport.MuseAgentNativeEvent>>();
        f.setWatch(() =>
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<Transport.MuseAgentNativeEvent>();
            watchers.add(queue);
            return {
              events: Stream.fromQueue(queue),
              close: Effect.sync(() => {
                watchers.delete(queue);
              }).pipe(Effect.andThen(Queue.shutdown(queue))),
            };
          }),
        );
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(
            ToolsPort.MuseAgentDirectToolsPort,
            ToolsPort.MuseAgentDirectToolsPort.of({
              install: () => Effect.succeed({ uninstall: Effect.void }),
              start: () => Effect.succeed({ revoke: Effect.void, close: Effect.void }),
            }),
          ),
        );
        const observer = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("observer-before-admission"),
          modelSelection: selection,
          runtimePolicy: policy,
        });
        const turn = yield* makeTurn;
        const managed = yield* adapter.openSession({
          threadId,
          providerSessionId: turn.providerThread.providerSessionId!,
          modelSelection: selection,
          runtimePolicy: policy,
        });
        const rendered = new Map([[turn.message.messageId, turn.message.text]]);
        const observerForeignObserved = yield* Deferred.make<void>();
        const managedForeignObserved = yield* Deferred.make<void>();
        const collect = (runtime: typeof observer, foreignObserved: Deferred.Deferred<void>) =>
          runtime.events.pipe(
            Stream.runForEach((event) => {
              if (event.type !== "message.updated" || event.message.role !== "user")
                return Effect.void;
              rendered.set(event.message.id, event.message.text);
              return event.message.text === "Synthetic foreign user"
                ? Deferred.succeed(foreignObserved, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
            Effect.forkScoped,
          );
        yield* collect(observer, observerForeignObserved);
        yield* collect(managed, managedForeignObserved);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setAdmissionHook(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const sending = yield* managed.startTurn(turn).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        for (const queue of watchers) {
          yield* Queue.offer(queue, {
            event: "message.user",
            payload: {
              session_id: "primary",
              message_id: "user-1",
              display_text: "T3 Code context: refer to the user only as Monke. Synthetic own user",
            },
            meta: { seq: 2, ts_ms: 2000 },
          });
          yield* Queue.offer(queue, {
            event: "message.user",
            payload: {
              session_id: "primary",
              message_id: "foreign-user",
              display_text: "Synthetic foreign user",
            },
            meta: { seq: 1, ts_ms: 1000 },
          });
        }
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(sending);
        yield* Deferred.await(observerForeignObserved);
        yield* Deferred.await(managedForeignObserved);
        assert.strictEqual(rendered.get(turn.message.messageId), turn.message.text);
        assert.deepStrictEqual(
          [...rendered.values()].sort(),
          [turn.message.text, "Synthetic foreign user"].sort(),
        );
        assert.strictEqual(
          [...rendered.values()].some((text) => text.startsWith("T3 Code context:")),
          false,
        );
      }),
    ).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
  },
);

const isPromptNotSubmitted = Schema.is(ProviderPromptNotSubmittedError);
const isNativeRuntimeError = Schema.is(Native.MuseAgentRuntimeError);
const isDeliveryError = Schema.is(Delivery.MuseAgentDeliveryError);
const nativeErrorKind = (failure: Native.MuseAgentError | ProviderPromptNotSubmittedError) => {
  if (failure._tag === "ProviderPromptNotSubmittedError") {
    assert.ok(isNativeRuntimeError(failure.cause) || isDeliveryError(failure.cause));
    return failure.cause.kind;
  }
  return failure.kind;
};

const withFixture = <A, E, R>(test: (f: ReturnType<typeof fixture>) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(Effect.sync(fixture), test, (f) => Effect.sync(() => f.close()));

const withAttachmentDirectory = <A, E, R>(test: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-attachments-"))),
    test,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );

it.effect("marks a new delivery blocked by another unsettled turn as not submitted", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const native = yield* Native.MuseAgentNativeRuntimeService;
      yield* native.send(request);
      const failure = yield* Effect.flip(native.send({ ...request, deliveryKey: "attempt-2" }));
      assert.ok(isPromptNotSubmitted(failure));
      assert.strictEqual(nativeErrorKind(failure), "busy");
      assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 1);
      assert.strictEqual(f.deliveryRows().length, 1);
    }).pipe(Effect.provide(f.layer)),
  ),
);

it.effect(
  "releases only local delivery ownership without cancelling or resending the native turn",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        yield* native.send(request);
        assert.strictEqual((yield* native.pendingDeliveries(request)).length, 1);
        yield* native.releaseLocalOwnership(request);
        assert.deepStrictEqual(yield* native.pendingDeliveries(request), []);
        const old = yield* Effect.flip(native.send(request));
        assert.strictEqual(old._tag, "MuseAgentDeliveryError");
        assert.strictEqual(nativeErrorKind(old), "uncertain");
        yield* native.send({ ...request, deliveryKey: "attempt-2" });
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 2);
        assert.deepStrictEqual(f.cancellations, []);
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect(
  "keeps the session blocked after a release storage failure and permits an idempotent retry",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        yield* native.send(request);
        f.refuseRelease();
        const failure = yield* Effect.flip(native.releaseLocalOwnership(request));
        assert.strictEqual(failure._tag, "MuseAgentDeliveryError");
        assert.strictEqual(nativeErrorKind(failure), "storage");
        assert.strictEqual((yield* native.pendingDeliveries(request)).length, 1);
        assert.strictEqual(
          nativeErrorKind(
            yield* Effect.flip(native.send({ ...request, deliveryKey: "attempt-2" })),
          ),
          "busy",
        );
        f.allowRelease();
        yield* native.releaseLocalOwnership(request);
        assert.deepStrictEqual(yield* native.pendingDeliveries(request), []);
        assert.deepStrictEqual(f.localReleases, [request.deliveryKey, request.deliveryKey]);
        assert.deepStrictEqual(f.cancellations, []);
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect(
  "status stays local, native admission uses the registered node, and accepted delivery is never resent",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        yield* native.status;
        assert.strictEqual(f.calls.length, 0);
        assert.strictEqual(f.inspections(), 1);
        const first = yield* native.send(request);
        assert.strictEqual(first.replayed, false);
        const repeated = yield* native.send(request);
        assert.strictEqual(repeated.replayed, true);
        const writes = f.calls.filter((call) => call.method === "chat.stream");
        assert.strictEqual(writes.length, 1);
        assert.strictEqual(writes[0]?.params.node_id, request.clientId);
        assert.deepStrictEqual(writes[0]?.params.capabilities, [
          "chat_cancel",
          "delta_stream",
          "custom_reactions",
          "custom_reactions_facebook_thumbs_up_v1",
        ]);
        yield* native.stop({ binding, sessionId: "primary", deliveryKey: request.deliveryKey });
        assert.deepStrictEqual(f.cancellations, [
          { sessionId: "primary", messageId: "user-1", replyToMessageId: "carrier-1" },
        ]);
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect(
  "blocks account rebinding and preserves uncertain delivery without a second cloud write",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        f.setFailSend();
        assert.strictEqual(nativeErrorKind(yield* Effect.flip(native.send(request))), "uncertain");
        assert.strictEqual(nativeErrorKind(yield* Effect.flip(native.send(request))), "uncertain");
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 1);
        f.switchAccount();
        assert.strictEqual(
          nativeErrorKind(yield* Effect.flip(native.profile(binding))),
          "account_changed",
        );
        assert.strictEqual(
          nativeErrorKind(
            yield* Effect.flip(
              native.stop({ binding, sessionId: "primary", deliveryKey: request.deliveryKey }),
            ),
          ),
          "account_changed",
        );
        assert.strictEqual(f.cancellations.length, 0);
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect(
  "returns safe optional profile fields and refuses avatar paths outside the native avatar directory",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        const first = yield* native.profile(binding);
        assert.strictEqual(first.avatarImagePath, "workspace/avatars/muse.webp");
        assert.strictEqual(first.chatThemeColor, "#aabbcc");
        assert.strictEqual(Object.hasOwn(first, "description"), false);
        f.setIdentity({
          name: "Synthetic\u0000Muse",
          avatar: {
            image_path: "workspace/avatars/../secrets",
            canonical_path: "https://private.invalid/asset",
            chat_theme_color: "red",
          },
        });
        const next = yield* native.profile(binding);
        assert.strictEqual(next.name, "SyntheticMuse");
        assert.strictEqual(next.avatarImagePath, undefined);
        assert.strictEqual(next.avatarPath, undefined);
        assert.strictEqual(next.chatThemeColor, undefined);
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect("sends bounded inline images and files, and never replays changed attachment bytes", () =>
  withAttachmentDirectory((directory) =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        const image = Buffer.from("synthetic-image");
        const file = Buffer.from("synthetic-file");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(directory, "image.png"), image),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(directory, "file.txt"), file));
        const attached = {
          ...request,
          text: "",
          attachments: {
            directory,
            items: [
              {
                type: "image",
                id: "image",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: image.length,
              },
              {
                type: "file",
                id: "file",
                name: "file.txt",
                mimeType: "text/plain",
                sizeBytes: file.length,
              },
            ],
          },
        };
        assert.strictEqual((yield* native.send(attached)).replayed, false);
        assert.strictEqual((yield* native.send(attached)).replayed, true);
        const writes = f.calls.filter((call) => call.method === "chat.stream");
        assert.strictEqual(writes.length, 1);
        assert.deepStrictEqual(writes[0]?.params.items, [
          {
            type: "image",
            mime_type: "image/png",
            filename: "image.png",
            data_base64: image.toString("base64"),
          },
          {
            type: "file",
            mime_type: "text/plain",
            filename: "file.txt",
            data_base64: file.toString("base64"),
          },
        ]);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(directory, "file.txt"), "different-file"),
        );
        assert.strictEqual(nativeErrorKind(yield* Effect.flip(native.send(attached))), "conflict");
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 1);
      }).pipe(Effect.provide(f.layer)),
    ),
  ),
);

it.effect(
  "refuses attachment symlink escapes and files over the product limit before native admission",
  () =>
    withAttachmentDirectory((root) =>
      withFixture((f) =>
        Effect.gen(function* () {
          const native = yield* Native.MuseAgentNativeRuntimeService;
          const directory = NodePath.join(root, "attachments");
          yield* Effect.promise(() => NodeFSP.mkdir(directory));
          const foreign = NodePath.join(root, "outside.txt");
          yield* Effect.promise(() => NodeFSP.writeFile(foreign, "synthetic"));
          yield* Effect.promise(() =>
            NodeFSP.symlink(foreign, NodePath.join(directory, "file.txt")),
          );
          const attachment = {
            type: "file",
            id: "file",
            name: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 9,
          };
          assert.strictEqual(
            nativeErrorKind(
              yield* Effect.flip(
                native.send({ ...request, attachments: { directory, items: [attachment] } }),
              ),
            ),
            "unsupported",
          );
          assert.strictEqual(
            nativeErrorKind(
              yield* Effect.flip(
                native.send({
                  ...request,
                  attachments: {
                    directory,
                    items: [{ ...attachment, sizeBytes: 64 * 1024 * 1024 + 1 }],
                  },
                }),
              ),
            ),
            "protocol",
          );
          assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 0);
        }).pipe(Effect.provide(f.layer)),
      ),
    ),
);

const largeAttachment = (directory: string) => ({
  ...request,
  attachments: {
    directory,
    items: [
      {
        type: "file",
        id: "large",
        name: "large.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 10 * 1024 * 1024 + 1,
      },
    ],
  },
});
const createLargeFile = (directory: string) =>
  Effect.promise(() =>
    NodeFSP.writeFile(NodePath.join(directory, "large.bin"), Buffer.alloc(10 * 1024 * 1024 + 1, 7)),
  );

it.effect("uploads large server-owned files once and refuses replay with changed content", () =>
  withAttachmentDirectory((directory) =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        yield* createLargeFile(directory);
        const attached = largeAttachment(directory);
        assert.strictEqual((yield* native.send(attached)).replayed, false);
        const uploadCount = f.calls.filter((call) => call.method === "fs.write").length;
        assert.strictEqual(uploadCount, 21);
        const prompt = f.calls.find((call) => call.method === "chat.stream");
        const items = prompt?.params.items;
        assert.ok(Array.isArray(items));
        assert.deepStrictEqual(items[0], {
          type: "file_ref",
          mime_type: "application/octet-stream",
          filename: "large.bin",
          path: String((items[0] as { path: string }).path),
        });
        assert.match(
          String((items[0] as { path: string }).path),
          /^workspace\/uploads\/t3-muse\/[a-f0-9-]+\/large.bin$/,
        );
        assert.strictEqual((yield* native.send(attached)).replayed, true);
        assert.strictEqual(
          f.calls.filter((call) => call.method === "fs.write").length,
          uploadCount,
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(directory, "large.bin"),
            Buffer.alloc(10 * 1024 * 1024 + 1, 8),
          ),
        );
        const failure = yield* Effect.flip(native.send(attached));
        assert.strictEqual(nativeErrorKind(failure), "conflict");
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 1);
        assert.strictEqual(
          f.calls.filter((call) => call.method === "fs.write").length,
          uploadCount,
        );
      }).pipe(Effect.provide(f.layer)),
    ),
  ),
);

it.effect("failed staging abandons pre-prompt intent and permits a deliberate safe retry", () =>
  withAttachmentDirectory((directory) =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        yield* createLargeFile(directory);
        f.setStageHook(Effect.fail(new Transport.MuseAgentTransportError({ kind: "uncertain" })));
        const failure = yield* Effect.flip(native.send(largeAttachment(directory)));
        assert.isTrue(isPromptNotSubmitted(failure));
        assert.deepStrictEqual(f.deliveryRows(), []);
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 0);
        assert.strictEqual(f.calls.filter((call) => call.method === "fs.write").length, 1);
        f.setStageHook(Effect.void);
        assert.strictEqual((yield* native.send(largeAttachment(directory))).replayed, false);
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 1);
      }).pipe(Effect.provide(f.layer)),
    ),
  ),
);

it.effect("interrupted staging abandons only the intent before native chat admission", () =>
  withAttachmentDirectory((directory) =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        yield* createLargeFile(directory);
        const stageStarted = yield* Deferred.make<void>();
        f.setStageHook(
          Deferred.succeed(stageStarted, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const sending = yield* native.send(largeAttachment(directory)).pipe(Effect.forkChild);
        yield* Deferred.await(stageStarted);
        yield* Fiber.interrupt(sending);
        const interrupted = yield* Fiber.await(sending);
        assert.isTrue(Exit.isFailure(interrupted));
        if (Exit.isFailure(interrupted)) {
          const error = Cause.findErrorOption(interrupted.cause);
          assert.ok(Option.isSome(error));
          assert.isTrue(isPromptNotSubmitted(error.value));
        }
        assert.deepStrictEqual(f.deliveryRows(), []);
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 0);
        f.setStageHook(Effect.void);
        assert.strictEqual((yield* native.send(largeAttachment(directory))).replayed, false);
      }).pipe(Effect.provide(f.layer)),
    ),
  ),
);

it.effect("reserves inline image budget regardless of file ordering", () =>
  withAttachmentDirectory((directory) =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        const image = Buffer.alloc(8 * 1024 * 1024, 1);
        const file = Buffer.alloc(3 * 1024 * 1024, 2);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(directory, "image.png"), image),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(directory, "file.txt"), file));
        yield* native.send({
          ...request,
          attachments: {
            directory,
            items: [
              {
                type: "file",
                id: "file",
                name: "file.txt",
                mimeType: "text/plain",
                sizeBytes: file.length,
              },
              {
                type: "image",
                id: "image",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: image.length,
              },
            ],
          },
        });
        const items = f.calls.find((call) => call.method === "chat.stream")?.params.items;
        assert.ok(Array.isArray(items));
        assert.strictEqual((items[0] as { type: string }).type, "file_ref");
        assert.strictEqual((items[1] as { type: string }).type, "image");
        assert.strictEqual(f.calls.filter((call) => call.method === "fs.write").length, 6);
      }).pipe(Effect.provide(f.layer)),
    ),
  ),
);

it.effect("uncertain chat admission preserves intent without repeating large-file upload", () =>
  withAttachmentDirectory((directory) =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        yield* createLargeFile(directory);
        f.setFailSend();
        const failed = yield* Effect.flip(native.send(largeAttachment(directory)));
        assert.ok(failed._tag === "MuseAgentTransportError");
        assert.strictEqual(failed.kind, "uncertain");
        const uploads = f.calls.filter((call) => call.method === "fs.write").length;
        assert.strictEqual(uploads, 21);
        const repeated = yield* Effect.flip(native.send(largeAttachment(directory)));
        assert.ok(repeated._tag === "MuseAgentDeliveryError");
        assert.strictEqual(repeated.kind, "uncertain");
        assert.deepStrictEqual(f.deliveryRows(), [
          { delivery_key: request.deliveryKey, status: "intent" },
        ]);
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 1);
        assert.strictEqual(f.calls.filter((call) => call.method === "fs.write").length, uploads);
      }).pipe(Effect.provide(f.layer)),
    ),
  ),
);

it.effect("refuses total attachments over 128 MiB before ledger or cloud writes", () =>
  withAttachmentDirectory((directory) =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        const failure = yield* Effect.flip(
          native.send({
            ...request,
            attachments: {
              directory,
              items: Array.from({ length: 4 }, (_, index) => ({
                type: "file",
                id: `file-${index}`,
                name: `file-${index}.bin`,
                mimeType: "application/octet-stream",
                sizeBytes: 40 * 1024 * 1024,
              })),
            },
          }),
        );
        assert.isTrue(isPromptNotSubmitted(failure));
        assert.deepStrictEqual(f.deliveryRows(), []);
        assert.strictEqual(
          f.calls.some((call) => call.method === "fs.write" || call.method === "chat.stream"),
          false,
        );
      }).pipe(Effect.provide(f.layer)),
    ),
  ),
);

it.effect("reads received sandbox files through the same bounded account-bound runtime", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const native = yield* Native.MuseAgentNativeRuntimeService;
      f.setRemoteFile("workspace/exports/result.txt", Buffer.from("Synthetic received file"));
      const result = yield* native.readAttachment({
        binding,
        sandboxPath: "sandbox://workspace/exports/result.txt",
      });
      assert.strictEqual(Buffer.from(result.bytes).toString(), "Synthetic received file");
      assert.match(result.sha256, /^[a-f0-9]{64}$/);
      assert.deepStrictEqual(
        f.calls.map((call) => call.method),
        ["fs.stat", "fs.read"],
      );
      const rejected = yield* Effect.flip(
        native.readAttachment({ binding, sandboxPath: "sandbox://workspace/%2e%2e/secrets" }),
      );
      assert.strictEqual(rejected.kind, "protocol");
      f.switchAccount();
      assert.strictEqual(
        (yield* Effect.flip(
          native.readAttachment({ binding, sandboxPath: "sandbox://workspace/exports/result.txt" }),
        )).kind,
        "account_changed",
      );
      assert.strictEqual(f.calls.length, 2);
    }).pipe(Effect.provide(f.layer)),
  ),
);

it.effect(
  "invalidates connected readiness on session rotation without exposing the fingerprint",
  () => {
    const h = fixture();
    return Effect.gen(function* () {
      const native = yield* Native.MuseAgentNativeRuntimeService;
      yield* native.accountBinding;
      assert.strictEqual((yield* native.status).ready, true);
      h.switchAccount();
      const changed = yield* native.status;
      assert.strictEqual(changed.sessionPresent, true);
      assert.strictEqual(changed.ready, false);
      assert.strictEqual("accountBinding" in changed, false);
      assert.strictEqual("fingerprint" in changed, false);
      yield* native.accountBinding;
      assert.strictEqual((yield* native.status).accountBinding, "b".repeat(64));
      h.setUnreadable();
      assert.strictEqual((yield* native.status).ready, false);
    }).pipe(Effect.provide(h.layer), Effect.ensuring(Effect.sync(h.close)), Effect.scoped);
  },
);

it.effect("does not cache readiness if the session rotates during connection", () => {
  const h = fixture();
  return Effect.gen(function* () {
    const native = yield* Native.MuseAgentNativeRuntimeService;
    h.rotateDuringConnect();
    const error = yield* native.accountBinding.pipe(Effect.flip);
    assert.strictEqual(error._tag, "MuseAgentRuntimeError");
    assert.strictEqual((yield* native.status).ready, false);
  }).pipe(Effect.provide(h.layer), Effect.ensuring(Effect.sync(h.close)), Effect.scoped);
});
