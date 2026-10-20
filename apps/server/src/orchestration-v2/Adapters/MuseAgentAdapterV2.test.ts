import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import {
  ThreadId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  NodeId,
  ProviderTurnId,
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off -- A private native attachment fixture proves bytes precede published metadata.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderPromptNotSubmittedError } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Native from "../../museAgent/MuseAgentNativeRuntimeService.ts";
import { MuseAgentTransportError } from "../../museAgent/MuseAgentTransport.ts";
import type { MuseAgentNativeEvent } from "../../museAgent/MuseAgentTransport.ts";
import * as ToolsPort from "../../museAgent/MuseAgentDirectToolsPort.ts";
import { NativeAgentDirectToolsError } from "../../mcp/direct/NativeAgentDirectTools.ts";
import { createMuseAgentAdapterV2 } from "./MuseAgentAdapterV2.ts";
import { makeMuseAgentProjection } from "./MuseAgentAdapterV2Projection.ts";
import { museThreadIdForSession, museThreadIdentity } from "../../museAgent/MuseAgentThreadIds.ts";
import {
  binding,
  makeNative,
  makeTurn,
  options,
  policy,
  providerSessionId,
  selection,
  threadId,
  receipt,
  host,
} from "./MuseAgentAdapterV2.testkit.ts";

const sessionInput = {
  threadId,
  providerSessionId,
  modelSelection: selection,
  runtimePolicy: policy,
};
const isPromptNotSubmittedError = Schema.is(ProviderPromptNotSubmittedError);

it.effect.each([
  { global: true, browser: false, device: false, fail: false },
  { global: false, browser: true, device: false, fail: false },
  { global: true, browser: false, device: true, fail: false },
  { global: false, browser: true, device: true, fail: false },
  { global: true, browser: false, device: false, fail: true },
])("limits Muse tool grants to effective project access: %o", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      let settingsReads = 0;
      let grant: ToolsPort.MuseDirectToolTurnOptions | undefined;
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        enableAgentBrowserAccess: scenario.global,
        enableAgentDeviceAccess: scenario.global,
        projectSettingsOverrides: {
          [turn.appThread.projectId]: {
            enableAgentBrowserAccess: scenario.browser,
            enableAgentDeviceAccess: scenario.device,
          },
          other: {
            enableAgentBrowserAccess: !scenario.browser,
            enableAgentDeviceAccess: !scenario.device,
          },
        },
      };
      const adapter = yield* createMuseAgentAdapterV2(options).pipe(
        Effect.provideService(Native.MuseAgentNativeRuntimeService, makeNative()),
        Effect.provideService(ProviderHost.ProviderHost, {
          ...host,
          settings: {
            ...host.settings,
            get: Effect.suspend(() => {
              settingsReads++;
              return scenario.fail
                ? Effect.fail(
                    new ServerSettingsError({ settingsPath: "fixture", operation: "read-file" }),
                  )
                : Effect.succeed(settings);
            }),
          },
        }),
        Effect.provideService(
          ToolsPort.MuseAgentDirectToolsPort,
          ToolsPort.MuseAgentDirectToolsPort.of({
            install: () => Effect.succeed({ uninstall: Effect.void }),
            start: (input) =>
              Effect.sync(() => {
                grant = input;
                return { revoke: Effect.void, close: Effect.void };
              }),
          }),
        ),
      );
      const runtime = yield* adapter.openSession(sessionInput);
      assert.strictEqual(settingsReads, 0);
      yield* runtime.startTurn(turn);
      assert.strictEqual(settingsReads, 1);
      assert.isDefined(grant);
      assert.strictEqual(grant!.browserToolsAvailable, scenario.browser);
      assert.deepStrictEqual(
        [...grant!.capabilities].sort(),
        [
          "orchestration",
          "worktree",
          "pull-requests",
          ...(scenario.browser ? ["preview"] : []),
          ...(scenario.device ? ["device"] : []),
        ].sort(),
      );
    }),
  ),
);

it.effect(
  "loads older canonical pages through one watcher, deduplicates rows and fences stale cursors",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads: Array<number | undefined> = [];
        let watches = 0;
        const row = (seq: number) => ({
          event_name: "message.user",
          seq,
          occurred_at_ms: 1000 + seq,
          message_id: `page-user-${seq}`,
          payload: { display_text: `Synthetic ${seq}` },
        });
        const native = makeNative({
          read: ({ beforeSeq }) =>
            Effect.sync(() => {
              reads.push(beforeSeq);
              return beforeSeq === undefined
                ? {
                    events: [
                      row(20),
                      { ...row(11), event_name: "generation_state_update", payload: null },
                      row(10),
                    ],
                    hasMore: true,
                  }
                : beforeSeq === 10
                  ? { events: [row(9), row(5), row(5)], hasMore: true }
                  : { events: [row(0)], hasMore: false };
            }),
          watch: () =>
            Effect.sync(() => {
              watches++;
              return { events: Stream.never, close: Effect.void };
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(
            ToolsPort.MuseAgentDirectToolsPort,
            ToolsPort.MuseAgentDirectToolsPort.of({
              install: () => Effect.succeed({ uninstall: Effect.void }),
              start: () => Effect.die("History must not register tools"),
            }),
          ),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        assert.isDefined(runtime.loadHistoryPage);
        const collected = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn_item.updated"),
          Stream.take(5),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const initial = yield* runtime.loadHistoryPage!({ threadId });
        assert.deepStrictEqual(initial, { nextBeforeSeq: 10, hasMore: true, importedMessages: 0 });
        const older = yield* runtime.loadHistoryPage!({ threadId, beforeSeq: 10 });
        assert.deepStrictEqual(older, { nextBeforeSeq: 5, hasMore: true, importedMessages: 2 });
        const stale = yield* runtime.loadHistoryPage!({ threadId, beforeSeq: 10 }).pipe(
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(stale));
        const final = yield* runtime.loadHistoryPage!({ threadId, beforeSeq: 5 });
        assert.deepStrictEqual(final, { nextBeforeSeq: 0, hasMore: false, importedMessages: 1 });
        const events = yield* Fiber.join(collected);
        assert.deepStrictEqual(
          events.map((event) =>
            event.type === "turn_item.updated" ? event.turnItem.canonicalNativeSequence : undefined,
          ),
          [10, 20, 5, 9, 0],
        );
        assert.deepStrictEqual(reads, [undefined, 10, 5]);
        assert.strictEqual(watches, 1);
      }),
    ),
);

it.effect.each(["terminal", "stop"] as const)(
  "revokes host authority before %s without waiting for native callback removal",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
        const removing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const terminal = yield* Deferred.make<void>();
        let revoked = false,
          stopped = false;
        const native = makeNative({
          watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
          stop: () =>
            Effect.sync(() => {
              assert.strictEqual(revoked, true);
              stopped = true;
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () =>
            Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
          start: () =>
            Effect.succeed({
              revoke: Effect.sync(() => {
                revoked = true;
              }),
              close: Deferred.succeed(removing, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              ),
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal"
              ? Deferred.succeed(terminal, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const turn = yield* makeTurn;
        yield* runtime.startTurn(turn);
        if (mode === "stop") {
          yield* runtime.interruptTurn({
            providerThread: turn.providerThread,
            providerTurnId: ProviderTurnId.make(
              `provider-turn/muse-agent/${encodeURIComponent(turn.attemptId)}`,
            ),
          });
        }
        yield* Queue.offer(frames, {
          event: "delta.turn_done",
          payload: {
            session_id: "primary",
            reply_to_message_id: receipt.messageId,
            status: "completed",
          },
        });
        yield* Deferred.await(terminal);
        yield* Deferred.await(removing);
        assert.strictEqual(revoked, true);
        assert.strictEqual(stopped, mode === "stop");
        yield* Deferred.succeed(release, undefined);
      }),
    ),
);
it.effect(
  "bounds attachment imports without delaying terminal frames and releases failed imports",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
        const otherFrames = yield* Queue.unbounded<MuseAgentNativeEvent>();
        let watches = 0;
        const saturated = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const terminal = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        let active = 0;
        let peak = 0;
        let started = 0;
        let completed = 0;
        const native = makeNative({
          watch: () => {
            const queue = watches++ % 2 ? otherFrames : frames;
            return Effect.succeed({ events: Stream.fromQueue(queue), close: Effect.void });
          },
          readAttachment: () =>
            Effect.gen(function* () {
              started++;
              active++;
              peak = Math.max(peak, active);
              if (active === 2) yield* Deferred.succeed(saturated, undefined);
              yield* Deferred.await(released);
              return yield* Effect.fail(new Native.MuseAgentRuntimeError({ kind: "protocol" }));
            }).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  active--;
                  completed++;
                  if (completed === 8) yield* Deferred.succeed(finished, undefined);
                }),
              ),
            ),
        });
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
        const runtime = yield* adapter.openSession(sessionInput);
        const otherRuntime = yield* adapter.openSession(sessionInput);
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal" ? Deferred.succeed(terminal, undefined) : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turn);
        yield* otherRuntime.startTurn(turn);
        for (const queue of [frames, otherFrames]) {
          yield* Queue.offer(queue, {
            event: "message.assistant",
            payload: {
              session_id: "primary",
              message_id: "assistant-burst",
              reply_to_message_id: receipt.messageId,
              display_text: "Reports",
            },
          });
          for (let index = 0; index < 4; index++) {
            yield* Queue.offer(queue, {
              event: "delta.presentation",
              payload: {
                session_id: "primary",
                message_id: `presentation-${index}`,
                host_message_id: "assistant-burst",
                reply_to_message_id: receipt.messageId,
                kind: "file",
                data: {
                  file: {
                    path: `sandbox://workspace/user/files/report-${index}.txt`,
                    label: `Report ${index}`,
                    missing: false,
                  },
                },
              },
            });
          }
        }
        yield* Deferred.await(saturated);
        yield* Queue.offer(frames, {
          event: "delta.turn_done",
          payload: {
            session_id: "primary",
            reply_to_message_id: receipt.messageId,
            status: "completed",
          },
        });
        yield* Deferred.await(terminal);
        assert.strictEqual(started, 2);
        assert.strictEqual(active, 2);
        yield* Deferred.succeed(released, undefined);
        yield* Deferred.await(finished);
        assert.strictEqual(started, 8);
        assert.strictEqual(active, 0);
        assert.strictEqual(peak, 2);
      }),
    ),
);

it.effect(
  "imports attachments after persistence without delaying terminal or tool revocation",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-adapter-media-"))),
      (directory) =>
        Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* makeTurn;
            const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
            const entering = yield* Deferred.make<void>();
            const released = yield* Deferred.make<void>();
            const terminal = yield* Deferred.make<void>();
            const attached = yield* Deferred.make<void>();
            const bytes = Buffer.from("synthetic report");
            const seen: ProviderAdapterV2Event[] = [];
            let revoked = false;
            const records: Parameters<
              Native.MuseAgentNativeRuntimeService["Service"]["recordManagedMessage"]
            >[0][] = [];
            const native = makeNative({
              recordManagedMessage: (input) =>
                Effect.sync(() => {
                  records.push(input);
                }),
              watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
              readAttachment: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entering, undefined);
                  yield* Deferred.await(released);
                  return {
                    bytes,
                    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                  };
                }),
            });
            const port = ToolsPort.MuseAgentDirectToolsPort.of({
              install: () =>
                Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
              start: () =>
                Effect.succeed({
                  revoke: Effect.sync(() => {
                    revoked = true;
                  }),
                  close: Effect.void,
                }),
            });
            const adapter = yield* createMuseAgentAdapterV2(options).pipe(
              Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
              Effect.provideService(ProviderHost.ProviderHost, {
                ...host,
                paths: { ...host.paths, attachmentsDir: directory },
              }),
              Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
            );
            const runtime = yield* adapter.openSession(sessionInput);
            yield* runtime.events.pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  seen.push(event);
                  if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, undefined);
                  if (event.type === "message.updated" && event.message.attachments.length)
                    yield* Deferred.succeed(attached, undefined);
                }),
              ),
              Effect.forkScoped,
            );
            yield* runtime.startTurn(turn);
            yield* Queue.offer(frames, {
              event: "message.assistant",
              payload: {
                session_id: "primary",
                message_id: "assistant-1",
                reply_to_message_id: receipt.messageId,
                display_text: "The report is ready.",
              },
              meta: { seq: 1, ts_ms: 1234 },
            });
            yield* Queue.offer(frames, {
              event: "delta.presentation",
              payload: {
                session_id: "primary",
                message_id: "presentation-1",
                host_message_id: "assistant-1",
                reply_to_message_id: receipt.messageId,
                kind: "file",
                data: {
                  file: {
                    path: "sandbox://workspace/user/files/report.txt",
                    label: "Report",
                    missing: false,
                  },
                },
              },
              meta: { seq: 2, ts_ms: 1235 },
            });
            yield* Deferred.await(entering);
            yield* Queue.offer(frames, {
              event: "delta.turn_done",
              payload: {
                session_id: "primary",
                reply_to_message_id: receipt.messageId,
                status: "completed",
              },
            });
            yield* Deferred.await(terminal);
            assert.strictEqual(revoked, true);
            assert.strictEqual(
              seen.some(
                (event) => event.type === "message.updated" && event.message.attachments.length > 0,
              ),
              false,
            );
            yield* runtime.startTurn({
              ...turn,
              runId: RunId.make("muse-next-run"),
              attemptId: RunAttemptId.make("muse-next-attempt"),
              rootNodeId: NodeId.make("muse-next-node"),
              runOrdinal: 2,
              providerTurnOrdinal: 2,
            });
            yield* Deferred.succeed(released, undefined);
            yield* Deferred.await(attached);
            const message = seen.find(
              (event) => event.type === "message.updated" && event.message.attachments.length > 0,
            );
            assert.ok(message?.type === "message.updated");
            assert.strictEqual(message.message.runId, turn.runId);
            assert.strictEqual(message.message.text, "The report is ready.");
            const path = resolveAttachmentPath({
              attachmentsDir: directory,
              attachment: message.message.attachments[0]!,
            });
            assert.ok(path);
            assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(path)), bytes);
            const latest = records.findLast(
              (record) => record.snapshot.message.attachments.length > 0,
            );
            assert.ok(latest);
            assert.strictEqual(latest.deliveryKey, turn.attemptId);
            assert.strictEqual(latest.snapshot.message.runId, turn.runId);
            assert.ok(latest.snapshot.turnItem.providerTurnId);
            const restored = makeMuseAgentProjection({
              binding,
              providerInstanceId: options.instanceId,
              sessionId: "primary",
              threadId,
              ownership: {
                receipts: [],
                messages: [
                  {
                    nativeMessageId: latest.nativeMessageId,
                    deliveryKey: latest.deliveryKey,
                    context: {
                      threadId,
                      providerInstanceId: options.instanceId,
                      runId: turn.runId,
                      nodeId: turn.rootNodeId,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: latest.snapshot.turnItem.providerTurnId,
                      userMessageId: turn.message.messageId,
                    },
                    snapshot: latest.snapshot,
                    frozen: true,
                  },
                ],
              },
            }).restore();
            const restoredMessage = restored.find((event) => event.type === "message.updated");
            assert.ok(restoredMessage);
            assert.deepStrictEqual(
              restoredMessage.message.attachments,
              message.message.attachments,
            );
          }),
        ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    ),
);

it.effect("disconnect interrupts pending registration before it can admit a native turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
      const registrationStarted = yield* Deferred.make<void>();
      const registrationBlocked = yield* Deferred.make<void>();
      const registrationClosed = yield* Deferred.make<void>();
      let sends = 0;
      const native = makeNative({
        watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
        registerTools: (_, input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(registrationStarted, undefined);
            yield* Deferred.await(registrationBlocked);
            return { accepted: 0, connectionId: input.connectionId };
          }),
        unregisterTools: () => Deferred.succeed(registrationClosed, undefined).pipe(Effect.asVoid),
        send: () =>
          Effect.sync(() => {
            sends++;
            return receipt;
          }),
      });
      const port = ToolsPort.MuseAgentDirectToolsPort.of({
        install: () => Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
        start: (input) =>
          input
            .register({}, (invocation) =>
              Effect.succeed({
                method: "client.invoke.result",
                params: { invoke_id: "unused", ok: true },
                options: { expectedConnectionId: invocation.connectionId },
              }),
            )
            .pipe(Effect.map((result) => ({ revoke: Effect.void, close: result.close }))),
      });
      const adapter = yield* createMuseAgentAdapterV2(options).pipe(
        Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
        Effect.provideService(ProviderHost.ProviderHost, host),
        Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
      );
      const runtime = yield* adapter.openSession(sessionInput);
      const starting = yield* runtime.startTurn(turn).pipe(Effect.forkScoped);
      yield* Deferred.await(registrationStarted);
      yield* Queue.offer(frames, { event: "transport.disconnected" });
      yield* Deferred.await(registrationClosed);
      assert.strictEqual(Exit.isFailure(yield* Fiber.await(starting)), true);
      yield* Deferred.succeed(registrationBlocked, undefined);
      assert.strictEqual(sends, 0);
    }),
  ),
);

it.effect.each([false, true])(
  "only recovers durable Muse deliveries with terminal replay evidence: terminal=%s",
  (terminal) =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        const released = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        let sends = 0;
        let replays = 0;
        let revokes = 0;
        const native = makeNative({
          acquireTurn: () =>
            Effect.succeed(Deferred.succeed(released, undefined).pipe(Effect.asVoid)),
          send: () =>
            Effect.sync(() => {
              sends++;
              return { ...receipt, replayed: true };
            }),
          replay: () =>
            Effect.sync(() => {
              replays++;
              return terminal
                ? [
                    {
                      event_name: "delta.turn_done",
                      seq: 9,
                      occurred_at_ms: 1234,
                      reply_to_message_id: "user-1",
                      payload: { session_id: "primary", status: "completed" },
                    },
                  ]
                : [];
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () => Effect.succeed({ uninstall: Effect.void }),
          start: () =>
            Effect.succeed({
              revoke: Effect.sync(() => {
                revokes++;
              }),
              close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        const events = yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const result = yield* Effect.exit(runtime.startTurn(turn));
        assert.strictEqual(Exit.isSuccess(result), terminal);
        if (!terminal) {
          assert.strictEqual(Exit.isFailure(yield* Fiber.await(events)), true);
          assert.strictEqual(Exit.isFailure(yield* Effect.exit(runtime.startTurn(turn))), true);
        }
        yield* Deferred.await(closed);
        yield* Deferred.await(released);
        assert.strictEqual(sends, 1);
        assert.strictEqual(replays, 1);
        assert.strictEqual(revokes, 1);
      }),
    ),
);

it.effect(
  "fails an unsettled reconnected turn instead of advertising a ready runtime without tools",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
        const released = yield* Deferred.make<void>();
        const seen: ProviderAdapterV2Event[] = [];
        let sends = 0;
        let revokes = 0;
        let replays = 0;
        const native = makeNative({
          watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
          acquireTurn: () =>
            Effect.succeed(Deferred.succeed(released, undefined).pipe(Effect.asVoid)),
          send: () =>
            Effect.sync(() => {
              sends++;
              return receipt;
            }),
          replay: () =>
            Effect.sync(() => {
              replays++;
              return [];
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () =>
            Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
          start: () =>
            Effect.succeed({
              revoke: Effect.sync(() => {
                revokes++;
              }),
              close: Effect.void,
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        const events = yield* runtime.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turn);
        yield* Queue.offer(frames, { event: "transport.disconnected" });
        yield* Queue.offer(frames, { event: "transport.reconnected" });
        assert.strictEqual(Exit.isFailure(yield* Fiber.await(events)), true);
        yield* Deferred.await(released);
        assert.strictEqual(sends, 1);
        assert.strictEqual(revokes, 1);
        assert.strictEqual(replays, 1);
        assert.strictEqual(
          seen.some((event) => event.type === "turn.terminal"),
          false,
        );
        assert.strictEqual(
          seen.some(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "ready",
          ),
          false,
        );
      }),
    ),
);

it.effect(
  "reconnect revokes tools and recovers exact owned terminal evidence without resending",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
        const terminal = yield* Deferred.make<void>();
        let sends = 0;
        let closes = 0;
        let replays = 0;
        const native = makeNative({
          watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
          send: () =>
            Effect.sync(() => {
              sends++;
              return receipt;
            }),
          replay: (input) =>
            Effect.sync(() => {
              replays++;
              assert.deepStrictEqual(input.receipt, receipt);
              return [
                {
                  event_name: "delta.turn_done",
                  seq: 9,
                  occurred_at_ms: 1234,
                  reply_to_message_id: "user-1",
                  payload: { session_id: "primary", status: "completed" },
                },
              ];
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () =>
            Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
          start: () =>
            Effect.succeed({
              revoke: Effect.void,
              close: Effect.sync(() => {
                closes++;
              }),
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal" ? Deferred.succeed(terminal, undefined) : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turn);
        yield* Queue.offer(frames, { event: "transport.disconnected" });
        yield* Queue.offer(frames, { event: "transport.reconnected" });
        yield* Deferred.await(terminal);
        assert.strictEqual(sends, 1);
        assert.strictEqual(closes, 1);
        assert.strictEqual(replays, 1);
      }),
    ),
);

it.effect(
  "registers the exact turn through the early port before sending and revokes on native terminal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
        const terminal = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const leaseReleased = yield* Deferred.make<void>();
        const cleanupAllowed = yield* Deferred.make<void>();
        const seen: ProviderAdapterV2Event[] = [];
        const operations: string[] = [];
        const native = makeNative({
          acquireTurn: () =>
            Effect.succeed(
              Effect.sync(() => {
                operations.push("release");
              }).pipe(Effect.andThen(Deferred.succeed(leaseReleased, undefined))),
            ),
          watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
          registerTools: (_, input) =>
            Effect.sync(() => {
              operations.push("register");
              assert.strictEqual(input.nativeSessionId, "primary");
              assert.strictEqual(input.connectionId, "generation-1");
              return { accepted: 1, connectionId: input.connectionId };
            }),
          unregisterTools: () =>
            Effect.sync(() => {
              operations.push("unregister");
            }).pipe(Effect.andThen(Deferred.await(cleanupAllowed))),
          send: (input) =>
            Effect.sync(() => {
              operations.push("send");
              assert.match(
                input.clientId ?? "",
                /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
              );
              return receipt;
            }),
          settleDelivery: () =>
            Effect.sync(() => {
              operations.push("settle");
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () =>
            Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
          start: (input) =>
            Effect.gen(function* () {
              assert.strictEqual(input.threadId, threadId);
              assert.strictEqual(input.providerInstanceId, options.instanceId);
              assert.deepStrictEqual(input.remoteRun, {
                runId: turn.runId,
                attemptId: turn.attemptId,
              });
              assert.strictEqual(input.accountBinding, binding);
              assert.strictEqual(input.nativeSessionId, "primary");
              assert.strictEqual(yield* input.isCurrent, true);
              const registered = yield* input.register(
                {
                  "t3.probe": {
                    description: "Synthetic probe",
                    required: { params_json: { type: 1, description: "Arguments" } },
                    optional: {},
                    permissions: [],
                    datatype: "",
                    timeout_ms: 60000,
                  },
                },
                (invoke) =>
                  Effect.succeed({
                    method: "client.invoke.result",
                    params: { invoke_id: "unused", ok: true },
                    options: { expectedConnectionId: invoke.connectionId },
                  }),
              );
              return { revoke: Effect.void, close: registered.close };
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              seen.push(event);
              if (event.type === "provider_turn.updated")
                yield* Deferred.succeed(started, undefined);
              if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turn);
        yield* Deferred.await(started);
        assert.deepStrictEqual(operations, ["register", "send"]);
        yield* Queue.offer(frames, {
          event: "delta.turn_done",
          payload: { session_id: "primary", reply_to_message_id: "user-1", status: "completed" },
        });
        yield* Deferred.await(terminal);
        assert.deepStrictEqual(operations, ["register", "send", "settle", "unregister"]);
        yield* Deferred.succeed(cleanupAllowed, undefined);
        yield* Deferred.await(leaseReleased);
        assert.deepStrictEqual(operations, ["register", "send", "settle", "unregister", "release"]);
        assert.strictEqual(seen.filter((event) => event.type === "turn.terminal").length, 1);
      }),
    ),
);

it.effect(
  "fails before sending when tools are unavailable and allows a corrected pre-admission retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        let sends = 0;
        let installed = false;
        const native = makeNative({
          send: () =>
            Effect.sync(() => {
              sends++;
              return receipt;
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () =>
            Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
          start: () =>
            installed
              ? Effect.succeed({ revoke: Effect.void, close: Effect.void })
              : Effect.fail(new NativeAgentDirectToolsError({ code: "not_installed" })),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        const failure = yield* Effect.flip(runtime.startTurn(turn));
        assert.strictEqual(failure._tag, "ProviderAdapterTurnStartError");
        assert.isTrue(
          failure._tag === "ProviderAdapterTurnStartError" &&
            isPromptNotSubmittedError(failure.cause),
        );
        assert.strictEqual(sends, 0);
        installed = true;
        yield* runtime.startTurn(turn);
        assert.strictEqual(sends, 1);
      }),
    ),
);

it.live.each([1, 3])(
  "rebuilds interrupted Muse tool setup with bounded retries (%s failures)",
  (failures) =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        let registrations = 0;
        let sends = 0;
        let cleaned = 0;
        const native = makeNative({
          send: () =>
            Effect.sync(() => {
              sends++;
              return receipt;
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () =>
            Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
          start: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  cleaned++;
                }),
              );
              registrations++;
              if (registrations <= failures)
                return yield* new NativeAgentDirectToolsError({
                  code: "registration_failed",
                  cause: new MuseAgentTransportError({ kind: "disconnected", stage: "register" }),
                });
              return { revoke: Effect.void, close: Effect.void };
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        const result = yield* runtime.startTurn(turn).pipe(Effect.exit);
        assert.strictEqual(Exit.isSuccess(result), failures === 1);
        assert.strictEqual(registrations, failures === 1 ? 2 : 3);
        assert.strictEqual(cleaned, failures);
        assert.strictEqual(sends, failures === 1 ? 1 : 0);
      }),
    ),
);

it.effect(
  "revokes before stop and waits for owned native termination instead of completing on acknowledgement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
        const started = yield* Deferred.make<void>();
        const terminal = yield* Deferred.make<void>();
        const leaseReleased = yield* Deferred.make<void>();
        const seen: ProviderAdapterV2Event[] = [];
        const operations: string[] = [];
        const native = makeNative({
          acquireTurn: () =>
            Effect.succeed(
              Effect.sync(() => {
                operations.push("release");
              }).pipe(Effect.andThen(Deferred.succeed(leaseReleased, undefined))),
            ),
          watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
          stop: () =>
            Effect.sync(() => {
              operations.push("stop");
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () =>
            Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
          start: () =>
            Effect.succeed({
              revoke: Effect.sync(() => {
                operations.push("revoke");
              }),
              close: Effect.void,
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        let providerTurnId:
          | Parameters<typeof runtime.interruptTurn>[0]["providerTurnId"]
          | undefined;
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              seen.push(event);
              if (event.type === "provider_turn.updated") {
                providerTurnId = event.providerTurn.id;
                yield* Deferred.succeed(started, undefined);
              }
              if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turn);
        yield* Deferred.await(started);
        assert.ok(providerTurnId);
        yield* runtime.interruptTurn({ providerThread: turn.providerThread, providerTurnId });
        assert.deepStrictEqual(operations, ["revoke", "stop"]);
        assert.strictEqual(
          seen.some((event) => event.type === "turn.terminal"),
          false,
        );
        yield* Queue.offer(frames, {
          event: "delta.turn_done",
          payload: { session_id: "primary", reply_to_message_id: "user-1", status: "interrupted" },
        });
        yield* Deferred.await(terminal);
        yield* Deferred.await(leaseReleased);
        assert.deepStrictEqual(operations, ["revoke", "stop", "release"]);
        assert.strictEqual(
          seen.find((event) => event.type === "turn.terminal")?.status,
          "interrupted",
        );
      }),
    ),
);

it.effect(
  "settles superseded local delivery and revokes tools without cancelling the foreign native turn",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
        const terminal = yield* Deferred.make<void>();
        const replacement = yield* Deferred.make<void>();
        const seen: ProviderAdapterV2Event[] = [];
        const operations: string[] = [];
        const native = makeNative({
          watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
          settleDelivery: (key) =>
            Effect.sync(() => {
              assert.strictEqual(key, turn.attemptId);
              operations.push("settle");
            }),
          stop: () =>
            Effect.sync(() => {
              operations.push("stop");
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () =>
            Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
          start: () =>
            Effect.succeed({
              revoke: Effect.void,
              close: Effect.sync(() => {
                operations.push("revoke");
              }),
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              seen.push(event);
              if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, undefined);
              if (
                event.type === "turn_item.updated" &&
                event.turnItem.nativeItemRef?.nativeId === "foreign-answer"
              )
                yield* Deferred.succeed(replacement, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turn);
        yield* Queue.offer(frames, {
          event: "transport.turn_superseded",
          payload: {
            session_id: receipt.sessionId,
            message_id: receipt.messageId,
            reply_to_message_id: receipt.replyToMessageId,
          },
        });
        yield* Deferred.await(terminal);
        yield* Queue.offer(frames, {
          event: "message.assistant",
          payload: {
            session_id: "primary",
            message_id: "foreign-answer",
            reply_to_message_id: "foreign-user",
            display_text: "Foreign reply",
          },
          meta: { seq: 34481, ts_ms: 1791881828599 },
        });
        yield* Deferred.await(replacement);
        assert.deepStrictEqual(operations, ["settle", "revoke"]);
        assert.strictEqual(seen.filter((event) => event.type === "turn.terminal").length, 1);
        assert.strictEqual(
          seen.find((event) => event.type === "turn.terminal")?.status,
          "interrupted",
        );
        const item = seen.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "foreign-answer",
        );
        assert.ok(item?.type === "turn_item.updated");
        assert.strictEqual(item.turnItem.runId, null);
        assert.strictEqual(item.turnItem.providerTurnId, null);
      }),
    ),
);

it.effect("ignores a delayed supersession notice without revoking the current delivery tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
      const answer = yield* Deferred.make<void>();
      const terminal = yield* Deferred.make<void>();
      let closes = 0;
      const seen: ProviderAdapterV2Event[] = [];
      const native = makeNative({
        watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
      });
      const port = ToolsPort.MuseAgentDirectToolsPort.of({
        install: () => Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
        start: () =>
          Effect.succeed({
            revoke: Effect.void,
            close: Effect.sync(() => {
              closes++;
            }),
          }),
      });
      const adapter = yield* createMuseAgentAdapterV2(options).pipe(
        Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
        Effect.provideService(ProviderHost.ProviderHost, host),
        Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
      );
      const runtime = yield* adapter.openSession(sessionInput);
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            seen.push(event);
            if (event.type === "message.updated") {
              assert.strictEqual(closes, 0);
              yield* Deferred.succeed(answer, undefined);
            }
            if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turn);
      yield* Queue.offer(frames, {
        event: "transport.turn_superseded",
        payload: {
          session_id: receipt.sessionId,
          message_id: "old-user",
          reply_to_message_id: "old-carrier",
        },
      });
      yield* Queue.offer(frames, {
        event: "message.assistant",
        payload: {
          session_id: receipt.sessionId,
          message_id: "owned-answer",
          reply_to_message_id: receipt.messageId,
          display_text: "Current answer",
        },
        meta: { seq: 1, ts_ms: 1234 },
      });
      yield* Deferred.await(answer);
      assert.strictEqual(
        seen.some(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "waiting",
        ),
        false,
      );
      yield* Queue.offer(frames, {
        event: "delta.turn_done",
        payload: {
          session_id: receipt.sessionId,
          reply_to_message_id: receipt.messageId,
          status: "completed",
        },
      });
      yield* Deferred.await(terminal);
      assert.strictEqual(closes, 1);
      assert.strictEqual(seen.find((event) => event.type === "turn.terminal")?.status, "completed");
    }),
  ),
);

it.effect(
  "retires displaced observers so returning to a conversation restores history and live updates",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let current: Queue.Queue<MuseAgentNativeEvent, Cause.Done> | undefined;
        const watched: string[] = [];
        const read: string[] = [];
        const native = makeNative({
          resolveSession: (_, sessionId) =>
            Effect.succeed({
              session_id: sessionId ?? "primary",
              status: "idle",
              is_primary: sessionId === undefined,
              is_thread: sessionId !== undefined,
            }),
          watch: ({ sessionId }) =>
            Effect.gen(function* () {
              if (current) {
                yield* Queue.offer(current, { event: "transport.session_superseded" });
                yield* Queue.end(current);
              }
              const frames = yield* Queue.unbounded<MuseAgentNativeEvent, Cause.Done>();
              current = frames;
              watched.push(sessionId);
              return { events: Stream.fromQueue(frames), close: Queue.shutdown(frames) };
            }),
          read: ({ sessionId }) =>
            Effect.sync(() => {
              read.push(sessionId);
              return {
                events: [
                  {
                    event_name: "message.user",
                    seq: read.length,
                    message_id: `history-${read.length}`,
                    occurred_at_ms: 1000 + read.length,
                    payload: { display_text: `History ${read.length}` },
                  },
                ],
                hasMore: false,
              };
            }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(
            ToolsPort.MuseAgentDirectToolsPort,
            ToolsPort.MuseAgentDirectToolsPort.of({
              install: () => Effect.succeed({ uninstall: Effect.void }),
              start: () => Effect.die("Observation must not register tools"),
            }),
          ),
        );
        const first = yield* adapter.openSession(sessionInput);
        const firstEvents = yield* first.events.pipe(Stream.runCollect, Effect.forkScoped);
        const second = yield* adapter.openSession({
          ...sessionInput,
          threadId: ThreadId.make(
            museThreadIdForSession(museThreadIdentity(binding, options.instanceId), "side"),
          ),
          providerSessionId: ProviderSessionId.make("muse-side-session"),
        });
        const retiredFirst = yield* Fiber.join(firstEvents);
        const last = retiredFirst.at(-1);
        assert.strictEqual(last?.type, "provider_session.updated");
        assert.strictEqual(
          last?.type === "provider_session.updated" && last.providerSession.status,
          "stopped",
        );
        const secondEvents = yield* second.events.pipe(Stream.runCollect, Effect.forkScoped);
        const reopened = yield* adapter.openSession(sessionInput);
        const retiredSecond = yield* Fiber.join(secondEvents);
        assert.isTrue(
          retiredSecond.some(
            (event) =>
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped",
          ),
        );
        const resumed = yield* reopened.events.pipe(
          Stream.filter((event) => event.type === "message.updated"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        if (!current) return yield* Effect.die("Expected a fresh native watcher");
        yield* Queue.offer(current, {
          event: "message.user",
          payload: {
            session_id: "primary",
            message_id: "live-after-return",
            display_text: "Live after return",
          },
          meta: { seq: 4, ts_ms: 1004 },
        });
        const updates = yield* Fiber.join(resumed);
        assert.deepStrictEqual(
          updates.map((event) => event.message.text),
          ["History 3", "Live after return"],
        );
        assert.deepStrictEqual(watched, ["primary", "side", "primary"]);
        assert.deepStrictEqual(read, ["primary", "side", "primary"]);
      }),
    ),
);

it.effect("does not restart a retired observer after waiting for turn admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const frames = yield* Queue.unbounded<MuseAgentNativeEvent, Cause.Done>();
      const acquiring = yield* Deferred.make<void>();
      const admitted = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let watches = 0;
      let sends = 0;
      let releases = 0;
      const native = makeNative({
        watch: () =>
          Effect.sync(() => {
            watches++;
            return { events: Stream.fromQueue(frames), close: Queue.shutdown(frames) };
          }),
        acquireTurn: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(acquiring, undefined);
            yield* Deferred.await(admitted);
            return Effect.sync(() => {
              releases++;
            }).pipe(Effect.andThen(Deferred.succeed(released, undefined)));
          }),
        send: () =>
          Effect.sync(() => {
            sends++;
            return receipt;
          }),
      });
      const adapter = yield* createMuseAgentAdapterV2(options).pipe(
        Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
        Effect.provideService(ProviderHost.ProviderHost, host),
        Effect.provideService(
          ToolsPort.MuseAgentDirectToolsPort,
          ToolsPort.MuseAgentDirectToolsPort.of({
            install: () => Effect.succeed({ uninstall: Effect.void }),
            start: () => Effect.die("Retired observers must not register tools"),
          }),
        ),
      );
      const runtime = yield* adapter.openSession(sessionInput);
      const ended = yield* runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
      const start = yield* runtime.startTurn(yield* makeTurn).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(acquiring);
      yield* Queue.offer(frames, { event: "transport.session_superseded" });
      yield* Queue.end(frames);
      yield* Fiber.join(ended);
      yield* Deferred.succeed(admitted, undefined);
      const result = yield* Fiber.join(start);
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(watches, 1);
      assert.strictEqual(sends, 0);
      yield* Deferred.await(released);
      assert.strictEqual(releases, 1);
    }),
  ),
);

it.effect("sends a skill reference without changing visible or attachment-only prompts", () =>
  Effect.forEach(["Synthetic task", ""], (text) =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = yield* makeTurn;
        const attachment = {
          type: "file" as const,
          id: "synthetic-file",
          name: "fixture.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        };
        const turn = { ...base, message: { ...base.message, text, attachments: [attachment] } };
        const sent: Parameters<Native.MuseAgentNativeRuntimeService["Service"]["send"]>[0][] = [];
        const native = makeNative({
          send: (input) =>
            Effect.sync(() => {
              sent.push(input);
              return receipt;
            }),
        });
        const port = ToolsPort.MuseAgentDirectToolsPort.of({
          install: () =>
            Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
          start: () => Effect.succeed({ revoke: Effect.void, close: Effect.void }),
        });
        const adapter = yield* createMuseAgentAdapterV2(options).pipe(
          Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
        );
        const runtime = yield* adapter.openSession(sessionInput);
        yield* runtime.startTurn(turn);
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(
          sent[0]?.text,
          `${text}\n\n[T3 Code: load workspace/custom-skills/t3-code-muse/SKILL.md; use this message's T3 node.]`,
        );
        assert.strictEqual(sent[0]?.deliveryKey, turn.attemptId);
        assert.deepStrictEqual(sent[0]?.attachments, {
          directory: host.paths.attachmentsDir,
          items: [attachment],
        });
        assert.strictEqual(turn.message.text, text);
        assert.deepStrictEqual(turn.message.attachments, [attachment]);
      }),
    ),
  ),
);

it.effect("rejects noncanonical and foreign account thread IDs before native session lookup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const resolves: Array<string | undefined> = [];
      const native = makeNative({
        resolveSession: (_binding, sessionId) =>
          Effect.sync(() => {
            resolves.push(sessionId);
            return {
              session_id: sessionId ?? "primary",
              is_primary: sessionId === undefined,
              is_thread: sessionId !== undefined,
              status: "idle",
            };
          }),
      });
      const adapter = yield* createMuseAgentAdapterV2(options).pipe(
        Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
        Effect.provideService(ProviderHost.ProviderHost, host),
        Effect.provideService(
          ToolsPort.MuseAgentDirectToolsPort,
          ToolsPort.MuseAgentDirectToolsPort.of({
            install: () =>
              Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
            start: () => Effect.die("No tools may start for a rejected thread"),
          }),
        ),
      );
      for (const id of [
        "generated-thread",
        `muse-agent:${"b".repeat(64)}`,
        `${threadId}:%ZZ`,
        `${threadId}:side%2fone`,
      ]) {
        const error = yield* adapter
          .openSession({ ...sessionInput, threadId: ThreadId.make(id) })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterOpenSessionError");
      }
      assert.deepEqual(resolves, []);
      yield* adapter.openSession(sessionInput);
      yield* adapter.openSession({
        ...sessionInput,
        threadId: ThreadId.make(`${threadId}:session%3A42%2Fx`),
      });
      assert.deepEqual(resolves, [undefined, "session:42/x"]);
    }),
  ),
);
