import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthPreviewOperateScope,
  GrokBotError,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("allows native agent inspection separately from setup and opening a chat", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.museAgentsFeatureRead)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.museAgentsFeatureUpdate)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.museAgentsStatus)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.museAgentsProfile)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.museAgentsSetup)).toBe(AuthSettingsWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.museAgentsOpenThread)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.nativeAgentsOpenThread)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("separates bot reads, messaging, and environment settings", () => {
    for (const method of [
      WS_METHODS.grokBotsStatus,
      WS_METHODS.grokBotsList,
      WS_METHODS.grokBotsRead,
      WS_METHODS.grokBotsListRoutines,
      WS_METHODS.grokBotsListComposerResources,
      WS_METHODS.grokBotsListMarketplace,
      WS_METHODS.grokBotsListMarketplacePlugins,
      WS_METHODS.grokBotsListInstalledMarketplacePlugins,
      WS_METHODS.grokBotsGetMarketplaceTemplate,
      WS_METHODS.grokBotsOrchestratorConfig,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      WS_METHODS.grokBotsTeachRead,
      WS_METHODS.grokBotsTeachStart,
      WS_METHODS.grokBotsTeachStop,
      WS_METHODS.grokBotsComputerRead,
      WS_METHODS.grokBotsComputerStart,
      WS_METHODS.grokBotsSend,
      WS_METHODS.grokBotsLink,
      WS_METHODS.grokBotsOpenThread,
      WS_METHODS.grokBotsSetRoutineEnabled,
      WS_METHODS.grokBotsDeleteRoutine,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
    for (const method of [
      WS_METHODS.grokBotsSetup,
      WS_METHODS.grokBotsUpdate,
      WS_METHODS.grokBotsDelete,
      WS_METHODS.grokBotsImportMarketplaceTemplate,
      WS_METHODS.grokBotsInstallMarketplacePlugin,
      WS_METHODS.grokBotsUninstallMarketplacePlugin,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
    }
  });
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [
      WS_METHODS.terminalObserve,
      WS_METHODS.subscribeTerminalEvents,
      WS_METHODS.subscribeTerminalMetadata,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalRestart,
      WS_METHODS.terminalClose,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

describe("native bot provider authorization", () => {
  const group = WsRpcGroup.omit(
    ...Array.from(WsRpcGroup.requests.keys()).filter(
      (
        tag,
      ): tag is Exclude<
        keyof typeof RPC_REQUIRED_SCOPES,
        typeof WS_METHODS.grokBotsOrchestratorConfig
      > => tag !== WS_METHODS.grokBotsOrchestratorConfig,
    ),
  );

  it.effect("permits status reads but refuses setup before invoking its handler", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.grokBotsOrchestratorConfig, (input) =>
              Effect.sync(() => handled.push(input.action ?? "status")).pipe(
                Effect.andThen(Effect.fail(new GrokBotError({ reason: "bot_not_found" }))),
              ),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      for (const input of [{}, { action: "status" as const }]) {
        expect(
          (yield* client[WS_METHODS.grokBotsOrchestratorConfig](input).pipe(Effect.flip))._tag,
        ).toBe("GrokBotError");
      }
      expect(
        yield* client[WS_METHODS.grokBotsOrchestratorConfig]({ action: "setup" }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthSettingsWriteScope,
      });
      expect(handled).toEqual(["status", "status"]);
    }).pipe(Effect.scoped),
  );
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("persistent bot thread authorization", () => {
  const group = WsRpcGroup.omit(
    ...Array.from(WsRpcGroup.requests.keys()).filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.grokBotsOpenThread> =>
        tag !== WS_METHODS.grokBotsOpenThread,
    ),
  );
  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], allowed: false },
    { scopes: [AuthSettingsWriteScope], allowed: false },
    { scopes: [AuthOrchestrationOperateScope], allowed: true },
  ])("opens only with operate permission: $allowed", ({ scopes, allowed }) =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.grokBotsOpenThread, () =>
              Effect.sync(() => {
                handled++;
                return {
                  threadId: ThreadId.make("bot-thread"),
                  providerInstanceId: ProviderInstanceId.make("grok-bot"),
                };
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      const result = yield* client[WS_METHODS.grokBotsOpenThread]({ botId: "bot" }).pipe(
        Effect.exit,
      );
      if (allowed) {
        expect(result._tag).toBe("Success");
        expect(handled).toBe(1);
      } else {
        expect(result._tag).toBe("Failure");
        expect(handled).toBe(0);
      }
    }).pipe(Effect.scoped),
  );
});

it.effect("requires all preview permissions at the server sign-in boundary", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.museAgentsSignIn> =>
          tag !== WS_METHODS.museAgentsSignIn,
      ),
    );
    const required = [AuthSettingsWriteScope, AuthOrchestrationReadScope, AuthPreviewOperateScope];
    let handled = 0;
    for (const omitted of [...required, null]) {
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.museAgentsSignIn, () =>
              Effect.sync(() => {
                handled++;
                return { threadId: "private-thread", tabId: "private-tab" };
              }),
            ),
            RpcAuthorization.layer(required.filter((scope) => scope !== omitted)),
          ),
        ),
      );
      if (omitted === null)
        expect(yield* client[WS_METHODS.museAgentsSignIn]({})).toEqual({
          threadId: "private-thread",
          tabId: "private-tab",
        });
      else
        expect(yield* client[WS_METHODS.museAgentsSignIn]({}).pipe(Effect.flip)).toMatchObject({
          requiredPermission: omitted,
        });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("requires settings permission before issuing Muse connector authorization links", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.museAgentsFeatureRead
        > => tag !== WS_METHODS.museAgentsFeatureRead,
      ),
    );
    let handled = 0;
    const makeClient = (scopes: ReadonlyArray<import("@t3tools/contracts").AuthEnvironmentScope>) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.museAgentsFeatureRead, (input) =>
              Effect.sync(() => {
                handled++;
                return input.operation === "connector_info"
                  ? {
                      operation: "connector_info" as const,
                      data: {
                        connectorId: "test",
                        action: {
                          type: "oauth" as const,
                          authorizationUrl: "https://example.test/authorize",
                        },
                      },
                    }
                  : { operation: "connectors" as const, data: [] };
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
    const readClient = yield* makeClient([AuthOrchestrationReadScope]);
    const operateClient = yield* makeClient([AuthOrchestrationOperateScope]);
    const settingsClient = yield* makeClient([AuthSettingsWriteScope]);
    const providerInstanceId = ProviderInstanceId.make("muse-test");
    const input = { operation: "connector_info", providerInstanceId, connectorId: "test" } as const;
    for (const client of [readClient, operateClient]) {
      expect(
        yield* client[WS_METHODS.museAgentsFeatureRead](input).pipe(Effect.flip),
      ).toMatchObject({
        requiredPermission: AuthSettingsWriteScope,
      });
    }
    expect(handled).toBe(0);
    expect(
      yield* readClient[WS_METHODS.museAgentsFeatureRead]({
        operation: "connectors",
        providerInstanceId,
      }),
    ).toEqual({
      operation: "connectors",
      data: [],
    });
    expect(yield* settingsClient[WS_METHODS.museAgentsFeatureRead](input)).toMatchObject({
      operation: "connector_info",
      data: { action: { type: "oauth" } },
    });
    expect(handled).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect(
  "rejects Muse account updates from conversation-only clients before the handler runs",
  () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.museAgentsFeatureUpdate
          > => tag !== WS_METHODS.museAgentsFeatureUpdate,
        ),
      );
      let handled = 0;
      const makeClient = (
        scopes: ReadonlyArray<import("@t3tools/contracts").AuthEnvironmentScope>,
      ) =>
        RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.museAgentsFeatureUpdate, () =>
                Effect.sync(() => {
                  handled++;
                  return { updated: true as const };
                }),
              ),
              RpcAuthorization.layer(scopes),
            ),
          ),
        );
      const conversationClient = yield* makeClient([AuthOrchestrationOperateScope]);
      const settingsClient = yield* makeClient([AuthSettingsWriteScope]);
      const providerInstanceId = ProviderInstanceId.make("muse-test");
      const configuration = [
        {
          operation: "connector_auth",
          providerInstanceId,
          connectorId: "test",
          authType: "consent_only",
        },
        { operation: "connector_link", providerInstanceId, connectorId: "test" },
        {
          operation: "connector_scope_link",
          providerInstanceId,
          connectorId: "test",
          method: "read",
        },
        { operation: "connector_disconnect", providerInstanceId, connectorId: "test" },
        {
          operation: "connector_unlink",
          providerInstanceId,
          connectorId: "test",
          accountId: "test",
        },
        {
          operation: "profile_save",
          providerInstanceId,
          document: "identity",
          content: "Draft",
          expectedRevision: "a".repeat(64),
        },
        { operation: "profile_set_theme", providerInstanceId, themeId: "test" },
      ] as const;
      for (const input of configuration) {
        expect(
          yield* conversationClient[WS_METHODS.museAgentsFeatureUpdate](input).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      }
      expect(handled).toBe(0);
      for (const input of configuration) {
        expect(yield* settingsClient[WS_METHODS.museAgentsFeatureUpdate](input)).toEqual({
          updated: true,
        });
      }
      expect(handled).toBe(configuration.length);
      const archive = {
        operation: "session_archive",
        providerInstanceId,
        sessionId: "side",
        archived: true,
      } as const;
      expect(
        yield* settingsClient[WS_METHODS.museAgentsFeatureUpdate](archive).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
      expect(yield* conversationClient[WS_METHODS.museAgentsFeatureUpdate](archive)).toEqual({
        updated: true,
      });
      expect(handled).toBe(configuration.length + 1);
    }).pipe(Effect.scoped),
);

it.effect(
  "allows private sign-in cleanup without environment grants but refuses a new sign-in",
  () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.museAgentsCloseSignIn | typeof WS_METHODS.museAgentsSignIn
          > => tag !== WS_METHODS.museAgentsCloseSignIn && tag !== WS_METHODS.museAgentsSignIn,
        ),
      );
      const closed: string[] = [];
      let opened = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.museAgentsCloseSignIn, ({ threadId }) =>
              Effect.sync(() => {
                closed.push(threadId);
              }),
            ),
            group.toLayerHandler(WS_METHODS.museAgentsSignIn, () =>
              Effect.sync(() => {
                opened = true;
                return { threadId: "new-page", tabId: "new-tab" };
              }),
            ),
            RpcAuthorization.layer([]),
          ),
        ),
      );
      yield* client[WS_METHODS.museAgentsCloseSignIn]({ threadId: "owned-page" });
      expect(closed).toEqual(["owned-page"]);
      expect(yield* client[WS_METHODS.museAgentsSignIn]({}).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthSettingsWriteScope,
      });
      expect(opened).toBe(false);
    }).pipe(Effect.scoped),
);
