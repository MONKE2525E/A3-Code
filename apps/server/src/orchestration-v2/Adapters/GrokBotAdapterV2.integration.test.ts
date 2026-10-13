import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ProjectId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as EventSink from "../EventSink.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Option from "effect/Option";
import * as ProviderSessions from "../ProviderSessionManager.ts";
import { grokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  GrokBotNativeRuntimeService,
  NativeRuntimeError,
  type SettlementFrame,
  type Turn,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { createGrokBotAdapterV2 } from "./GrokBotAdapterV2.ts";
import { GrokBotManagedBinding, type GrokBotManagedTurn } from "./GrokBotManagedBinding.ts";
import {
  makeBindings,
  makeNative,
  makeTurn,
  options,
  selection,
  threadId,
} from "./GrokBotProvider.testkit.ts";

it.effect.each([
  "normal",
  "interrupt",
  "thread_stop",
  "snapshot",
  "prepared",
  "pending",
  "pending_forever",
  "pending_rejected",
  "eof",
  "transport",
  "transcript",
] as const)("dispatches and settles a genuine V2 root with recovery=%s", (scenario) =>
  Effect.gen(function* () {
    const reconnect = scenario === "snapshot";
    const fixtureTurn = yield* makeTurn;
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-bot-v2-test-" });
    const sent = yield* Deferred.make<Turn>();
    const turnCommitted = yield* Deferred.make<void>();
    const settled = yield* Deferred.make<SettlementFrame>();
    const completed = yield* Deferred.make<void>();
    const disconnect = yield* Deferred.make<void>();
    const transcriptReopened = yield* Deferred.make<void>();
    const transcriptVisible = yield* Deferred.make<void>();
    let prepared: GrokBotManagedTurn | undefined;
    let writes = 0;
    let watches = 0;
    let accepted = false;
    let statusChecks = 0;
    let transcriptWatches = 0;
    const nativeAttempts: Turn[] = [];
    const interruptedSessions: Pick<Turn, "binding" | "botId" | "sessionId">[] = [];
    const logs: unknown[] = [];
    const native = makeNative({
      interrupt: (input) =>
        Effect.sync(() => {
          interruptedSessions.push(input);
          return { hadActiveRun: true };
        }),
      sendStatus: () =>
        Effect.sync(() => ({
          status:
            scenario === "pending_forever" ||
            (++statusChecks === 1 && (scenario === "pending" || scenario === "pending_rejected"))
              ? ("pending" as const)
              : scenario === "pending_rejected"
                ? ("rejected" as const)
                : accepted
                  ? ("accepted" as const)
                  : ("not_found" as const),
        })),
      startTurn: (turn) =>
        Effect.gen(function* () {
          nativeAttempts.push(turn);
          if (scenario === "prepared" && nativeAttempts.length === 1)
            return yield* new NativeRuntimeError({ kind: "uncertain" });
          writes++;
          accepted = true;
          yield* Deferred.succeed(sent, turn);
          return { delivery: "accepted" as const };
        }),
      watch: () => {
        transcriptWatches++;
        if (transcriptWatches === 2 && scenario === "eof")
          return Stream.fromEffect(Deferred.succeed(transcriptReopened, undefined)).pipe(
            Stream.flatMap(() => Stream.never),
          );
        if (scenario === "transcript")
          return Stream.fromEffect(Deferred.await(sent)).pipe(
            Stream.flatMap((turn) =>
              Stream.fromIterable([
                { _tag: "Cleared", generation: 1 } as const,
                {
                  _tag: "Rows" as const,
                  generation: 1,
                  entries: [
                    {
                      seq: "1",
                      updatedSeq: "1",
                      value: {
                        id: "external-user",
                        kind: "message",
                        role: "user",
                        content: "native history prompt",
                        timestampMs: 1000,
                      },
                    },
                    {
                      seq: "2",
                      updatedSeq: "2",
                      value: {
                        id: "external-answer",
                        kind: "send-message",
                        message: { type: "text", content: "native history reply" },
                        timestampMs: 1001,
                      },
                    },
                    {
                      seq: "3",
                      updatedSeq: "3",
                      value: {
                        id: "managed-echo",
                        kind: "message",
                        role: "user",
                        content: turn.text,
                        clientNonce: turn.messageId,
                        requestId: "managed-request",
                        timestampMs: 1002,
                      },
                    },
                    {
                      seq: "4",
                      updatedSeq: "4",
                      value: {
                        id: "managed-answer",
                        kind: "send-message",
                        message: { type: "text", content: "owned native reply" },
                        requestId: "managed-request",
                        timestampMs: 1003,
                      },
                    },
                  ],
                  deletes: [],
                  replay: true,
                },
              ]),
            ),
            Stream.concat(Stream.never),
          );
        return transcriptWatches === 1 && (scenario === "eof" || scenario === "transport")
          ? Stream.fromEffect(Deferred.await(disconnect)).pipe(
              Stream.flatMap(() =>
                scenario === "eof"
                  ? Stream.empty
                  : Stream.fail(new NativeRuntimeError({ kind: "uncertain" })),
              ),
            )
          : Stream.never;
      },
      openSettlementWatch: () =>
        Effect.sync(() => {
          watches++;
          return {
            events: Stream.fromEffect(Deferred.await(settled)).pipe(Stream.concat(Stream.never)),
          };
        }),
    });
    const bindings = makeBindings(fixtureTurn, {
      restoreTurns: () =>
        Effect.sync(() => (prepared === undefined ? [] : [grokBotTurnIdentity(prepared)])),
      prepareTurn: (request) =>
        Effect.sync(() => {
          prepared = {
            ...fixtureTurn,
            native: request.native,
            input: request.turn,
            nativePrompt: request.turn.message.text,
            providerTurnId: request.providerTurnId,
          };
          return prepared;
        }),
    });
    const registryLayer = Layer.effect(
      Registry.ProviderAdapterRegistryV2,
      createGrokBotAdapterV2(options).pipe(
        Effect.map((adapter) =>
          Registry.ProviderAdapterRegistryV2.of({
            get: () => Effect.succeed(adapter),
            list: () => Effect.succeed([options.instanceId]),
          }),
        ),
        Effect.provideService(GrokBotNativeRuntimeService, native),
        Effect.provideService(GrokBotManagedBinding, bindings),
      ),
    ).pipe(Layer.provide(IdAllocator.layer));
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* orchestrator.streamStoredEvents.pipe(
        Stream.runForEach(({ event }) =>
          event.type === "provider-turn.updated"
            ? Deferred.succeed(turnCommitted, undefined).pipe(Effect.asVoid)
            : event.type === "turn-item.updated" &&
                event.payload.type === "assistant_message" &&
                event.payload.text === "owned native reply"
              ? Deferred.succeed(transcriptVisible, undefined).pipe(Effect.asVoid)
              : event.type === "run.updated" &&
                  ["waiting", "completed", "failed", "cancelled", "interrupted"].includes(
                    event.payload.status,
                  )
                ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
                : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("grok-bot:create"),
        threadId,
        projectId: ProjectId.make("grok-bot-project"),
        title: "Native bot root",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      // This replay predates the newly sent prompt; keep the local test clock in the same epoch.
      if (scenario === "transcript") yield* TestClock.setTime(1002);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("grok-bot:dispatch"),
        threadId,
        messageId: MessageId.make("grok-bot:message"),
        text: "Own this task as the parent bot",
        attachments: [],
        modelSelection: selection,
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      yield* worker.drain();
      if (prepared === undefined) {
        return yield* Effect.die(
          `Native provider did not prepare the committed turn: ${JSON.stringify(logs)}`,
        );
      }
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      if (scenario === "pending_forever") {
        for (const delay of [5, 10, 20, 40, 60]) {
          assert.isTrue(Option.isSome(yield* worker.nextClaimableAt));
          yield* TestClock.adjust(`${delay} seconds`);
          yield* worker.drain();
        }
        assert.equal(writes, 0);
        assert.isTrue(Option.isNone(yield* worker.nextClaimableAt));
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.runs[0]?.status, "running");
        assert.equal(held.attempts[0]?.status, "running");
        return;
      }
      if (scenario === "pending_rejected") {
        assert.equal(writes, 0);
        yield* TestClock.adjust("5 seconds");
        yield* worker.drain();
        yield* Deferred.await(completed);
        const failed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(writes, 0);
        assert.equal(failed.runs[0]?.status, "failed");
        assert.equal(failed.attempts[0]?.status, "failed");
        return;
      }
      if (scenario === "prepared" || scenario === "pending") {
        assert.equal(writes, 0);
        assert.isTrue(Option.isSome(yield* worker.nextClaimableAt));
        yield* TestClock.adjust("5 seconds");
        yield* worker.drain();
        assert.equal(writes, 1);
        assert.equal(prepared.messageId, fixtureTurn.messageId);
        assert.equal(prepared.sentAtMs, fixtureTurn.sentAtMs);
        if (scenario === "prepared") assert.deepEqual(nativeAttempts[0], nativeAttempts[1]);
      }
      const message = yield* Deferred.await(sent);
      if (scenario === "interrupt" || scenario === "thread_stop")
        yield* Deferred.await(turnCommitted);
      if (scenario === "transcript") yield* Deferred.await(transcriptVisible);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0];
      const attempt = projection.attempts[0];
      const root = projection.nodes.find((node) => node.kind === "root_turn");
      if (
        prepared === undefined ||
        run === undefined ||
        attempt === undefined ||
        root === undefined
      )
        return yield* Effect.die(
          "Expected a committed V2 parent run, attempt, and root node before native send.",
        );
      assert.equal(prepared.input.runId, run.id);
      assert.equal(prepared.input.attemptId, attempt.id);
      assert.equal(prepared.input.rootNodeId, root.id);
      assert.equal(root.runId, run.id);
      assert.equal(message.messageId, prepared.messageId);
      assert.equal(message.sessionId, "");
      assert.equal(message.text, "Own this task as the parent bot");
      assert.equal(message.mcpConfig?.mcpServers.t3?.url, "https://fixture.invalid/mcp");
      if (scenario === "interrupt" || scenario === "thread_stop") {
        yield* orchestrator.dispatch(
          scenario === "interrupt"
            ? {
                type: "run.interrupt",
                commandId: CommandId.make("grok-bot:interrupt"),
                threadId,
                runId: run.id,
              }
            : {
                type: "thread.stop",
                commandId: CommandId.make("grok-bot:stop"),
                threadId,
              },
        );
        yield* worker.drain();
        yield* Deferred.await(completed);
        const stopped = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(interruptedSessions.length, 1);
        assert.equal(interruptedSessions[0]?.binding, message.binding);
        assert.equal(interruptedSessions[0]?.botId, message.botId);
        assert.equal(interruptedSessions[0]?.sessionId, message.sessionId);
        assert.equal(stopped.runs[0]?.status, "interrupted");
        assert.equal(stopped.attempts[0]?.status, "interrupted");
        assert.isTrue(
          stopped.turnItems.some(
            (item) => item.type === "run_interrupt_result" && item.status === "interrupted",
          ),
        );
        return;
      }
      if (scenario === "eof") {
        yield* Deferred.succeed(disconnect, undefined);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(transcriptReopened);
        yield* worker.drain();
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.runs[0]?.status, "running");
        assert.equal(writes, 1);
        assert.equal(transcriptWatches, 2);
      }
      if (scenario === "transport") {
        const originalEffects = yield* outbox.listByCommandId(CommandId.make("grok-bot:dispatch"));
        for (const _effect of originalEffects) {
          yield* outbox.awaitAvailable;
          yield* outbox.awaitAvailable;
        }
        yield* Deferred.succeed(disconnect, undefined);
        yield* outbox.awaitAvailable;
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.runs[0]?.status, "running");
        assert.isTrue(Option.isSome(yield* worker.nextClaimableAt));
        yield* TestClock.adjust("5 seconds");
        yield* worker.drain();
        assert.equal(writes, 1);
        assert.equal(watches, 2);
      }
      if (reconnect) {
        const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
        const providerSessionId = projection.providerThreads[0]?.providerSessionId;
        if (providerSessionId === undefined || providerSessionId === null)
          return yield* Effect.die("Expected a persisted provider session.");
        yield* sessions.close(providerSessionId);
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.runs[0]?.status, "running");
        yield* Deferred.succeed(settled, {
          _tag: "Settlement",
          clientNonce: message.messageId,
          outcome: "success",
          settledAtMs: 2000,
        });
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.writeWithEffects({
          events: [],
          effects: [
            {
              id: `effect:fixture:reconnect:${run.id}`,
              commandId: CommandId.make("fixture:reconnect"),
              threadId,
              request: { type: "provider-runtime.reconnect", runId: run.id },
            },
          ],
        });
        yield* TestClock.adjust("5 seconds");
        yield* worker.drain();
        assert.isAtLeast(watches, 2);
        assert.equal(writes, 1);
      }
      if (!reconnect)
        yield* Deferred.succeed(settled, {
          _tag: "Settlement",
          clientNonce: message.messageId,
          outcome: "success",
          settledAtMs: 2000,
        });
      yield* Deferred.await(completed);
      yield* worker.drain();
      const final = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(writes, 1);
      assert.equal(final.runs[0]?.id, run.id);
      assert.equal(final.runs[0]?.status, "completed");
      assert.equal(final.attempts[0]?.status, "completed");
      assert.equal(final.providerTurns[0]?.runAttemptId, attempt.id);
      assert.equal(final.providerTurns[0]?.nodeId, root.id);
      if (scenario === "transcript") {
        const timeline = yield* orchestrator.getTimelinePage(threadId, {
          view: "messages",
          limit: 20,
        });
        const chatItems = timeline.items.flatMap(({ item }) =>
          item.type === "user_message" || item.type === "assistant_message" ? [item] : [],
        );
        assert.deepEqual(
          chatItems.map((item) => item.text),
          [
            "native history prompt",
            "native history reply",
            "Own this task as the parent bot",
            "owned native reply",
          ],
        );
        const ownedReply = chatItems.find(
          (item) => item.type === "assistant_message" && item.text === "owned native reply",
        );
        assert.equal(ownedReply?.runId, run.id);
        assert.equal(ownedReply?.nodeId, root.id);
        assert.equal(ownedReply?.providerTurnId, prepared.providerTurnId);
        assert.equal(chatItems.filter((item) => item.type === "user_message").length, 2);
      }
    }).pipe(
      Effect.provide(
        layerWithRegistry(
          { name: "native-grok-bot-root", runtimePolicyOverride: { cwd } },
          registryLayer,
          { runEffectWorker: false },
        ),
      ),
      Effect.withLogger(
        Logger.make(({ message }) => {
          logs.push(message);
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
