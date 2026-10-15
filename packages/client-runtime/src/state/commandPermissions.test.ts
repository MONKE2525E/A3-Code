import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AVAILABLE_CONNECTION_STATE, type PreparedConnection } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  ProviderInstanceId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const environmentLayer = Layer.succeed(EnvironmentRegistry, {
  run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
} as unknown as EnvironmentRegistry["Service"]);
const runtime = Atom.runtime(environmentLayer);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("requires operate on the selected destination to import Muse history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const readOnly = {
          ...grant(false),
          scopes: [AuthOrchestrationReadScope],
          permissions: [AuthOrchestrationReadScope],
        };
        registry.set(sessions(env), AsyncResult.success(readOnly));
        registry.set(sessions(other), AsyncResult.success(readOnly));
        const command = createCommandPermissions(runtime, WS_METHODS.museAgentsFeatureUpdate);
        const input = {
          operation: "history_page" as const,
          providerInstanceId: ProviderInstanceId.make("muse-test"),
          threadId: ThreadId.make("muse-agent:test"),
          beforeSeq: 10,
        };
        expect(registry.get(command.permissionAtom(env, input))).toBe(false);
        expect((yield* command.authorize(registry, env, input).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(command.permissionAtom(env, input))).toBe(true);
        yield* command.authorize(registry, env, input);
        expect((yield* command.authorize(registry, other, input).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }),
    ),
  );
  it.effect("reads native provider status without authorizing setup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        const command = createCommandPermissions(runtime, WS_METHODS.grokBotsOrchestratorConfig);
        yield* command.authorize(registry, env, {});
        yield* command.authorize(registry, env, { action: "status" });
        expect(
          (yield* command.authorize(registry, env, { action: "setup" }).pipe(Effect.flip))._tag,
        ).toBe("EnvironmentAuthorizationError");
        expect(registry.get(command.permissionAtom(env))).toBe(false);
      }),
    ),
  );
  it.effect("uses the destination grant for bot messaging and settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        for (const method of [
          WS_METHODS.grokBotsSend,
          WS_METHODS.grokBotsLink,
          WS_METHODS.grokBotsTeachRead,
          WS_METHODS.grokBotsTeachStart,
          WS_METHODS.grokBotsTeachStop,
          WS_METHODS.grokBotsComputerRead,
          WS_METHODS.grokBotsComputerStart,
        ]) {
          const command = createCommandPermissions(runtime, method);
          expect(registry.get(command.permissionAtom(env))).toBe(true);
          yield* command.authorize(registry, env);
          expect((yield* command.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
        }
        for (const method of [
          WS_METHODS.museAgentsSignIn,
          WS_METHODS.grokBotsSetup,
          WS_METHODS.grokBotsCreate,
          WS_METHODS.grokBotsUpdate,
          WS_METHODS.grokBotsDelete,
          WS_METHODS.grokBotsImportMarketplaceTemplate,
          WS_METHODS.grokBotsPluginAuthenticate,
          WS_METHODS.grokBotsPluginCompleteAuth,
          WS_METHODS.grokBotsHostMachineUpdate,
          WS_METHODS.grokBotsNetworkSet,
          WS_METHODS.grokBotsInstallMarketplacePlugin,
          WS_METHODS.grokBotsUninstallMarketplacePlugin,
          WS_METHODS.grokBotsOrchestratorConfig,
        ]) {
          const command = createCommandPermissions(runtime, method);
          expect(registry.get(command.permissionAtom(env))).toBe(false);
          expect((yield* command.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
        }
      }),
    ),
  );
  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

it.effect("requires settings, read and preview operation grants together for Muse sign-in", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const command = createCommandPermissions(runtime, WS_METHODS.museAgentsSignIn);
      const required = [
        AuthSettingsWriteScope,
        AuthOrchestrationReadScope,
        AuthPreviewOperateScope,
      ];
      for (const omitted of required) {
        const scopes = required.filter((scope) => scope !== omitted);
        registry.set(
          sessions(env),
          AsyncResult.success({ ...grant(false), scopes, permissions: scopes }),
        );
        expect(registry.get(command.permissionAtom(env))).toBe(false);
        expect((yield* command.authorize(registry, env, {}).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }
      registry.set(
        sessions(env),
        AsyncResult.success({ ...grant(false), scopes: required, permissions: required }),
      );
      expect(registry.get(command.permissionAtom(env))).toBe(true);
      yield* command.authorize(registry, env, {});
    }),
  ),
);

it.effect("separates Muse account settings from conversation operations per destination", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const command = createCommandPermissions(runtime, WS_METHODS.museAgentsFeatureUpdate);
      const operate = grant(true);
      const settings = {
        ...grant(false),
        scopes: [AuthSettingsWriteScope],
        permissions: [AuthSettingsWriteScope],
      };
      registry.set(sessions(env), AsyncResult.success(operate));
      registry.set(sessions(other), AsyncResult.success(settings));
      for (const operation of [
        "connector_auth",
        "connector_link",
        "connector_scope_link",
        "connector_disconnect",
        "connector_unlink",
        "profile_save",
        "profile_set_theme",
      ]) {
        const input = { operation };
        expect(registry.get(command.permissionAtom(env, input))).toBe(false);
        expect((yield* command.authorize(registry, env, input).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        expect(registry.get(command.permissionAtom(other, input))).toBe(true);
        yield* command.authorize(registry, other, input);
      }
      for (const operation of [
        "credential_submit",
        "history_page",
        "computer_action",
        "delivery_release",
        "task_delete",
        "session_rename",
        "session_archive",
      ]) {
        const input = { operation };
        expect(registry.get(command.permissionAtom(env, input))).toBe(true);
        yield* command.authorize(registry, env, input);
        expect(registry.get(command.permissionAtom(other, input))).toBe(false);
        expect((yield* command.authorize(registry, other, input).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }
    }),
  ),
);

it.effect(
  "checks and executes binary Muse commands with their transport inputs and operate grant",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const { createMuseAgentDictationCommand, MuseAgentDictationClient } = yield* Effect.promise(
          () => import("./museAgentDictationHttp.ts"),
        );
        const { createMuseAgentComputerStreamCommand, MuseAgentComputerStreamClient } =
          yield* Effect.promise(() => import("./museAgentComputerStream.ts"));
        const { PrimaryConnectionTarget } = yield* Effect.promise(
          () => import("../connection/model.ts"),
        );
        const target = new PrimaryConnectionTarget({
          environmentId: env,
          label: "Test",
          httpBaseUrl: "http://localhost:1234",
          wsBaseUrl: "ws://localhost:1234",
        });
        const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
          Option.some({
            environmentId: env,
            label: "Test",
            target,
            httpBaseUrl: target.httpBaseUrl,
            socketUrl: target.wsBaseUrl,
            httpAuthorization: null,
          }),
        );
        let uploads = 0;
        let streams = 0;
        const state = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
        const session = yield* SubscriptionRef.make(Option.none<RpcSession>());
        const httpRuntime = Atom.runtime(
          Layer.mergeAll(
            environmentLayer,
            Layer.succeed(EnvironmentSupervisor, {
              target,
              state,
              session,
              prepared,
              connect: Effect.void,
              disconnect: Effect.void,
              retryNow: Effect.void,
            }),
            Layer.succeed(MuseAgentDictationClient, {
              transcribe: () =>
                Effect.sync(() => {
                  uploads++;
                  return { text: "Transcript" };
                }),
            }),
            Layer.succeed(MuseAgentComputerStreamClient, {
              prepare: () =>
                Effect.sync(() => {
                  streams++;
                  return { socketUrl: "ws://localhost:1234/computer" };
                }),
            }),
          ),
        );
        const dictation = createMuseAgentDictationCommand(httpRuntime);
        const computer = createMuseAgentComputerStreamCommand(httpRuntime);
        const audio = {
          providerInstanceId: ProviderInstanceId.make("muse-test"),
          pcm: new Uint8Array([0, 0]),
        };
        const viewer = {
          providerInstanceId: audio.providerInstanceId,
          sessionId: "primary",
          taskId: "task",
          takeoverId: "lease",
        };
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(dictation.permissionAtom(env, audio))).toBe(true);
        expect(registry.get(computer.permissionAtom(env, viewer))).toBe(true);
        expect(
          yield* Effect.promise(() =>
            dictation.run(registry, { environmentId: env, input: audio }),
          ),
        ).toMatchObject({ _tag: "Success", value: { text: "Transcript" } });
        expect(
          yield* Effect.promise(() =>
            computer.run(registry, { environmentId: env, input: viewer }),
          ),
        ).toMatchObject({ _tag: "Success", value: { socketUrl: "ws://localhost:1234/computer" } });
        expect([uploads, streams]).toEqual([1, 1]);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(dictation.permissionAtom(env, audio))).toBe(false);
        expect(
          yield* Effect.promise(() =>
            dictation.run(registry, { environmentId: env, input: audio }),
          ),
        ).toMatchObject({ _tag: "Failure" });
        expect(
          yield* Effect.promise(() =>
            computer.run(registry, { environmentId: env, input: viewer }),
          ),
        ).toMatchObject({ _tag: "Failure" });
        expect([uploads, streams]).toEqual([1, 1]);
      }),
    ),
);

it.effect("allows owned Muse sign-in cleanup after all environment grants are revoked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const cleanup = createCommandPermissions(runtime, WS_METHODS.museAgentsCloseSignIn);
      const signIn = createCommandPermissions(runtime, WS_METHODS.museAgentsSignIn);
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [],
          permissions: [],
        }),
      );
      expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
      yield* cleanup.authorize(registry, env, { threadId: "owned-private-page" });
      expect(registry.get(signIn.permissionAtom(env))).toBe(false);
      expect((yield* signIn.authorize(registry, env, {}).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
    }),
  ),
);
