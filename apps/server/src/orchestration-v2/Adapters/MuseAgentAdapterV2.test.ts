import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import { RunId, RunAttemptId, NodeId, ProviderTurnId } from "@t3tools/contracts";
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
import type { MuseAgentNativeEvent } from "../../museAgent/MuseAgentTransport.ts";
import * as ToolsPort from "../../museAgent/MuseAgentDirectToolsPort.ts";
import { NativeAgentDirectToolsError } from "../../mcp/direct/NativeAgentDirectTools.ts";
import { createMuseAgentAdapterV2 } from "./MuseAgentAdapterV2.ts";
import { makeMuseAgentProjection } from "./MuseAgentAdapterV2Projection.ts";
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
        const seen: ProviderAdapterV2Event[] = [];
        const operations: string[] = [];
        const native = makeNative({
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
            }),
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

it.effect(
  "revokes before stop and waits for owned native termination instead of completing on acknowledgement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turn = yield* makeTurn;
        const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
        const started = yield* Deferred.make<void>();
        const terminal = yield* Deferred.make<void>();
        const seen: ProviderAdapterV2Event[] = [];
        const operations: string[] = [];
        const native = makeNative({
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

it.effect("a session taken over by a side chat stops cleanly instead of failing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const frames = yield* Queue.unbounded<MuseAgentNativeEvent>();
      const native = makeNative({
        watch: () => Effect.succeed({ events: Stream.fromQueue(frames), close: Effect.void }),
      });
      const port = ToolsPort.MuseAgentDirectToolsPort.of({
        install: () => Effect.fail(new NativeAgentDirectToolsError({ code: "already_installed" })),
        start: () => Effect.succeed({ revoke: Effect.void, close: Effect.void }),
      });
      const adapter = yield* createMuseAgentAdapterV2(options).pipe(
        Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
        Effect.provideService(ProviderHost.ProviderHost, host),
        Effect.provideService(ToolsPort.MuseAgentDirectToolsPort, port),
      );
      const runtime = yield* adapter.openSession(sessionInput);
      const seen = yield* runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
      yield* Queue.offer(frames, { event: "transport.session_superseded" });
      const events = yield* Fiber.join(seen);
      const statuses = events.flatMap((event) =>
        event.type === "provider_session.updated" ? [event.providerSession.status] : [],
      );
      assert.deepStrictEqual(statuses, ["stopped"]);
    }),
  ),
);

it.effect("sends Monke context without changing visible prompts or attachment-only turns", () =>
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
          `T3 Code context: refer to the user only as Monke. Do not use a real name. For registered T3 tools, use the T3 Code device/node attached to this current message.\n\n${text}`,
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
