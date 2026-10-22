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
import * as T3Skill from "./MuseAgentT3Skill.ts";

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
  let ready = true;
  let stageHook: Effect.Effect<void, Transport.MuseAgentTransportError> = Effect.void;
  let preDispatchHook: Effect.Effect<void, Transport.MuseAgentTransportError> = Effect.void;
  let admissionHook: Effect.Effect<void, Transport.MuseAgentTransportError> = Effect.void;
  let acquireTurn: Transport.MuseAgentTransport["Service"]["acquireTurn"] = () =>
    Effect.succeed(Effect.void);
  let watch: Transport.MuseAgentTransport["Service"]["watch"] = () =>
    Effect.succeed({ events: Stream.never, close: Effect.void });
  const remoteSizes = new Map<string, number>();
  const remoteBytes = new Map<string, Uint8Array>();
  let inspections = 0;
  let skillFailure = false;
  const skillActions: string[] = [];
  let history: unknown[] = [];
  let streamHistory: unknown[] = [];
  let widgetApplied = true;
  let loseWidgetReply = false;
  let identity: unknown = {
    name: "Synthetic Muse",
    avatar: { image_path: "workspace/avatars/muse.webp", chat_theme_color: "#aabbcc" },
  };
  const cancellations: Delivery.MuseAgentReceipt[] = [];
  const localReleases: string[] = [];
  const transport = Transport.MuseAgentTransport.of({
    acquireTurn: (account, sessionId) => acquireTurn(account, sessionId),
    releaseOwned: (_, input) =>
      Effect.sync(() => {
        localReleases.push(input.deliveryKey);
      }),
    connect: Effect.suspend(() => {
      if (!ready)
        return Effect.fail(new Transport.MuseAgentTransportError({ kind: "disconnected" }));
      if (rotateDuringConnect) fingerprint = "session-b";
      return Effect.succeed(authority);
    }),
    request: (_, method, params, _write, _deliveryKey, onDispatch) =>
      Effect.gen(function* () {
        if (method === "chat.stream") yield* preDispatchHook;
        onDispatch?.();
        calls.push({ method, params });
        if (method === "sessions.list")
          return {
            sessions: [
              { session_id: "primary", is_primary: true, is_thread: false, status: "idle" },
            ],
          };
        if (method === "identity") return identity;
        if (method === "chat.history") return { chat_events: history, has_more: false };
        if (method === "widgets.state.set") {
          const state = { version: Number(params.base_version) + 1, data: params.state };
          if (widgetApplied) {
            history = history.map((event) => ({
              ...(event as typeof optionEvent),
              payload: {
                ...(event as typeof optionEvent).payload,
                widgets: (event as typeof optionEvent).payload.widgets.map((widget) =>
                  widget.widget_id === params.widget_id ? { ...widget, state } : widget,
                ),
              },
            }));
          }
          if (loseWidgetReply)
            return yield* new Transport.MuseAgentTransportError({ kind: "disconnected" });
          return { applied: widgetApplied, state };
        }
        if (method === "chat.stream_events") return { events: streamHistory };
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
        Layer.succeed(T3Skill.MuseAgentT3Skill, {
          install: () =>
            Effect.suspend(() => {
              skillActions.push("install");
              return skillFailure
                ? Effect.fail(new T3Skill.MuseAgentT3SkillError({ kind: "readback_failed" }))
                : Effect.void;
            }),
          verify: () =>
            Effect.suspend(() => {
              skillActions.push("verify");
              return skillFailure
                ? Effect.fail(new T3Skill.MuseAgentT3SkillError({ kind: "readback_failed" }))
                : Effect.void;
            }),
        }),
      ),
    ),
  );
  return {
    layer,
    delivery,
    skillActions,
    failSkill: () => {
      skillFailure = true;
    },
    setAcquireTurn: (next: typeof acquireTurn) => {
      acquireTurn = next;
    },
    setPreDispatchHook: (next: typeof preDispatchHook) => {
      preDispatchHook = next;
    },
    calls,
    loseWidgetReply: () => {
      loseWidgetReply = true;
    },
    setStreamHistory: (events: unknown[]) => {
      streamHistory = events;
    },
    setHistory: (events: unknown[]) => {
      history = events;
    },
    refuseWidgetSelection: () => {
      widgetApplied = false;
    },
    cancellations,
    localReleases,
    remotePaths: () => [...remoteSizes.keys()],
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
    setReady: (value: boolean) => {
      ready = value;
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
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Deferred.complete(foreignObserved, Effect.die(exit.cause))
                : Effect.void,
            ),
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
        // Native readiness can disappear while already admitted frames are
        // waiting on local ownership. Both readers must keep projecting them.
        f.setReady(false);
        assert.strictEqual((yield* native.accountBinding.pipe(Effect.flip)).kind, "disconnected");
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
            video_variants: {
              "waiting-for-subagents": "workspace/avatars/waiting.mp4",
              waiting_for_subagents: "workspace/avatars/waiting-legacy.mp4",
              "../secret": "workspace/avatars/secret.mp4",
              IMAGE: "workspace/avatars/image.mp4",
              ["a".repeat(65)]: "workspace/avatars/long.mp4",
              working: "workspace/avatars/../secrets.mp4",
            },
          },
        });
        const next = yield* native.profile(binding);
        assert.strictEqual(next.name, "SyntheticMuse");
        assert.strictEqual(next.avatarImagePath, undefined);
        assert.strictEqual(next.avatarPath, undefined);
        assert.strictEqual(next.chatThemeColor, undefined);
        assert.deepStrictEqual(next.avatarVideoVariants, {
          "waiting-for-subagents": "workspace/avatars/waiting.mp4",
          waiting_for_subagents: "workspace/avatars/waiting-legacy.mp4",
        });
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

it.effect("account verification failure after staging abandons the undispatched intent", () =>
  withAttachmentDirectory((directory) =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        yield* createLargeFile(directory);
        f.setStageHook(
          Effect.sync(() => {
            f.setPreDispatchHook(
              Effect.fail(new Transport.MuseAgentTransportError({ kind: "account_changed" })),
            );
          }),
        );
        const failure = yield* Effect.flip(native.send(largeAttachment(directory)));
        assert.isTrue(isPromptNotSubmitted(failure));
        assert.deepStrictEqual(f.deliveryRows(), []);
        assert.deepStrictEqual(f.remotePaths(), []);
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 0);
        f.setPreDispatchHook(Effect.void);
        f.setStageHook(Effect.void);
        assert.strictEqual((yield* native.send(largeAttachment(directory))).replayed, false);
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

it.effect.each(["failure", "interruption"] as const)(
  "removes completed uploads after a later staging %s",
  (outcome) =>
    withAttachmentDirectory((directory) =>
      withFixture((f) =>
        Effect.gen(function* () {
          const native = yield* Native.MuseAgentNativeRuntimeService;
          yield* createLargeFile(directory);
          yield* Effect.promise(() =>
            NodeFSP.copyFile(
              NodePath.join(directory, "large.bin"),
              NodePath.join(directory, "later.bin"),
            ),
          );
          const attached = largeAttachment(directory);
          const first = attached.attachments.items[0]!;
          attached.attachments.items.push({ ...first, id: "later", name: "later.bin" });
          const laterStarted = yield* Deferred.make<void>();
          let chunks = 0;
          f.setStageHook(
            Effect.suspend(() => {
              chunks++;
              if (chunks <= 21) return Effect.void;
              return Deferred.succeed(laterStarted, undefined).pipe(
                Effect.andThen(
                  outcome === "failure"
                    ? Effect.fail(new Transport.MuseAgentTransportError({ kind: "uncertain" }))
                    : Effect.never,
                ),
              );
            }),
          );
          if (outcome === "failure") {
            assert.isTrue(isPromptNotSubmitted(yield* Effect.flip(native.send(attached))));
          } else {
            const sending = yield* native.send(attached).pipe(Effect.forkChild);
            yield* Deferred.await(laterStarted);
            yield* Fiber.interrupt(sending);
          }
          assert.deepStrictEqual(f.remotePaths(), []);
          assert.deepStrictEqual(f.deliveryRows(), []);
          assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 0);
          f.setStageHook(Effect.void);
          yield* native.send(attached);
          assert.strictEqual(f.remotePaths().length, 2);
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
        assert.strictEqual(f.remotePaths().length, 1);
        assert.strictEqual(f.calls.filter((call) => call.method === "fs.delete").length, 0);
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

it.effect(
  "rejects a foreign unsettled delivery after acquiring and releases the native route",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const native = yield* Native.MuseAgentNativeRuntimeService;
        let acquisitions = 0;
        let releases = 0;
        f.setAcquireTurn(() =>
          Effect.sync(() => {
            acquisitions++;
            return Effect.sync(() => {
              releases++;
            });
          }),
        );
        yield* f.delivery.begin(request);
        const failure = yield* Effect.flip(
          native.acquireTurn(binding, "side-chat").pipe(Effect.asVoid),
        );
        assert.strictEqual(failure._tag, "MuseAgentDeliveryError");
        assert.strictEqual(failure.kind, "busy");
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(releases, 1);
        yield* yield* native.acquireTurn(binding, "primary");
        assert.strictEqual(acquisitions, 2);
        assert.strictEqual(releases, 2);
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect("rechecks persisted delivery ownership after waiting and releases a refused route", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const native = yield* Native.MuseAgentNativeRuntimeService;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let releases = 0;
      f.setAcquireTurn(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
          return Effect.sync(() => {
            releases++;
          });
        }),
      );
      const acquiring = yield* native
        .acquireTurn(binding, "side-chat")
        .pipe(Effect.asVoid, Effect.flip, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* f.delivery.begin(request);
      yield* Deferred.succeed(resume, undefined);
      const failure = yield* Fiber.join(acquiring);
      assert.strictEqual(failure._tag, "MuseAgentDeliveryError");
      assert.strictEqual(failure.kind, "busy");
      assert.strictEqual(releases, 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped),
  ),
);

it.effect("queues behind an active session and admits the next after durable settlement", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const native = yield* Native.MuseAgentNativeRuntimeService;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      f.setAcquireTurn(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.as(Effect.void),
        ),
      );
      yield* f.delivery.begin(request);
      yield* f.delivery.accept(request.deliveryKey, {
        sessionId: request.sessionId,
        messageId: "accepted-user",
        replyToMessageId: "accepted-carrier",
      });
      const acquiring = yield* native.acquireTurn(binding, "side-chat").pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* f.delivery.settle(request.deliveryKey);
      yield* Deferred.succeed(resume, undefined);
      yield* yield* Fiber.join(acquiring);
    }).pipe(Effect.provide(f.layer), Effect.scoped),
  ),
);

const optionSelection = {
  widgetId: "widget-337c44f0-e5c2-4f59-b902-1b79b863dcda",
  hostMessageId: "assistant-1",
  text: "Make a T3 Code skill",
  interactionId: "c3cd22b0-b756-436c-9e5a-78e78f7c5abd",
};
const optionEvent = {
  event_name: "message.assistant",
  session_id: "primary",
  message_id: "assistant-1",
  payload: {
    widgets: [
      {
        kind: "option",
        widget_id: optionSelection.widgetId,
        data: { options: [optionSelection.text] },
        state: { version: 3, data: {} },
      },
    ],
  },
};
it.effect("sends a native option with its versioned selection and message origin", () => {
  const f = fixture();
  f.setHistory([optionEvent]);
  return Effect.gen(function* () {
    const service = yield* Native.MuseAgentNativeRuntimeService;
    yield* service.send({ ...request, optionSelection });
    assert.deepStrictEqual(f.calls.find((call) => call.method === "widgets.state.set")?.params, {
      widget_id: optionSelection.widgetId,
      base_version: 3,
      mutation_id: optionSelection.interactionId,
      state: { selectedText: optionSelection.text },
    });
    assert.deepStrictEqual(
      f.calls.find((call) => call.method === "chat.stream")?.params.message_origin,
      {
        kind: "options_widget",
        widget_id: optionSelection.widgetId,
        message_id: "assistant-1",
        option_index: 0,
        interaction_id: optionSelection.interactionId,
      },
    );
  }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
});
it.effect("does not send when native option selection loses a version conflict", () => {
  const f = fixture();
  f.setHistory([optionEvent]);
  f.refuseWidgetSelection();
  return Effect.gen(function* () {
    const service = yield* Native.MuseAgentNativeRuntimeService;
    const result = yield* Effect.exit(service.send({ ...request, optionSelection }));
    assert.isTrue(Exit.isFailure(result));
    assert.isFalse(f.calls.some((call) => call.method === "chat.stream"));
  }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
});

it.effect("restores the native option after a known pre-dispatch failure and permits retry", () => {
  const f = fixture();
  f.setHistory([optionEvent]);
  f.setPreDispatchHook(
    Effect.fail(new Transport.MuseAgentTransportError({ kind: "disconnected" })),
  );
  return Effect.gen(function* () {
    const service = yield* Native.MuseAgentNativeRuntimeService;
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(service.send({ ...request, optionSelection }))),
    );
    assert.deepStrictEqual(
      f.calls.filter((call) => call.method === "widgets.state.set").map((call) => call.params),
      [
        {
          widget_id: optionSelection.widgetId,
          base_version: 3,
          mutation_id: optionSelection.interactionId,
          state: { selectedText: optionSelection.text },
        },
        {
          widget_id: optionSelection.widgetId,
          base_version: 4,
          mutation_id: f.calls.filter((call) => call.method === "widgets.state.set")[1]!.params
            .mutation_id,
          state: {},
        },
      ],
    );
    f.setPreDispatchHook(Effect.void);
    yield* service.send({ ...request, optionSelection });
    assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 1);
  }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
});

it.effect("retains the delivery intent when native selection response is lost", () => {
  const f = fixture();
  f.setHistory([optionEvent]);
  f.loseWidgetReply();
  return Effect.gen(function* () {
    const service = yield* Native.MuseAgentNativeRuntimeService;
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(service.send({ ...request, optionSelection }))),
    );
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(service.send({ ...request, optionSelection }))),
    );
    assert.isFalse(f.calls.some((call) => call.method === "chat.stream"));
    assert.strictEqual(f.calls.filter((call) => call.method === "widgets.state.set").length, 1);
  }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
});

it.effect("retains the delivery intent when selection cleanup cannot be confirmed", () => {
  const f = fixture();
  f.setHistory([optionEvent]);
  f.setPreDispatchHook(
    Effect.gen(function* () {
      f.refuseWidgetSelection();
      return yield* new Transport.MuseAgentTransportError({ kind: "disconnected" });
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Native.MuseAgentNativeRuntimeService;
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(service.send({ ...request, optionSelection }))),
    );
    f.setPreDispatchHook(Effect.void);
    const retry = yield* Effect.exit(service.send({ ...request, optionSelection }));
    assert.isTrue(Exit.isFailure(retry));
    assert.isFalse(f.calls.some((call) => call.method === "chat.stream"));
    assert.strictEqual(f.calls.filter((call) => call.method === "widgets.state.set").length, 2);
  }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
});

it.effect("does not restore a selected option after uncertain chat admission", () => {
  const f = fixture();
  f.setHistory([optionEvent]);
  f.setAdmissionHook(Effect.fail(new Transport.MuseAgentTransportError({ kind: "disconnected" })));
  return Effect.gen(function* () {
    const service = yield* Native.MuseAgentNativeRuntimeService;
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(service.send({ ...request, optionSelection }))),
    );
    assert.strictEqual(f.calls.filter((call) => call.method === "widgets.state.set").length, 1);
  }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
});

it.effect("send refreshes and verifies the managed skill before delivery", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const native = yield* Native.MuseAgentNativeRuntimeService;
    f.failSkill();
    const result = yield* native.send(request).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    assert.deepStrictEqual(f.skillActions, ["install"]);
    assert.isFalse(f.calls.some((call) => call.method === "chat.stream"));
  }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
});

it.effect("recovers an accepted receipt without requiring the skill again", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const native = yield* Native.MuseAgentNativeRuntimeService;
    const first = yield* native.send(request);
    f.failSkill();
    const replay = yield* native.send(request);
    assert.strictEqual(replay.messageId, first.messageId);
    assert.isTrue(replay.replayed);
    assert.deepStrictEqual(f.skillActions, ["install"]);
    assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 1);
  }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(f.close)));
});

it.effect.each([
  "owned",
  "foreign",
  "subagent",
  "activity_lane",
  "tool_lane",
  "activity_surface",
  "tool_surface",
  "other_session",
  "incomplete",
])("recovers a saved delivery only with exact native terminal proof: %s", (evidence) =>
  withFixture((f) =>
    Effect.gen(function* () {
      const related = evidence === "owned";
      const native = yield* Native.MuseAgentNativeRuntimeService;
      const receipt = yield* native.send(request);
      f.setStreamHistory([
        {
          event_name: "delta.turn_done",
          seq: 10,
          occurred_at_ms: 2000,
          reply_to_message_id:
            evidence === "foreign" ? "foreign-receipt" : receipt.replyToMessageId,
          session_id: evidence === "other_session" ? "other" : "primary",
          payload: {
            session_id: "primary",
            status: evidence === "incomplete" ? "running" : "completed",
            ...(evidence === "subagent" ? { stream_lane: "subagent" } : {}),
            ...(evidence === "activity_lane" ? { stream_lane: "activity" } : {}),
            ...(evidence === "tool_lane" ? { stream_lane: "tool" } : {}),
            ...(evidence === "activity_surface" ? { transcript_surface: "activity" } : {}),
            ...(evidence === "tool_surface" ? { transcript_surface: "tool" } : {}),
          },
        },
      ]);
      const next = yield* Effect.exit(native.send({ ...request, deliveryKey: "attempt-2" }));
      assert.strictEqual(Exit.isSuccess(next), related);
      assert.strictEqual(
        f.calls.filter((call) => call.method === "chat.stream").length,
        related ? 2 : 1,
      );
      assert.deepStrictEqual(f.cancellations, []);
      assert.deepStrictEqual(
        (yield* native.pendingDeliveries(request)).map((entry) => entry.deliveryKey),
        [related ? "attempt-2" : request.deliveryKey],
      );
    }).pipe(Effect.provide(f.layer)),
  ),
);

it.effect(
  "reconciles a completed receipt after rebuilding the runtime before acquiring the next turn",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const receipt = yield* Effect.gen(function* () {
          const native = yield* Native.MuseAgentNativeRuntimeService;
          return yield* native.send(request);
        }).pipe(Effect.provide(f.layer));
        f.setStreamHistory([
          {
            event_name: "delta.turn_done",
            seq: 10,
            occurred_at_ms: 2000,
            reply_to_message_id: receipt.replyToMessageId,
            payload: { session_id: "primary", status: "completed" },
          },
        ]);
        yield* Effect.gen(function* () {
          const native = yield* Native.MuseAgentNativeRuntimeService;
          const release = yield* native.acquireTurn(binding, "primary");
          assert.deepStrictEqual(yield* native.pendingDeliveries(request), []);
          yield* native.send({ ...request, deliveryKey: "attempt-after-restart" });
          yield* release;
        }).pipe(Effect.provide(f.layer));
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 2);
        assert.deepStrictEqual(f.cancellations, []);
      }),
    ),
);

it.effect(
  "keeps an accepted receipt attached after restart until its exact live main terminal arrives",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const native = yield* Native.MuseAgentNativeRuntimeService;
          yield* native.send(request);
        }).pipe(Effect.provide(f.layer));
        f.setStreamHistory([]);
        yield* Effect.gen(function* () {
          const native = yield* Native.MuseAgentNativeRuntimeService;
          const scope = { binding, sessionId: "primary" };
          assert.isTrue(yield* native.reconcilePendingDeliveries(scope));
          assert.isTrue(
            yield* native.reconcilePendingDeliveries({
              ...scope,
              terminalEvent: {
                event: "delta.turn_done",
                payload: {
                  session_id: "primary",
                  reply_to_message_id: "carrier-1",
                  status: "completed",
                  transcript_surface: "activity",
                },
              },
            }),
          );
          assert.strictEqual((yield* native.pendingDeliveries(scope)).length, 1);
          assert.isFalse(
            yield* native.reconcilePendingDeliveries({
              ...scope,
              terminalEvent: {
                event: "delta.turn_done",
                payload: {
                  session_id: "primary",
                  reply_to_message_id: "carrier-1",
                  status: "completed",
                  stream_lane: "main",
                  transcript_surface: "main_chat",
                },
              },
            }),
          );
          assert.deepStrictEqual(yield* native.pendingDeliveries(scope), []);
          yield* native.send({ ...request, deliveryKey: "attempt-after-live-recovery" });
        }).pipe(Effect.provide(f.layer));
        assert.strictEqual(f.calls.filter((call) => call.method === "chat.stream").length, 2);
      }),
    ),
);
