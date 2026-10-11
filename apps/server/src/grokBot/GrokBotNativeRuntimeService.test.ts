import * as Redacted from "effect/Redacted";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Native from "./GrokBotNativeService.ts";
import * as Runtime from "./GrokBotNativeRuntimeService.ts";

const turn = {
  binding: "fixture-binding",
  botId: "bot-1",
  sessionId: "owned-session",
  messageId: "persisted-nonce",
  sentAtMs: 1234,
  text: "work",
  taskId: "owned-task",
  mcpConfig: {
    mcpServers: {
      t3: {
        type: "http" as const,
        url: "https://fixture.invalid/mcp",
        headers: { Authorization: "Bearer run-secret" },
        placement: "server" as const,
        enabledTools: ["delegate_task"],
      },
    },
  },
};
const kind = (error: Runtime.RuntimeError) =>
  error._tag === "GrokBotNativeRuntimeError" ? error.kind : undefined;
const fixture = Effect.gen(function* () {
  const calls: { method: string; input: object }[] = [];
  const state = {
    delivery: "ACCEPTED_TEMPORAL",
    status: "PENDING",
    plugins: [{ pluginId: "1", name: "unrelated", mcpConfigJson: "unrelated-config" }],
    skills: [] as { id: string; name: string; description: string; body: string; source: string }[],
    ignoreSkillWrite: false,
    malformedSkills: false,
    failSkills: false,
    frames: [] as unknown[],
    failSend: false,
    finalized: false,
    watching: false,
    harness: "temporal" as string | undefined,
    missingBot: false,
    rosterError: undefined as Native.NativeReadError | Native.NativeSignedOutError | undefined,
    failGateway: false,
    gatewayRows: [] as unknown[],
    gatewayEvents: [] as { channel: string; payload: unknown }[],
    approvalResult: { dispatched: true, workflowId: "wf-approval" } as unknown,
    widgetResult: { accepted: true } as unknown,
  };
  const native = Layer.mock(Native.GrokBotNativeService)({
    accountBinding: Effect.succeed(turn.binding),
    gatewayRoster: () =>
      Effect.gen(function* () {
        calls.push({ method: "gatewayRoster", input: {} });
        if (state.failGateway) return yield* new Native.NativeReadError({ stage: "request" });
        assert.strictEqual(state.watching, true);
        return state.gatewayRows;
      }),
    gatewayEvents: (_binding, onReady) =>
      Stream.unwrap(
        Effect.gen(function* () {
          calls.push({ method: "gatewayEvents", input: {} });
          if (state.failGateway) return yield* new Native.NativeReadError({ stage: "response" });
          state.watching = true;
          if (onReady) yield* onReady;
          return Stream.fromIterable(state.gatewayEvents).pipe(
            Stream.concat(Stream.never),
            Stream.ensuring(
              Effect.sync(() => {
                state.finalized = true;
              }),
            ),
          );
        }),
      ),
    runtimeRequest: (_binding, method, input) =>
      Effect.gen(function* () {
        calls.push({ method, input });
        const body = input as Record<string, unknown>;
        switch (method) {
          case "ListGrokBotAgentSkills":
            if (state.failSkills) return yield* new Native.NativeReadError({ stage: "request" });
            return { skills: state.malformedSkills ? [{ name: "broken" }] : state.skills };
          case "AddGrokBotAgentSkill":
          case "UpdateGrokBotAgentSkill": {
            if (!state.ignoreSkillWrite) {
              const name = body.name as string;
              const content = body.content as string;
              assert.include(content, `name: ${JSON.stringify(name)}`);
              assert.include(content, `description: ${JSON.stringify(body.description)}`);
              const updated = {
                id: state.skills.find((skill) => skill.name === name)?.id ?? "native-skill-1",
                name,
                description: body.description as string,
                body: content.slice(content.indexOf("\n---\n\n") + 6),
                source: "native-fixture",
              };
              state.skills = [...state.skills.filter((skill) => skill.name !== name), updated];
            }
            return { skill: { name: body.name, content: body.content } };
          }
          case "ListGrokBotAgents":
            if (state.rosterError) return yield* state.rosterError;
            return {
              agents: state.missingBot
                ? []
                : [
                    {
                      agentId: "bot-1",
                      viewerSessionId: "owned-session",
                      ...(state.harness === undefined ? {} : { harness: state.harness }),
                      viewerIsOwner: true,
                      ownerDisplayName: "private",
                    },
                  ],
            };
          case "ListGrokBotAgentSessions":
            return { sessions: [{ agentId: "bot-1", sessionId: "owned-session", kind: "MAIN" }] };
          case "ListGrokBotTasks":
            return { tasks: [{ id: "task-list-item", state: "DONE", doneAtMs: "10" }] };
          case "SendGrokBotUserMessage":
            if (state.failSend) return yield* new Native.NativeReadError({ stage: "request" });
            return { delivery: state.delivery, workflowId: "workflow-1" };
          case "GetGrokBotSendStatus":
            return { status: state.status, echoEntryId: "echo-1", acceptedAtMs: "1234" };
          case "InterruptGrokBotAgentRun":
            return {};
          case "ResolveGrokBotAutoReviewApproval":
          case "ResolveGrokBotLocalToolPermission":
          case "ResolveGrokBotConnectorGrant":
            return state.approvalResult;
          case "RespondGrokBotWidget":
          case "DismissGrokBotWidget":
          case "SubmitGrokBotSecret":
            return state.widgetResult;
          case "ListGrokBotTranscriptEntries": {
            const card = (id: string, extra: object = {}) => ({
              body: Buffer.from(
                JSON.stringify({
                  id,
                  kind: "send-message",
                  message: {
                    type: "secret-request",
                    secretRequest: { label: `Key ${id}`, target: { kind: "box-env", name: "K" } },
                  },
                  ...extra,
                }),
              ).toString("base64"),
            });
            return {
              // Newest first, as native returns it; one blob-only row is skipped.
              entries: [
                card("s2", { respondedValue: "widget-value", widgetDismissed: true }),
                { blobHash: "abc" },
                card("s1", { secretProvided: true }),
              ],
            };
          }
          case "ForceRecreateSandBox":
            return { started: false, reason: "busy" };
          case "RecreateSandBox":
            return { started: true, operationId: "op-1" };
          case "GetSandBoxUpgradeSchedule":
            return { schedule: { timezone: "UTC", localTime: "03:00", nextFireAtMs: "99" } };
          case "GetGrokBotAgentPlugins":
            return { plugins: state.plugins };
          case "SetGrokBotAgentPlugins": {
            const entries = body.plugins as {
              pluginId?: string;
              configUpdate?: { pluginId: string; mcpConfigJson: string };
              inline?: { name: string; mcpConfigJson: string };
            }[];
            state.plugins = entries.map((entry) => {
              if (entry.inline) return { pluginId: "42", ...entry.inline };
              const id = entry.pluginId ?? entry.configUpdate?.pluginId;
              const existing = state.plugins.find((plugin) => plugin.pluginId === id);
              if (!existing) throw new Error("fixture missing plugin");
              return {
                ...existing,
                ...(entry.configUpdate ? { mcpConfigJson: entry.configUpdate.mcpConfigJson } : {}),
              };
            });
            return { plugins: state.plugins };
          }
        }
      }),
    watchTranscripts: (_binding, input) =>
      Stream.suspend(() => {
        calls.push({ method: "WatchGrokBotTranscripts", input });
        return Stream.fromIterable(state.frames).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              state.finalized = true;
            }),
          ),
        );
      }),
  });
  const service = Context.get(
    yield* Layer.build(Runtime.layer.pipe(Layer.provide(native))),
    Runtime.GrokBotNativeRuntimeService,
  );
  return { service, state, calls };
});
const managedSkill = {
  binding: turn.binding,
  botId: turn.botId,
  name: "t3-code-managed-turn-v1",
  description: "From T3 Code managed turns, version 1",
  body: "Use this turn's injected MCP server and complete the turn explicitly.",
};
it.effect(
  "provisions a native bot skill once, verifies body readback, and reconciles deletion and edits",
  () =>
    Effect.gen(function* () {
      const { service, state, calls } = yield* fixture;
      const unrelated = {
        id: "other",
        name: "other",
        description: "Other",
        body: "Keep",
        source: "native-fixture",
      };
      state.skills.push(unrelated);
      assert.deepStrictEqual(yield* service.ensureSkill(managedSkill), {
        skillId: "native-skill-1",
        changed: true,
      });
      assert.deepStrictEqual(yield* service.ensureSkill(managedSkill), {
        skillId: "native-skill-1",
        changed: false,
      });
      assert.equal(calls.filter((call) => call.method === "AddGrokBotAgentSkill").length, 1);
      assert.equal(calls.filter((call) => call.method === "ListGrokBotAgentSkills").length, 3);
      assert.deepStrictEqual(state.skills[0], unrelated);
      state.skills = state.skills.map((skill) =>
        skill.name === managedSkill.name ? { ...skill, body: "edited" } : skill,
      );
      assert.equal((yield* service.ensureSkill(managedSkill)).changed, true);
      assert.equal(calls.filter((call) => call.method === "UpdateGrokBotAgentSkill").length, 1);
      state.skills = [unrelated];
      assert.equal((yield* service.ensureSkill(managedSkill)).changed, true);
      assert.equal(calls.filter((call) => call.method === "AddGrokBotAgentSkill").length, 2);
      for (const call of calls)
        assert.deepStrictEqual((call.input as Record<string, unknown>).agentId, turn.botId);
    }).pipe(Effect.scoped),
);
it.effect("never trusts a successful skill write without readback or mutates duplicate names", () =>
  Effect.gen(function* () {
    const { service, state, calls } = yield* fixture;
    state.ignoreSkillWrite = true;
    assert.equal(kind(yield* service.ensureSkill(managedSkill).pipe(Effect.flip)), "uncertain");
    state.skills = [1, 2].map((id) => ({
      id: String(id),
      name: managedSkill.name,
      description: managedSkill.description,
      body: managedSkill.body,
      source: "fixture",
    }));
    const count = calls.length;
    assert.equal(
      kind(yield* service.ensureSkill(managedSkill).pipe(Effect.flip)),
      "skill_conflict",
    );
    assert.equal(calls.length, count + 1);
    state.malformedSkills = true;
    assert.equal(kind(yield* service.ensureSkill(managedSkill).pipe(Effect.flip)), "response");
    state.failSkills = true;
    assert.equal(
      (yield* service.ensureSkill(managedSkill).pipe(Effect.flip))._tag,
      "GrokBotNativeReadError",
    );
  }).pipe(Effect.scoped),
);
it.effect(
  "keeps the durable nonce, timestamp and per-message MCP config identical across duplicate sends",
  () =>
    Effect.gen(function* () {
      const { service, state, calls } = yield* fixture;
      assert.strictEqual((yield* service.startTurn(turn)).delivery, "accepted");
      state.delivery = "DUPLICATE";
      assert.strictEqual((yield* service.startTurn(turn)).delivery, "duplicate");
      assert.deepStrictEqual(calls[0], calls[1]);
      const body = calls[0]?.input as Record<string, unknown>;
      assert.deepStrictEqual(body, {
        agentId: turn.botId,
        sessionId: turn.sessionId,
        messageId: turn.messageId,
        text: turn.text,
        sentAtMs: "1234",
        taskId: turn.taskId,
        mcpConfigJson: JSON.stringify(turn.mcpConfig),
      });
      assert.strictEqual(
        calls.some((call) => call.method === "SetGrokBotAgentPlugins"),
        false,
      );
    }),
);
it.effect("reports ambiguous/refused sends without retry and preserves recovery status", () =>
  Effect.gen(function* () {
    const { service, state, calls } = yield* fixture;
    state.failSend = true;
    assert.strictEqual(
      (yield* service.startTurn(turn).pipe(Effect.flip))._tag,
      "GrokBotNativeReadError",
    );
    assert.strictEqual(calls.length, 1);
    assert.strictEqual((yield* service.sendStatus(turn)).status, "pending");
    state.status = "UNKNOWN_DURABILITY";
    assert.strictEqual((yield* service.sendStatus(turn)).status, "unknown_durability");
    state.failSend = false;
    state.delivery = "REFUSED";
    assert.strictEqual(kind(yield* service.startTurn(turn).pipe(Effect.flip)), "refused");
    state.delivery = "UNSPECIFIED";
    assert.strictEqual(kind(yield* service.startTurn(turn).pipe(Effect.flip)), "uncertain");
    const interrupt = yield* service.interrupt(turn);
    assert.deepStrictEqual(interrupt, { hadActiveRun: false });
    assert.deepStrictEqual(calls.at(-1)?.input, {
      agentId: turn.botId,
      sessionId: turn.sessionId,
      reason: "user_interrupt",
    });
  }),
);
it.effect(
  "retains row/update/delete cursors and filters other sessions without inferring completion",
  () =>
    Effect.gen(function* () {
      const { service, state, calls } = yield* fixture;
      const entry = {
        kind: "send-message",
        isStreaming: false,
        taskId: turn.taskId,
        message: { type: "text", content: "reply" },
      };
      state.frames = [
        {
          rows: {
            agentId: turn.botId,
            sessionId: "other-session",
            generation: 1,
            entries: [{ seq: "1", updatedSeq: "1", body: Buffer.from("{}").toString("base64") }],
          },
        },
        {
          rows: {
            agentId: turn.botId,
            sessionId: turn.sessionId,
            generation: 2,
            entries: [
              {
                seq: "9007199254740993",
                updatedSeq: "9007199254740994",
                body: Buffer.from(JSON.stringify(entry)).toString("base64"),
              },
            ],
            deletes: [{ seq: "8", updatedSeq: "9007199254740995", entryId: "deleted" }],
            replay: true,
          },
        },
        {
          agentState: {
            live: [
              {
                agentId: turn.botId,
                sessionId: turn.sessionId,
                surfaceTaskId: turn.taskId,
                isRetrying: true,
              },
            ],
          },
        },
        {
          turnFailed: {
            agentId: turn.botId,
            sessionId: turn.sessionId,
            turnId: "actual-turn",
            code: "FAILED",
          },
        },
        { cleared: { agentId: turn.botId, sessionId: turn.sessionId, newGeneration: 3 } },
        { cursorTooOld: { agentId: turn.botId, sessionId: turn.sessionId, generation: 3 } },
      ];
      const frames = yield* service
        .watch({
          binding: turn.binding,
          botId: turn.botId,
          sessionId: turn.sessionId,
          generation: 2,
          afterUpdatedSeq: "9007199254740990",
        })
        .pipe(Stream.runCollect);
      const rows = frames.find((frame) => frame._tag === "Rows");
      assert.strictEqual(rows?.entries[0]?.updatedSeq, "9007199254740994");
      assert.deepStrictEqual(rows?.entries[0]?.value, entry);
      assert.strictEqual(rows?.deletes[0]?.updatedSeq, "9007199254740995");
      assert.deepStrictEqual(
        frames.map((frame) => frame._tag),
        ["Other", "Rows", "Live", "TurnFailed", "Cleared", "CursorTooOld"],
      );
      assert.strictEqual(state.finalized, true);
      assert.deepStrictEqual(calls[0]?.input, {
        cursors: [
          {
            agentId: turn.botId,
            sessionId: turn.sessionId,
            generation: 2,
            afterUpdatedSeq: "9007199254740990",
          },
        ],
        includeUnlistedAgents: false,
        inlineBodyMaxBytes: 1048576,
      });
    }),
);
it.effect("receives a reply and transcript resets when protobuf JSON omits generation zero", () =>
  Effect.gen(function* () {
    const { service, state } = yield* fixture;
    const reply = {
      id: "native-reply",
      kind: "send-message",
      message: { type: "text", content: "**Native check**" },
    };
    state.frames = [
      {
        rows: {
          agentId: turn.botId,
          entries: [
            {
              seq: "1",
              updatedSeq: "1",
              entryId: reply.id,
              body: Buffer.from(JSON.stringify(reply)).toString("base64"),
            },
          ],
          replay: true,
        },
      },
      { cleared: { agentId: turn.botId } },
      { cursorTooOld: { agentId: turn.botId } },
    ];
    const frames = yield* service
      .watch({ ...turn, sessionId: "", generation: 0, afterUpdatedSeq: "0" })
      .pipe(Stream.runCollect);
    assert.deepStrictEqual(
      frames.map((frame) =>
        frame._tag === "Rows" || frame._tag === "Cleared" || frame._tag === "CursorTooOld"
          ? frame.generation
          : null,
      ),
      [0, 0, 0],
    );
    assert.deepStrictEqual(frames[0]?._tag === "Rows" ? frames[0].entries[0]?.value : null, reply);
  }),
);
it.effect(
  "finalizes watch consumption early and never interrupts a bot merely because watch is cancelled",
  () =>
    Effect.gen(function* () {
      const { service, state, calls } = yield* fixture;
      state.frames = [{ heartbeat: {} }, { heartbeat: {} }];
      yield* service
        .watch({ ...turn, generation: 0, afterUpdatedSeq: "0" })
        .pipe(Stream.take(1), Stream.runDrain);
      assert.strictEqual(state.finalized, true);
      assert.strictEqual(calls.length, 1);
    }),
);
it.effect(
  "upserts and restores only its managed plugin while retaining later unrelated edits",
  () =>
    Effect.gen(function* () {
      const { service, state } = yield* fixture;
      const lease = yield* service.upsertPlugin({
        ...turn,
        name: "t3-managed",
        config: turn.mcpConfig,
      });
      assert.strictEqual(lease.created, true);
      assert.strictEqual(JSON.stringify(lease).includes("run-secret"), false);
      assert.strictEqual(state.plugins[0]?.mcpConfigJson, "unrelated-config");
      state.plugins.push({ pluginId: "3", name: "added-later", mcpConfigJson: "later-config" });
      yield* service.restorePlugin(lease);
      assert.deepStrictEqual(
        state.plugins.map((plugin) => plugin.pluginId),
        ["1", "3"],
      );
      state.plugins.push({ pluginId: "4", name: "t3-managed", mcpConfigJson: "original" });
      const update = yield* service.upsertPlugin({
        ...turn,
        name: "t3-managed",
        config: turn.mcpConfig,
      });
      yield* service.restorePlugin(update);
      assert.strictEqual(
        state.plugins.find((plugin) => plugin.pluginId === "4")?.mcpConfigJson,
        "original",
      );
    }),
);
it.effect("refuses restoring a managed plugin changed by another actor", () =>
  Effect.gen(function* () {
    const { service, state, calls } = yield* fixture;
    const lease = yield* service.upsertPlugin({
      ...turn,
      name: "t3-managed",
      config: turn.mcpConfig,
    });
    const owned = state.plugins.find((plugin) => plugin.pluginId === lease.pluginId);
    if (owned) owned.mcpConfigJson = "external-change";
    const writes = calls.filter((call) => call.method === "SetGrokBotAgentPlugins").length;
    assert.strictEqual(
      kind(yield* service.restorePlugin(lease).pipe(Effect.flip)),
      "plugin_conflict",
    );
    assert.strictEqual(
      calls.filter((call) => call.method === "SetGrokBotAgentPlugins").length,
      writes,
    );
  }),
);

it.effect(
  "reads bound roster/session facts without private account data and accepts the official empty main session",
  () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture;
      const roster = yield* service.roster(turn.binding);
      assert.strictEqual(JSON.stringify(roster).includes("private"), false);
      const context = yield* service.sessionContext(turn);
      assert.strictEqual(context.bot.viewerSessionId, "owned-session");
      assert.strictEqual(context.sessions[0]?.sessionId, "owned-session");
      yield* service.startTurn({ ...turn, sessionId: "" });
      const sent = calls.at(-1);
      assert.ok(sent);
      assert.strictEqual("sessionId" in sent.input && sent.input.sessionId, "");
      const tasks = yield* service.tasks({ ...turn, sessionId: "" });
      assert.strictEqual(tasks[0]?.state, "DONE");
    }),
);

it.effect("opens temporal settlement watches without requiring a running legacy gateway", () =>
  Effect.gen(function* () {
    const { service, state, calls } = yield* fixture;
    state.failGateway = true;
    const watch = yield* service.openSettlementWatch(turn);
    assert.ok(watch.events);
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["ListGrokBotAgents"],
    );
    assert.strictEqual(state.watching, false);
  }),
);

it.effect(
  "preserves native account and roster failures before selecting the settlement transport",
  () =>
    Effect.gen(function* () {
      const { service, state, calls } = yield* fixture;
      for (const error of [
        new Native.NativeSignedOutError({}),
        new Native.NativeReadError({ stage: "request", status: 403 }),
      ]) {
        state.rosterError = error;
        assert.strictEqual(yield* service.openSettlementWatch(turn).pipe(Effect.flip), error);
      }
      state.rosterError = undefined;
      state.missingBot = true;
      assert.strictEqual(
        kind(yield* service.openSettlementWatch(turn).pipe(Effect.flip)),
        "refused",
      );
      assert.strictEqual(
        calls.some((call) => call.method.startsWith("gateway")),
        false,
      );
    }),
);

it.effect("retains required gateway failures for legacy and unknown harnesses", () =>
  Effect.gen(function* () {
    const { service, state } = yield* fixture;
    state.failGateway = true;
    for (const harness of ["legacy", undefined]) {
      state.harness = harness;
      const error = yield* service.openSettlementWatch(turn).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GrokBotNativeReadError");
    }
  }),
);

it.effect(
  "establishes and buffers authoritative settlement events before snapshot, then releases the SSE owner scope",
  () =>
    Effect.gen(function* () {
      const { service, state } = yield* fixture;
      state.harness = "legacy";
      state.gatewayRows = [
        {
          id: turn.botId,
          lastTurnSettlement: {
            clientNonce: "snapshot-nonce",
            outcome: "error",
            settledAtMs: 10,
            errorCode: "provider_error",
            errorRetryable: null,
          },
        },
      ];
      state.gatewayEvents = [
        {
          channel: "agent-upserted",
          payload: {
            agent: {
              id: turn.botId,
              lastTurnSettlement: {
                clientNonce: "event-nonce",
                outcome: "success",
                settledAtMs: 20,
              },
            },
          },
        },
      ];
      const events = yield* Effect.scoped(
        Effect.gen(function* () {
          const watch = yield* service.openSettlementWatch({ ...turn, sessionId: "" });
          assert.strictEqual(state.watching, true);
          return yield* watch.events.pipe(Stream.take(2), Stream.runCollect);
        }),
      );
      assert.deepStrictEqual(
        events.map((event) => event.clientNonce),
        ["snapshot-nonce", "event-nonce"],
      );
      assert.deepStrictEqual(
        events.map((event) => event.outcome),
        ["error", "success"],
      );
      assert.strictEqual(state.finalized, true);
    }),
);

const owner = { binding: turn.binding, botId: turn.botId, sessionId: turn.sessionId };
it.effect("answers and dismisses native widgets only on accepted, unrefused responses", () =>
  Effect.gen(function* () {
    const { service, state, calls } = yield* fixture;
    yield* service.respondToWidget({ ...owner, entryId: "w1", value: "Alpha" });
    assert.deepStrictEqual(calls.at(-1), {
      method: "RespondGrokBotWidget",
      input: { agentId: "bot-1", sessionId: "owned-session", entryId: "w1", value: "Alpha" },
    });
    yield* service.dismissWidget({ ...owner, entryId: "w1" });
    assert.deepStrictEqual(calls.at(-1), {
      method: "DismissGrokBotWidget",
      input: { agentId: "bot-1", sessionId: "owned-session", entryId: "w1" },
    });
    state.widgetResult = { accepted: false };
    assert.strictEqual(
      kind(yield* service.dismissWidget({ ...owner, entryId: "w1" }).pipe(Effect.flip)),
      "uncertain",
    );
    state.widgetResult = { accepted: false, refusal: { message: "dismissed" } };
    assert.strictEqual(
      kind(
        yield* service.respondToWidget({ ...owner, entryId: "w1", value: "A" }).pipe(Effect.flip),
      ),
      "refused",
    );
    state.widgetResult = { dispatched: true };
    assert.strictEqual(
      kind(yield* service.dismissWidget({ ...owner, entryId: "w1" }).pipe(Effect.flip)),
      "uncertain",
    );
  }),
);

it.effect("dispatches native approvals with exact wire names and verifies dispatch", () =>
  Effect.gen(function* () {
    const { service, state, calls } = yield* fixture;
    assert.deepStrictEqual(
      yield* service.resolveAutoReviewApproval({
        ...owner,
        requestId: "r1",
        resolution: "ALWAYS",
        approvalPlatform: "slack",
        approvedCommand: "ls",
      }),
      { workflowId: "wf-approval" },
    );
    assert.deepStrictEqual(calls.at(-1), {
      method: "ResolveGrokBotAutoReviewApproval",
      input: {
        agentId: "bot-1",
        requestId: "r1",
        resolution: "ALWAYS",
        approvalPlatform: "slack",
        approvedCommand: "ls",
        sessionId: "owned-session",
      },
    });
    yield* service.resolveLocalToolPermission({
      ...owner,
      requestId: "r2",
      entryId: "e2",
      resolution: "ALLOW_ONCE",
    });
    assert.deepStrictEqual(calls.at(-1), {
      method: "ResolveGrokBotLocalToolPermission",
      input: {
        agentId: "bot-1",
        entryId: "e2",
        requestId: "r2",
        resolution: "ALLOW_ONCE",
        sessionId: "owned-session",
      },
    });
    yield* service.resolveConnectorGrant({ ...owner, requestId: "r3", resolution: "SKIPPED" });
    assert.deepStrictEqual(calls.at(-1)?.input, {
      agentId: "bot-1",
      requestId: "r3",
      resolution: "SKIPPED",
      sessionId: "owned-session",
    });
    state.approvalResult = {
      dispatched: false,
      refusal: { failureCode: "ALREADY_ANSWERED", message: "answered" },
    };
    assert.strictEqual(
      kind(
        yield* service
          .resolveConnectorGrant({ ...owner, requestId: "r3", resolution: "ALLOWED" })
          .pipe(Effect.flip),
      ),
      "refused",
    );
    state.approvalResult = { dispatched: false };
    assert.strictEqual(
      kind(
        yield* service
          .resolveLocalToolPermission({
            ...owner,
            requestId: "r2",
            entryId: "e2",
            resolution: "DENY",
          })
          .pipe(Effect.flip),
      ),
      "uncertain",
    );
    state.approvalResult = "garbage";
    assert.strictEqual(
      kind(
        yield* service
          .resolveAutoReviewApproval({
            ...owner,
            requestId: "r1",
            resolution: "DENIED",
            approvalPlatform: "slack",
          })
          .pipe(Effect.flip),
      ),
      "response",
    );
    const before = calls.length;
    assert.strictEqual(
      kind(
        yield* service
          .resolveConnectorGrant({ ...owner, requestId: "", resolution: "ALLOWED" })
          .pipe(Effect.flip),
      ),
      "invalid_input",
    );
    assert.strictEqual(calls.length, before);
  }),
);

it.effect("submits a secret to native only on acceptance and never leaks it in failures", () =>
  Effect.gen(function* () {
    const { service, state, calls } = yield* fixture;
    yield* service.submitSecret({ ...owner, entryId: "s1", value: Redacted.make("hunter2") });
    assert.deepStrictEqual(calls.at(-1), {
      method: "SubmitGrokBotSecret",
      input: { agentId: "bot-1", sessionId: "owned-session", entryId: "s1", value: "hunter2" },
    });
    state.widgetResult = { accepted: false, refusal: { message: "hunter2" } };
    const refused = yield* service
      .submitSecret({ ...owner, entryId: "s1", value: Redacted.make("hunter2") })
      .pipe(Effect.flip);
    assert.strictEqual(kind(refused), "refused");
    assert.notInclude(JSON.stringify(refused), "hunter2");
    state.widgetResult = {};
    assert.strictEqual(
      kind(
        yield* service
          .submitSecret({ ...owner, entryId: "s1", value: Redacted.make("") })
          .pipe(Effect.flip),
      ),
      "invalid_input",
    );
  }),
);

it.effect(
  "lists owned secret requests using the native secure-input marker without widget values",
  () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture;
      const requests = yield* service.secretRequests(owner);
      assert.deepStrictEqual(calls.at(-1), {
        method: "ListGrokBotTranscriptEntries",
        input: { agentId: "bot-1", sessionId: "owned-session", limit: 200 },
      });
      assert.deepStrictEqual(
        requests.map((request) => [request.entryId, request.state]),
        [
          ["s1", "responded"],
          ["s2", "pending"],
        ],
      );
      assert.notInclude(JSON.stringify(requests), "widget-value");
      assert.deepStrictEqual(Object.keys(requests[0]!).sort(), [
        "description",
        "entryId",
        "state",
        "title",
      ]);
    }),
);

it.effect("resets the computer with an argument-less ForceRecreateSandBox", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* fixture;
    assert.deepStrictEqual(yield* service.resetComputer({ binding: turn.binding }), {
      started: false,
      reason: "busy",
    });
    assert.deepStrictEqual(calls.at(-1), { method: "ForceRecreateSandBox", input: {} });
  }),
);

it.effect("recreates the computer without force and reads the upgrade schedule", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* fixture;
    assert.deepStrictEqual(
      yield* service.recreateComputer({ binding: turn.binding, preserveData: true }),
      { started: true, operationId: "op-1" },
    );
    assert.deepStrictEqual(calls.at(-1), {
      method: "RecreateSandBox",
      input: { preserveData: true, force: false, acknowledgeTerminalUpgradeSchedule: false },
    });
    const schedule = yield* service.computerUpgradeSchedule(turn.binding);
    assert.strictEqual(schedule?.nextFireAtMs, "99");
  }),
);
