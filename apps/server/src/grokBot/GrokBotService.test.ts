import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GrokBotConversation,
  ProjectId,
  PullRequestOperationError,
  SourceControlProviderKind,
  type PullRequestSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GrokBotService from "./GrokBotService.ts";
import * as GrokBotNativeService from "./GrokBotNativeService.ts";

const decodeConversation = Schema.decodeEffect(GrokBotConversation);

const bot = {
  id: "bot-1",
  nativeProfileId: "profile-record-1",
  name: "Test bot",
  title: "Builder",
  avatarShape: "blob",
  avatarColor: "green",
};
const reference = {
  projectId: ProjectId.make("project-1"),
  repository: "example/repo",
  number: 12,
};
const summary = (state: PullRequestSummary["state"]): PullRequestSummary => ({
  ...reference,
  provider: SourceControlProviderKind.make("github"),
  title: "Example change",
  url: "https://github.com/example/repo/pull/12",
  state,
  headBranch: "feature",
  baseBranch: "main",
  updatedAt: "2026-10-09T00:00:00Z",
});
const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const fixtureFor = (platform: NodeJS.Platform) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grokbot-test-" });
    const descriptor = `${root}/.config/Grok Bot/gateway-descriptor.json`;
    yield* fs.makeDirectory(`${root}/.config/Grok Bot`, { recursive: true });
    yield* fs.writeFileString(descriptor, "encrypted-session-fixture");
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const remote = {
      bots: [bot] as Array<{
        id: string;
        nativeProfileId?: string;
        name: string;
        title?: string;
        description?: string;
        avatarShape?: string;
        avatarColor?: string;
        hasAvatarPhoto?: boolean;
        notifyOnAgentUpdates?: boolean;
        hiddenFromSidebar?: boolean;
      }>,
      transcript: { entries: [] as unknown[] },
      receipt: { delivery: "accepted", exitCode: 0 } as Record<string, unknown>,
      created: { id: "bot-created", name: "New bot" } as Record<string, unknown>,
      /** Stderr for a failing `bots create`, as gbot prints it. */
      createFailure: undefined as string | undefined,
      sendCode: 0,
      sendFailure: undefined as ProcessRunner.ProcessTimeoutError | undefined,
      listGate: undefined as Deferred.Deferred<void> | undefined,
      listStarted: undefined as Deferred.Deferred<void> | undefined,
      prState: "open" as PullRequestSummary["state"],
      heldPrState: null as PullRequestSummary["state"] | null,
      failPr: false,
      prCalls: 0,
      nativeAvailable: false,
      npm: "ok" as "ok" | "missing" | "timeout" | number,
      nativePinned: [] as string[],
      nativeBinding: "selected-account-fixture",
      nativeBindingBeforeList: undefined as string | undefined,
      nativeBindingAfterUpdate: undefined as string | undefined,
      nativeSignedOut: false,
      nativeUpdateFailure: undefined as
        | GrokBotNativeService.NativeReadError
        | GrokBotNativeService.NativeSignedOutError
        | undefined,
      nativeClientFailure: undefined as GrokBotNativeService.NativeReadError | undefined,
      nativeReadbackFailure: false,
      /** The native side removes the bot before answering. */
      nativeDeleteCommits: true,
      /** The delete request fails after it was sent, so the caller cannot tell from the response. */
      nativeDeleteLost: false,
      nativeApplyUpdates: true,
      nativeClearAvatar: true,
      nativeListCalls: 0,
      nativeCalls: [] as { method: GrokBotNativeService.NativeRuntimeMethod; input: object }[],
    };
    const run = (input: ProcessRunner.ProcessRunInput) =>
      Effect.gen(function* () {
        calls.push(input);
        if (input.command === "npm") {
          if (remote.npm === "missing")
            return yield* new ProcessRunner.ProcessSpawnError({
              command: "npm",
              argumentCount: input.args.length,
              cause: new Error("ENOENT"),
            });
          if (remote.npm === "timeout")
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: "npm",
              argumentCount: input.args.length,
              timeoutMs: 120000,
            });
          return output("", remote.npm === "ok" ? 0 : remote.npm);
        }
        if (input.args.includes("list")) {
          if (remote.listStarted) yield* Deferred.succeed(remote.listStarted, undefined);
          if (remote.listGate) yield* Deferred.await(remote.listGate);
          return output(JSON.stringify(remote.bots));
        }
        if (input.args.includes("create")) {
          if (remote.createFailure !== undefined)
            return { ...output("", 2), stderr: remote.createFailure };
          return output(JSON.stringify(remote.created));
        }
        if (input.args.includes("thread"))
          return output(JSON.stringify({ transcript: remote.transcript }));
        if (input.args.includes("send")) {
          if (remote.sendFailure) return yield* remote.sendFailure;
          return output(JSON.stringify(remote.receipt), remote.sendCode);
        }
        return output("0.12.4");
      });
    const nativeList = Effect.suspend(
      (): GrokBotNativeService.GrokBotNativeService["Service"]["list"] => {
        remote.nativeListCalls++;
        return remote.nativeSignedOut
          ? Effect.fail(new GrokBotNativeService.NativeSignedOutError({}))
          : remote.nativeAvailable &&
              !(remote.nativeReadbackFailure && remote.nativeCalls.length > 0)
            ? Effect.succeed(remote.bots)
            : Effect.fail(new GrokBotNativeService.NativeReadError({ stage: "session" }));
      },
    );
    const serviceLayer = GrokBotService.layer.pipe(
      Layer.provide(
        Layer.mock(GrokBotNativeService.GrokBotNativeService)({
          accountBinding: Effect.suspend(
            (): GrokBotNativeService.GrokBotNativeService["Service"]["accountBinding"] =>
              remote.nativeSignedOut
                ? Effect.fail(new GrokBotNativeService.NativeSignedOutError({}))
                : remote.nativeAvailable
                  ? Effect.succeed(remote.nativeBinding)
                  : Effect.fail(new GrokBotNativeService.NativeReadError({ stage: "session" })),
          ),
          runtimeRequest: (_binding, method, input) =>
            Effect.suspend(() => {
              if (method === "GetGrokBotUserRuntimeSettings")
                return Effect.succeed({
                  settings: { pinnedAgents: { agentIds: remote.nativePinned } },
                });
              if (method === "UpdateGrokBotUserRuntimeSettings") {
                remote.nativeCalls.push({ method, input });
                remote.nativePinned = (
                  input as { pinnedAgents: { agentIds: string[] } }
                ).pinnedAgents.agentIds;
                return Effect.succeed({
                  settings: { pinnedAgents: { agentIds: remote.nativePinned } },
                });
              }
              remote.nativeCalls.push({ method, input });
              if (method === "DeleteGrokBotAgent") {
                const { id } = input as { id: string };
                if (remote.nativeDeleteCommits)
                  remote.bots = remote.bots.filter((current) => current.nativeProfileId !== id);
                return remote.nativeDeleteLost
                  ? Effect.fail(new GrokBotNativeService.NativeReadError({ stage: "request" }))
                  : Effect.succeed({});
              }
              if (remote.nativeUpdateFailure) return Effect.fail(remote.nativeUpdateFailure);
              if (method === "SetGrokBotAgentClientState" && remote.nativeClientFailure)
                return Effect.fail(remote.nativeClientFailure);
              if (remote.nativeBindingAfterUpdate !== undefined)
                remote.nativeBinding = remote.nativeBindingAfterUpdate;
              if (remote.nativeApplyUpdates) {
                const profile = input as {
                  id?: string;
                  agentId?: string;
                  name?: string;
                  title?: string;
                  description?: string;
                  avatarShape?: string;
                  avatarColor?: string;
                  clearAvatar?: object;
                  notifyOnUpdatesEnabled?: boolean;
                  hiddenFromSidebar?: boolean;
                };
                const { id, agentId, clearAvatar, ...changes } = profile;
                remote.bots = remote.bots.map((current) =>
                  method === "UpdateGrokBotAgent" && current.nativeProfileId === id
                    ? {
                        ...current,
                        ...changes,
                        ...(clearAvatar && remote.nativeClearAvatar
                          ? { hasAvatarPhoto: false }
                          : {}),
                      }
                    : method === "SetGrokBotAgentClientState" && current.id === agentId
                      ? {
                          ...current,
                          ...(profile.notifyOnUpdatesEnabled === undefined
                            ? {}
                            : { notifyOnAgentUpdates: profile.notifyOnUpdatesEnabled }),
                          ...(profile.hiddenFromSidebar === undefined
                            ? {}
                            : { hiddenFromSidebar: profile.hiddenFromSidebar }),
                        }
                      : current,
                );
              }
              return Effect.succeed({});
            }),
          list: nativeList,
          listForBinding: (binding) =>
            Effect.suspend(() => {
              if (remote.nativeBindingBeforeList !== undefined)
                remote.nativeBinding = remote.nativeBindingBeforeList;
              return binding !== remote.nativeBinding
                ? Effect.fail(new GrokBotNativeService.NativeReadError({ stage: "session" }))
                : nativeList;
            }),
          read: () =>
            Effect.suspend(
              (): ReturnType<GrokBotNativeService.GrokBotNativeService["Service"]["read"]> =>
                remote.nativeSignedOut
                  ? Effect.fail(new GrokBotNativeService.NativeSignedOutError({}))
                  : remote.nativeAvailable
                    ? Effect.succeed({
                        entries: remote.transcript.entries,
                        runtimeActivity: {
                          source: "native" as const,
                          observedAtMs: 0,
                          isRunning: true,
                          isComposingMessage: false,
                          awaitingUserResponse: null,
                        },
                      })
                    : Effect.fail(
                        new GrokBotNativeService.NativeReadError({
                          stage: "session",
                        }),
                      ),
            ),
        }),
      ),
      Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({ run })),
      Layer.provide(
        Layer.mock(PullRequestService.PullRequestService)({
          summary: (input) =>
            Effect.suspend(() => {
              remote.prCalls++;
              return remote.failPr
                ? Effect.fail(
                    new PullRequestOperationError({
                      operation: "summary",
                      detail: "Host unavailable",
                    }),
                  )
                : Effect.succeed(
                    summary(
                      input.allowStale !== false && remote.heldPrState !== null
                        ? remote.heldPrState
                        : remote.prState,
                    ),
                  );
            }),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(root, root)),
      Layer.provide(Layer.succeed(HostProcess.HomeDirectory, root)),
      Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
      Layer.provide(Layer.succeed(HostProcess.Environment, {})),
    );
    const service = Context.get(yield* Layer.build(serviceLayer), GrokBotService.GrokBotService);
    return { root, fs, descriptor, calls, remote, service, serviceLayer };
  });
const fixture = fixtureFor("linux");

it.layer(NodeServices.layer)("Grok Bot bridge", (it) => {
  it.effect("does not fall back to a saved gateway after the desktop account signs out", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeSignedOut = true;
      assert.strictEqual((yield* service.list.pipe(Effect.flip)).reason, "signed_out");
      assert.deepStrictEqual(calls, []);
    }),
  );
  it.effect("uses direct native reads without a CLI or renderer preflight", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      remote.transcript.entries = [
        {
          id: "native-message",
          kind: "send-message",
          message: { type: "text", content: "native reply" },
        },
      ];
      const conversation = yield* service.read(bot.id);
      yield* decodeConversation(conversation);
      assert.strictEqual(conversation.messages[0]?.text, "native reply");
      assert.strictEqual(conversation.runtimeActivity?.isRunning, true);
      assert.deepStrictEqual(calls, []);
    }),
  );
  it.effect(
    "observes pending approvals and streaming fallback text without treating historical tools as running",
    () =>
      Effect.gen(function* () {
        const { service, remote } = yield* fixture;
        remote.transcript.entries = [
          { id: "old-tool", kind: "tool-call", name: "Shell", status: "running" },
          {
            id: "approval",
            kind: "send-message",
            message: {
              type: "local-tool-permission",
              ask: { status: "pending", requestId: "request-1", command: "private command" },
            },
          },
          {
            id: "streaming",
            kind: "send-message",
            message: { type: "text", content: "reply" },
            isStreaming: true,
          },
        ];
        const conversation = yield* service.read(bot.id);
        yield* decodeConversation(conversation);
        assert.strictEqual(conversation.runtimeActivity?.source, "transcript");
        assert.strictEqual(
          conversation.runtimeActivity?.awaitingUserResponse?.reason,
          "approval_pending",
        );
        assert.strictEqual(conversation.runtimeActivity?.isComposingMessage, true);
        assert.strictEqual(conversation.runtimeActivity?.isRunning, undefined);
        assert.strictEqual(conversation.runtimeActivity?.currentActivity, undefined);
        assert.strictEqual(JSON.stringify(conversation).includes("private command"), false);
        yield* TestClock.adjust("300 millis");
        remote.transcript.entries = [
          {
            id: "resolved",
            kind: "send-message",
            message: {
              type: "auto-review-approval",
              approval: { status: "accepted", requestId: "request-1" },
            },
          },
          {
            id: "malformed",
            kind: "send-message",
            message: { type: "local-tool-permission", ask: { status: "pending" } },
          },
        ];
        const settled = yield* service.read(bot.id);
        assert.strictEqual(settled.runtimeActivity?.awaitingUserResponse, null);
        assert.strictEqual(settled.runtimeActivity?.isComposingMessage, false);
      }),
  );
  it.effect(
    "awaits only the latest widget while it is waiting, not after it is answered or dismissed",
    () =>
      Effect.gen(function* () {
        const { service, remote } = yield* fixture;
        const widget = (id: string, extra: object = {}) => ({
          id,
          kind: "send-message",
          message: {
            type: "widget",
            widget: { prompt: "Pick one", options: [{ label: "A" }] },
          },
          ...extra,
        });
        remote.transcript.entries = [widget("q1", { respondedValue: "A" }), widget("q2")];
        const waiting = yield* service.read(bot.id);
        assert.strictEqual(
          waiting.runtimeActivity?.awaitingUserResponse?.reason,
          "approval_pending",
        );
        yield* TestClock.adjust("300 millis");
        remote.transcript.entries = [widget("q1"), widget("q2", { widgetDismissed: true })];
        const dismissed = yield* service.read(bot.id);
        assert.strictEqual(dismissed.runtimeActivity?.awaitingUserResponse, null);
        yield* TestClock.adjust("300 millis");
        remote.transcript.entries = [widget("q1"), widget("q3", { respondedValue: "A" })];
        const answered = yield* service.read(bot.id);
        assert.strictEqual(answered.runtimeActivity?.awaitingUserResponse, null);
      }),
  );
  it.effect("normalizes real roster and includes only chat messages from history", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.transcript.entries = [
        { id: "u1", kind: "message", role: "user", content: "hello", timestampMs: 5 },
        {
          id: "a1",
          kind: "send-message",
          message: { type: "text", content: "hi" },
          timestampMs: 6,
        },
        { id: "tool", kind: "event", content: "private tool details" },
        {
          id: "widget",
          kind: "send-message",
          message: {
            type: "widget",
            widget: { prompt: "Pick one", options: [{ label: "A" }] },
          },
        },
      ];
      const conversation = yield* service.read(bot.id);
      assert.strictEqual(conversation.bot.label, "Builder");
      assert.strictEqual(conversation.bot.pinned, false);
      assert.deepStrictEqual(
        conversation.messages.map((entry) => [entry.role, entry.text]),
        [
          ["user", "hello"],
          ["assistant", "hi"],
        ],
      );
      assert.deepStrictEqual(calls.find((call) => call.args.includes("thread"))?.args.slice(-2), [
        "--",
        bot.id,
      ]);
    }),
  );
  it.effect("syncs pins with the native account and pulls later native unpins", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      remote.nativeAvailable = true;
      remote.nativePinned = ["other-bot"];
      const pinned = yield* service.update({ botId: bot.id, pinned: true });
      assert.strictEqual(pinned.pinned, true);
      assert.deepStrictEqual(remote.nativePinned, ["other-bot", bot.id]);
      assert.deepStrictEqual(remote.nativeCalls.at(-1), {
        method: "UpdateGrokBotUserRuntimeSettings",
        input: { pinnedAgents: { agentIds: ["other-bot", bot.id] } },
      });
      remote.nativePinned = ["other-bot"];
      yield* TestClock.adjust("6 seconds");
      assert.strictEqual((yield* service.list)[0]?.pinned, false);
      yield* service.update({ botId: bot.id, pinned: false });
      assert.deepStrictEqual(remote.nativePinned, ["other-bot"]);
    }),
  );
  it.effect("does not save a local pin when the native account is unavailable", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      const failure = yield* service.update({ botId: bot.id, pinned: true }).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "native_unavailable");
      assert.strictEqual(remote.nativeCalls.length, 0);
      assert.strictEqual((yield* service.list)[0]?.pinned, false);
    }),
  );
  it.effect("preserves local preferences across concurrent writes and a restart", () =>
    Effect.gen(function* () {
      const { service, serviceLayer, remote } = yield* fixture;
      remote.nativeAvailable = true;
      yield* Effect.all(
        [
          service.update({ botId: bot.id, pinned: false }),
          service.update({ botId: bot.id, featured: true }),
        ],
        { concurrency: "unbounded" },
      );
      const restarted = Context.get(
        yield* Layer.build(serviceLayer),
        GrokBotService.GrokBotService,
      );
      const [saved] = yield* restarted.list;
      assert.strictEqual(saved?.pinned, false);
      assert.strictEqual(saved?.featured, true);
      assert.strictEqual(saved?.name, bot.name);
    }),
  );
  it.effect("passes a new look through to the Grok Bot profile", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      const saved = yield* service.update({
        botId: bot.id,
        avatarShape: "cloud",
        avatarColor: "blue",
      });
      assert.strictEqual(saved.avatarShape, "cloud");
      assert.strictEqual(saved.avatarColor, "blue");
      assert.strictEqual(saved.id, bot.id);
      assert.strictEqual(saved.label, "Builder");
      assert.strictEqual(remote.nativeListCalls, 2);
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect("reports an unavailable native connection before attempting any profile write", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      for (const input of [
        { botId: bot.id, avatarShape: "heart" },
        { botId: bot.id, avatarShape: "cloud" },
        { botId: bot.id, notificationEnabled: false },
        { botId: bot.id, hidden: true },
      ]) {
        const failure = yield* Effect.flip(service.update(input));
        assert.strictEqual(failure.reason, "native_unavailable");
      }
      assert.strictEqual(remote.nativeCalls.length, 0);
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect("stores desktop picker shapes and client settings directly without CLI mutation", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      yield* service.update({
        botId: bot.id,
        avatarShape: "heart",
        avatarColor: "magenta",
        notificationEnabled: false,
        hidden: false,
      });
      assert.deepStrictEqual(remote.nativeCalls, [
        {
          method: "UpdateGrokBotAgent",
          input: {
            id: bot.nativeProfileId,
            partialUpdate: true,
            avatarShape: "heart",
            avatarColor: "magenta",
            clearAvatar: {},
          },
        },
        {
          method: "SetGrokBotAgentClientState",
          input: {
            agentId: bot.id,
            notifyOnUpdatesEnabled: false,
            hiddenFromSidebar: false,
          },
        },
      ]);
      assert.strictEqual(
        calls.some((call) => call.args.includes("update")),
        false,
      );
    }),
  );
  it.effect("saves all 13 native picker shape names and replaces an avatar photo", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      // Grok Bot 0.68.1's character picker writes these string names without an enum index.
      for (const shape of [
        "blob",
        "cloud",
        "square",
        "sparkle",
        "clover",
        "heart",
        "flower",
        "teardrop",
        "tablet",
        "wedge",
        "house",
        "star",
        "hex",
      ]) {
        remote.bots = [{ ...bot, hasAvatarPhoto: true }];
        const saved = yield* service.update({ botId: bot.id, avatarShape: shape });
        assert.strictEqual(saved.avatarShape, shape);
        assert.strictEqual(remote.bots[0]?.hasAvatarPhoto, false);
        assert.deepStrictEqual(remote.nativeCalls.at(-1), {
          method: "UpdateGrokBotAgent",
          input: {
            id: bot.nativeProfileId,
            partialUpdate: true,
            avatarShape: shape,
            clearAvatar: {},
          },
        });
      }
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect(
    "color-only appearance saves replace photos but other profile edits preserve them",
    () =>
      Effect.gen(function* () {
        const { service, remote } = yield* fixture;
        remote.nativeAvailable = true;
        remote.bots = [{ ...bot, hasAvatarPhoto: true }];
        yield* service.update({
          botId: bot.id,
          name: "New name",
          label: "New label",
          description: "New instructions",
        });
        assert.strictEqual(remote.bots[0]?.hasAvatarPhoto, true);
        assert.deepStrictEqual(remote.nativeCalls[0]?.input, {
          id: bot.nativeProfileId,
          partialUpdate: true,
          name: "New name",
          title: "New label",
          description: "New instructions",
        });
        yield* service.update({ botId: bot.id, avatarColor: "green" });
        assert.strictEqual(remote.bots[0]?.hasAvatarPhoto, false);
        assert.deepStrictEqual(remote.nativeCalls[1]?.input, {
          id: bot.nativeProfileId,
          partialUpdate: true,
          avatarColor: "green",
          clearAvatar: {},
        });
      }),
  );
  it.effect("reports an uncertain character save when the native avatar photo remains", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      remote.nativeClearAvatar = false;
      remote.bots = [{ ...bot, hasAvatarPhoto: true }];
      const failure = yield* Effect.flip(service.update({ botId: bot.id, avatarShape: "heart" }));
      assert.strictEqual(failure.reason, "profile_save_uncertain");
      assert.strictEqual(remote.bots[0]?.avatarShape, "heart");
      assert.strictEqual(remote.bots[0]?.hasAvatarPhoto, true);
      assert.strictEqual(remote.nativeCalls.length, 1);
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect("does not retry a failed native profile mutation through the CLI", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      remote.nativeUpdateFailure = new GrokBotNativeService.NativeReadError({ stage: "request" });
      const failure = yield* Effect.flip(service.update({ botId: bot.id, avatarShape: "cloud" }));
      assert.strictEqual(failure.reason, "profile_save_uncertain");
      assert.strictEqual(remote.nativeCalls.length, 1);
      assert.strictEqual(
        calls.some((call) => call.args.includes("update")),
        false,
      );
    }),
  );
  it.effect("classifies definite native profile rejections without retrying", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      for (const [status, reason] of [
        [401, "signed_out"],
        [403, "permission_denied"],
        [404, "bot_not_found"],
        [500, "profile_save_uncertain"],
      ] as const) {
        remote.nativeUpdateFailure = new GrokBotNativeService.NativeReadError({
          stage: "request",
          status,
        });
        const before = remote.nativeCalls.length;
        const failure = yield* Effect.flip(service.update({ botId: bot.id, name: "New name" }));
        assert.strictEqual(failure.reason, reason);
        assert.strictEqual(remote.nativeCalls.length, before + 1);
        assert.strictEqual("cause" in failure, false);
        assert.strictEqual("status" in failure, false);
      }
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect(
    "preserves native sign-out and prevents mutation with an incomplete roster record",
    () =>
      Effect.gen(function* () {
        const { service, remote, calls } = yield* fixture;
        remote.nativeSignedOut = true;
        assert.strictEqual(
          (yield* Effect.flip(service.update({ botId: bot.id, name: "New name" }))).reason,
          "signed_out",
        );
        remote.nativeSignedOut = false;
        remote.nativeAvailable = true;
        remote.bots = [{ id: bot.id, name: bot.name }];
        assert.strictEqual(
          (yield* Effect.flip(service.update({ botId: bot.id, name: "New name" }))).reason,
          "native_unavailable",
        );
        remote.bots = [];
        assert.strictEqual(
          (yield* Effect.flip(service.update({ botId: bot.id, hidden: true }))).reason,
          "bot_not_found",
        );
        assert.strictEqual(remote.nativeCalls.length, 0);
        assert.strictEqual(calls.length, 0);
      }),
  );
  it.effect("reports a partially committed save when client settings are rejected", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      remote.nativeClientFailure = new GrokBotNativeService.NativeReadError({
        stage: "request",
        status: 403,
      });
      const failure = yield* Effect.flip(
        service.update({ botId: bot.id, avatarShape: "heart", notificationEnabled: false }),
      );
      assert.strictEqual(failure.reason, "profile_save_uncertain");
      assert.strictEqual(remote.bots[0]?.avatarShape, "heart");
      assert.strictEqual(remote.nativeCalls.length, 2);
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect("reports a failed or stale native readback without retrying or using the CLI", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      remote.nativeReadbackFailure = true;
      assert.strictEqual(
        (yield* Effect.flip(service.update({ botId: bot.id, avatarShape: "heart" }))).reason,
        "profile_save_uncertain",
      );
      assert.strictEqual(remote.bots[0]?.avatarShape, "heart");
      remote.nativeReadbackFailure = false;
      remote.nativeApplyUpdates = false;
      assert.strictEqual(
        (yield* Effect.flip(service.update({ botId: bot.id, avatarShape: "cloud" }))).reason,
        "profile_save_uncertain",
      );
      assert.strictEqual(remote.nativeCalls.length, 2);
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect("requires the same selected account for native save confirmation", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      remote.nativeBindingAfterUpdate = "different-account-fixture";
      const failure = yield* Effect.flip(service.update({ botId: bot.id, avatarShape: "heart" }));
      assert.strictEqual(failure.reason, "profile_save_uncertain");
      assert.strictEqual(remote.bots[0]?.avatarShape, "heart");
      assert.strictEqual(remote.nativeCalls.length, 1);
      assert.strictEqual(remote.nativeListCalls, 1);
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect("rejects an account switch before the save preflight without writing", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      remote.nativeBindingBeforeList = "different-account-fixture";
      const failure = yield* Effect.flip(service.update({ botId: bot.id, avatarShape: "heart" }));
      assert.strictEqual(failure.reason, "native_unavailable");
      assert.strictEqual(remote.nativeCalls.length, 0);
      assert.strictEqual(remote.nativeListCalls, 0);
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect("rejects unsupported shapes and colors before reading or writing profiles", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      for (const input of [
        { botId: bot.id, avatarShape: "unsupported" },
        { botId: bot.id, avatarColor: "unsupported" },
      ]) {
        const failure = yield* Effect.flip(service.update(input));
        assert.strictEqual(failure.reason, "invalid_avatar");
      }
      assert.strictEqual(remote.nativeListCalls, 0);
      assert.strictEqual(remote.nativeCalls.length, 0);
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect("creates one bot through the gateway CLI and rejects shapes it does not accept", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.created = {
        id: "bot-created",
        name: "New bot",
        description: "Be brief",
        avatarShape: "leaf",
        avatarColor: "gray",
        notifyOnAgentUpdates: true,
        hiddenFromSidebar: false,
      };
      const created = yield* service.create({
        name: "New bot",
        description: "Be brief",
        avatarShape: "leaf",
        avatarColor: "gray",
      });
      assert.strictEqual(created.id, "bot-created");
      assert.strictEqual(created.name, "New bot");
      assert.strictEqual(created.avatarShape, "leaf");
      assert.deepStrictEqual(calls.at(-1)?.args.slice(-8), [
        "bots",
        "create",
        "--gateway",
        "--json",
        "--name=New bot",
        "--description=Be brief",
        "--avatar-shape=leaf",
        "--avatar-color=gray",
      ]);
      const callsBefore = calls.length;
      const failure = yield* Effect.flip(
        service.create({ name: "New bot", avatarShape: "square" }),
      );
      assert.strictEqual(failure.reason, "invalid_avatar");
      assert.strictEqual(calls.length, callsBefore);
    }),
  );
  it.effect("surfaces the reason gbot gives when creating a bot fails", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      remote.createFailure = JSON.stringify({
        error: { code: "CLI_INPUT_INVALID", issues: [{ message: "Name is already in use" }] },
      });
      const failure = yield* Effect.flip(
        service.create({ name: "Diamond Bot", avatarShape: "gem", avatarColor: "blue" }),
      );
      assert.strictEqual(failure.reason, "gateway_failed");
      assert.strictEqual(failure.message, "Name is already in use");
    }),
  );
  it.effect("removes only a merged PR association while retaining the pinned bot", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      remote.nativeAvailable = true;
      yield* service.update({ botId: bot.id, pinned: true });
      const linked = yield* service.link({ botId: bot.id, reference });
      assert.strictEqual(linked.pullRequests.length, 1);
      remote.heldPrState = "open";
      remote.failPr = true;
      yield* TestClock.adjust("6 seconds");
      assert.strictEqual((yield* service.list)[0]?.pullRequests.length, 1);
      remote.failPr = false;
      remote.prState = "closed";
      yield* TestClock.adjust("6 seconds");
      assert.strictEqual((yield* service.list)[0]?.pullRequests[0]?.state, "closed");
      remote.prState = "merged";
      yield* TestClock.adjust("6 seconds");
      const [remaining] = yield* service.list;
      assert.strictEqual(remaining?.id, bot.id);
      assert.strictEqual(remaining?.pinned, true);
      assert.deepStrictEqual(remaining?.pullRequests, []);
    }),
  );
  it.effect("deletes a bot natively and drops its T3 PR links without touching the PR", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      yield* service.link({ botId: bot.id, reference });
      const deleted = yield* service.delete({ botId: bot.id });
      assert.deepStrictEqual(deleted, { botId: bot.id });
      assert.deepStrictEqual(remote.nativeCalls.at(-1), {
        method: "DeleteGrokBotAgent",
        input: { id: bot.nativeProfileId },
      });
      assert.strictEqual(
        calls.some((call) => call.args.includes("delete")),
        false,
      );
      assert.deepStrictEqual(remote.bots, []);
      // The bot returns to the account with no inherited PR association.
      remote.bots = [bot];
      const [restored] = yield* service.list;
      assert.deepStrictEqual(restored?.pullRequests, []);
    }),
  );
  it.effect("does not retry a lost delete through the CLI and reports it uncertain", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      remote.nativeDeleteLost = true;
      remote.nativeDeleteCommits = false;
      const failure = yield* Effect.flip(service.delete({ botId: bot.id }));
      assert.strictEqual(failure.reason, "delete_uncertain");
      assert.strictEqual(remote.nativeCalls.length, 1);
      assert.strictEqual(
        calls.some((call) => call.args.includes("delete")),
        false,
      );
      assert.strictEqual((yield* service.list)[0]?.id, bot.id);
    }),
  );
  it.effect("confirms a lost delete when the roster no longer lists the bot", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      remote.nativeDeleteLost = true;
      yield* service.delete({ botId: bot.id });
      assert.strictEqual(remote.nativeCalls.length, 1);
      assert.strictEqual(
        calls.some((call) => call.args.includes("delete")),
        false,
      );
      assert.deepStrictEqual(remote.bots, []);
    }),
  );
  it.effect("reports an absent bot without sending a delete", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.nativeAvailable = true;
      const failure = yield* Effect.flip(service.delete({ botId: "missing-bot" }));
      assert.strictEqual(failure.reason, "bot_not_found");
      assert.strictEqual(remote.nativeCalls.length, 0);
      assert.strictEqual(calls.length, 0);
    }),
  );
  it.effect("blocks deleting a bot while its run is in flight", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      remote.nativeAvailable = true;
      remote.bots = [
        {
          ...bot,
          runtimeActivity: {
            source: "native",
            observedAtMs: 0,
            isRunning: true,
            awaitingUserResponse: null,
          },
        } as (typeof remote.bots)[number],
      ];
      const failure = yield* Effect.flip(service.delete({ botId: bot.id }));
      assert.strictEqual(failure.reason, "delete_running");
      assert.strictEqual(remote.nativeCalls.length, 0);
    }),
  );
  it.effect("coalesces concurrent status, roster and conversation reads", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.listGate = yield* Deferred.make<void>();
      remote.listStarted = yield* Deferred.make<void>();
      const reads = yield* Effect.all(
        [
          service.status,
          service.status,
          service.list,
          service.list,
          service.read(bot.id),
          service.read(bot.id),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(remote.listStarted);
      yield* Deferred.succeed(remote.listGate, undefined);
      yield* Fiber.join(reads);
      assert.strictEqual(calls.filter((call) => call.args.includes("list")).length, 1);
      assert.strictEqual(calls.filter((call) => call.args.includes("thread")).length, 1);
      assert.strictEqual(calls.filter((call) => call.args.includes("--version")).length, 1);
      yield* service.read(bot.id);
      assert.strictEqual(calls.filter((call) => call.args.includes("thread")).length, 1);
      yield* TestClock.adjust("300 millis");
      yield* service.read(bot.id);
      assert.strictEqual(calls.filter((call) => call.args.includes("thread")).length, 2);
      assert.strictEqual(calls.filter((call) => call.args.includes("list")).length, 1);
    }),
  );
  it.effect("refreshes cached roster and transcript after sends and updates", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      yield* service.read(bot.id);
      remote.bots = [{ ...bot, name: "New name" }];
      remote.transcript.entries = [{ id: "new", kind: "message", role: "user", content: "hello" }];
      yield* service.send({ botId: bot.id, message: "hello" });
      const afterSend = yield* service.read(bot.id);
      assert.strictEqual(afterSend.bot.name, "New name");
      assert.strictEqual(afterSend.messages[0]?.text, "hello");
      remote.nativeAvailable = true;
      yield* service.update({ botId: bot.id, pinned: true });
      assert.strictEqual((yield* service.read(bot.id)).bot.pinned, true);
    }),
  );
  it.effect("sanitizes managed user echo instructions on direct native history reads", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      const content = "actual user text\n\n[From T3 Code: Use skill t3-code-managed-turn-v1.]";
      remote.transcript.entries = [
        {
          id: "managed",
          kind: "message",
          role: "user",
          content,
          clientNonce: "t3-" + "a".repeat(64),
        },
        { id: "ordinary", kind: "message", role: "user", content, clientNonce: "native-nonce" },
        {
          id: "peer",
          kind: "message",
          role: "user",
          content,
          clientNonce: "t3-" + "a".repeat(64),
          fromAgent: { id: "other-bot", name: "Other bot" },
        },
      ];
      const conversation = yield* service.read(bot.id);
      yield* decodeConversation(conversation);
      assert.deepStrictEqual(
        conversation.messages.map((message) => message.text),
        ["actual user text", content, content],
      );
    }),
  );
  it.effect("maps embedded bot and user reactions and preserves standalone reaction turns", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      remote.transcript.entries = [
        {
          id: "u1",
          kind: "message",
          role: "user",
          content: "hello",
          timestampMs: 1,
          reactions: [{ emoji: "👍", by: "bot-1" }, { emoji: "👍", by: "bot-1" }, null],
        },
        { id: "r1", kind: "react", messageId: "a1", emoji: "😂", from: "user", timestampMs: 3 },
        {
          id: "a1",
          kind: "send-message",
          message: { type: "text", content: "hi" },
          timestampMs: 2,
          reactions: [{ emoji: "❤️", by: "me" }],
        },
        { id: "r2", kind: "reaction", emoji: "👋", timestampMs: 4 },
        {
          id: "r3",
          kind: "send-message",
          message: { type: "emoji", content: "🎉", messageId: "outside-tail" },
          timestampMs: 5,
        },
        { id: "r4", kind: "emoji", emoji: 5 },
        {
          id: "tool",
          kind: "event",
          content: "private tools",
          reactions: [{ emoji: "✅", by: "bot-1" }],
        },
      ];
      const conversation = yield* service.read(bot.id);
      yield* decodeConversation(conversation);
      assert.deepStrictEqual(
        conversation.messages.find((message) => message.id === "u1")?.reactions,
        [{ emoji: "👍", from: "bot", messageId: "u1" }],
      );
      assert.deepStrictEqual(
        conversation.messages.find((message) => message.id === "a1")?.reactions,
        [
          { emoji: "😂", from: "user", messageId: "a1" },
          { emoji: "❤️", from: "user", messageId: "a1" },
        ],
      );
      const turns = conversation.messages.filter((message) => message.reactionOnly);
      assert.deepStrictEqual(
        turns.map((message) => message.text),
        ["👋", "🎉", "✅"],
      );
      assert.strictEqual(turns[1]?.reactions?.[0]?.messageId, "outside-tail");
      assert.strictEqual(
        conversation.messages.some((message) => message.id === "r1" || message.id === "r4"),
        false,
      );
      assert.strictEqual(JSON.stringify(conversation).includes("private tools"), false);
    }),
  );
  it.effect("accepts explicit delivered receipts without a roster or PR preflight", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      for (const receipt of [
        { delivery: "accepted", exitCode: 0 },
        { delivery: "queued", exitCode: 0 },
        { delivery: "sent", exitCode: 0 },
        { delivery: "unknown", exitCode: 0, result: { status: "queued" } },
        { delivery: "unknown", exitCode: 0, result: { delivery: "sent" } },
        { delivery: "unknown", exitCode: 0, result: { accepted: true } },
        { delivery: "unknown", exitCode: 0, result: { messageId: "confirmed" } },
      ]) {
        remote.receipt = receipt;
        assert.deepStrictEqual(yield* service.send({ botId: bot.id, message: "hello" }), {
          accepted: true,
        });
      }
      assert.strictEqual(calls.length, 7);
      assert.strictEqual(
        calls.every((call) => call.args.includes("send")),
        true,
      );
      assert.strictEqual(remote.prCalls, 0);
    }),
  );
  it.effect("never retries contradictory, malformed, failed or unconfirmed send receipts", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      for (const receipt of [
        { delivery: "unknown", exitCode: 0, result: { ok: true } },
        { delivery: "unknown", exitCode: 0, messageId: "" },
        { delivery: "sent", exitCode: 1 },
        { delivery: "rejected", exitCode: 0, result: { messageId: "x" } },
        { delivery: "accepted", exitCode: 0, result: { accepted: false } },
        { delivery: "accepted", exitCode: 0, result: { error: "failed" } },
        { unexpected: true },
      ]) {
        remote.receipt = receipt;
        const error = yield* service.send({ botId: bot.id, message: "hello" }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "delivery_unknown");
      }
      assert.strictEqual(calls.length, 7);
      remote.sendCode = 1;
      assert.strictEqual(
        (yield* service.send({ botId: bot.id, message: "hello" }).pipe(Effect.flip)).reason,
        "delivery_unknown",
      );
      remote.sendCode = 0;
      remote.sendFailure = new ProcessRunner.ProcessTimeoutError({
        command: "gbot",
        argumentCount: 1,
        timeoutMs: 45000,
      });
      assert.strictEqual(
        (yield* service.send({ botId: bot.id, message: "hello" }).pipe(Effect.flip)).reason,
        "delivery_unknown",
      );
      assert.strictEqual(calls.length, 9);
    }),
  );
  it.effect("does not repeat a send when its receipt reports uncertain delivery", () =>
    Effect.gen(function* () {
      const { service, remote, calls } = yield* fixture;
      remote.receipt.delivery = "unknown";
      yield* service.read(bot.id);
      remote.transcript.entries = [
        { id: "delivered", kind: "message", role: "user", content: "one message" },
      ];
      const error = yield* service
        .send({ botId: bot.id, message: "one message" })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "delivery_unknown");
      assert.strictEqual(calls.filter((call) => call.args.includes("send")).length, 1);
      assert.strictEqual(calls.at(-1)?.env?.CODEX_THREAD_ID, "");
      assert.strictEqual((yield* service.read(bot.id)).messages[0]?.id, "delivered");
    }),
  );
  it.effect("rejects unsigned sessions before invoking the CLI", () =>
    Effect.gen(function* () {
      const { service, fs, descriptor, calls } = yield* fixture;
      yield* fs.remove(descriptor);
      const error = yield* service.list.pipe(Effect.flip);
      assert.strictEqual(error.reason, "signed_out");
      assert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("reports an actionable, platform-specific failure when npm is missing", () =>
    Effect.gen(function* () {
      for (const [platform, hint] of [
        ["win32", "winget install OpenJS.NodeJS.LTS"],
        ["darwin", "brew install node"],
        ["linux", "package manager"],
      ] as const) {
        const { service, remote } = yield* fixtureFor(platform);
        remote.npm = "missing";
        const error = yield* service.setup.pipe(Effect.flip);
        assert.strictEqual(error.reason, "setup_failed");
        assert.include(error.message, hint);
      }
    }),
  );

  it.effect("keeps install failures and a missing CLI file distinct", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      remote.npm = "timeout";
      assert.include((yield* service.setup.pipe(Effect.flip)).message, "timed out");
      remote.npm = 1;
      assert.include((yield* service.setup.pipe(Effect.flip)).message, "exit 1");
      // npm reported success, but nothing landed where the bridge is read from.
      remote.npm = "ok";
      assert.include((yield* service.setup.pipe(Effect.flip)).message, "could not be started");
    }),
  );

  it.effect("reports native readiness separately from the CLI bridge", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      remote.nativeAvailable = true;
      assert.strictEqual((yield* service.status).nativeAvailable, true);
    }),
  );
});
