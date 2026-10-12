import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthSettingsWriteScope,
  AuthOrchestrationOperateScope,
  GrokBotError,
  GrokBotOrchestratorConfig,
  GrokBotOrchestratorError,
  WS_METHODS,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Binding from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import {
  makeBindings,
  makeNative,
  makeTurn,
} from "../orchestration-v2/Adapters/GrokBotProvider.testkit.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Hydration from "../provider/ProviderInstanceRegistryHydration.ts";
import { checkGrokBotProvider, GrokBotDriver } from "../provider/Drivers/GrokBotDriver.ts";
import * as Settings from "../serverSettings.ts";
import * as Native from "./GrokBotNativeRuntimeService.ts";
import * as GrokBotService from "./GrokBotService.ts";
import * as Service from "./GrokBotOrchestratorService.ts";
import * as GuidedSetup from "./GrokBotSetupService.ts";

const account = "a".repeat(64);
const decodeConfig = Schema.decodeEffect(GrokBotOrchestratorConfig);
const fixture = (bridgeInstalled = true, installFails = false) =>
  Effect.gen(function* () {
    const installs = yield* Ref.make(0);
    const selected = yield* Ref.make(account);
    const ready = yield* Ref.make(false);
    const turn = yield* makeTurn;
    const skillWrites: unknown[] = [];
    const native = makeNative({
      accountBinding: Ref.get(selected),
      ensureSkill: (input) =>
        Effect.sync(() => {
          skillWrites.push(input);
          return { skillId: "saved-native-skill", changed: true };
        }),
    });
    const binding = makeBindings(turn, {
      availability: Ref.get(ready).pipe(
        Effect.map((value) =>
          value
            ? { ready: true }
            : { ready: false, reason: "Link this environment to T3 Connect." },
        ),
      ),
    });
    // Use the real provider probe and registry. Execution is outside this setup test.
    const driver = {
      ...GrokBotDriver,
      create: (options: Parameters<typeof GrokBotDriver.create>[0]) =>
        Effect.sync(() => {
          const refresh = checkGrokBotProvider(options).pipe(
            Effect.provideService(Native.GrokBotNativeRuntimeService, native),
            Effect.provideService(Binding.GrokBotManagedBinding, binding),
          );
          return {
            instanceId: options.instanceId,
            driverKind: GrokBotDriver.driverKind,
            snapshot: { refresh, getSnapshot: refresh, streamChanges: Stream.empty },
          } as never;
        }),
    };
    const registry = Instances.layer({ drivers: [driver], configMap: {} });
    const serviceLayer = Service.layer.pipe(
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(registry),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(GuidedSetup.GrokBotSetupService)({
            status: Effect.fail(new GuidedSetup.GrokBotSetupError({ stage: "account" })),
          }),
          Settings.layerTest(),
          Layer.succeed(Native.GrokBotNativeRuntimeService, native),
          Layer.succeed(Binding.GrokBotManagedBinding, binding),
          Layer.mock(GrokBotService.GrokBotService)({
            status: Effect.succeed({
              installed: bridgeInstalled,
              managed: true,
              sessionPresent: true,
            }),
            setup: Ref.update(installs, (count) => count + 1).pipe(
              Effect.flatMap(() =>
                installFails
                  ? Effect.fail(new GrokBotError({ reason: "setup_failed" }))
                  : Effect.succeed({ installed: true, managed: true, sessionPresent: true }),
              ),
            ),
          }),
        ),
      ),
    );
    const context = yield* Layer.build(serviceLayer);
    const service = Context.get(context, Service.GrokBotOrchestratorService);
    const settings = Context.get(context, Settings.ServerSettingsService);
    const instances = Context.get(context, Instances.ProviderInstanceRegistry);
    return { context, service, settings, instances, selected, ready, skillWrites, installs };
  });

it.effect(
  "inspection is read-only and explicit setup creates one native instance with actual bot models",
  () =>
    Effect.gen(function* () {
      const { service, settings, instances, ready, skillWrites } = yield* fixture();
      const before = yield* service.inspect({});
      assert.equal(before.state, "not_configured");
      assert.isNull(before.provider);
      assert.equal(before.skillSetup?.workflowPath, Binding.GROK_BOT_MANAGED_WORKFLOW_PATH);
      assert.include(before.skillSetup?.prompt ?? "", Binding.GROK_BOT_MANAGED_SKILL_BODY);
      assert.include(
        before.skillSetup?.prompt ?? "",
        "supplies the t3-code-managed MCP connection automatically",
      );
      assert.notInclude(before.skillSetup?.prompt ?? "", "Bearer");
      assert.notInclude(before.skillSetup?.prompt ?? "", account);
      assert.deepStrictEqual((yield* settings.getSettings).providerInstances, {});
      assert.equal(skillWrites.length, 0);
      const configured = yield* service.inspect({ action: "setup" });
      assert.equal(skillWrites.length, 0);
      assert.equal(configured.state, "blocked");
      assert.equal(configured.directDelegationSupported, true);
      assert.equal(configured.authentication, "native_account");
      assert.equal(configured.publicEndpointReadiness.ready, false);
      assert.include(configured.publicEndpointReadiness.reason ?? "", "T3 Connect");
      assert.equal(configured.provider?.models[0]?.slug, "durable-bot-1");
      assert.equal(configured.provider?.models[0]?.name, "Bot One");
      assert.isDefined(configured.provider);
      const id = configured.provider!.instanceId;
      const instance = yield* instances.getInstance(id);
      const after = yield* settings.getSettings;
      assert.deepStrictEqual(after.providerInstances[id]?.config, { accountBinding: account });
      assert.equal(after.providerInstances[id]?.enabled, true);
      const repeated = yield* service.setup({});
      assert.equal(repeated.provider?.instanceId, id);
      assert.strictEqual(yield* instances.getInstance(id), instance);
      assert.equal(Object.keys((yield* settings.getSettings).providerInstances).length, 1);
      yield* Ref.set(ready, true);
      const refreshed = yield* service.inspect({ action: "status" });
      assert.equal(refreshed.state, "ready");
      assert.equal(refreshed.provider?.status, "ready");
      yield* decodeConfig(refreshed);
    }).pipe(Effect.scoped),
);

it.effect("refuses account changes without modifying the existing binding or instance", () =>
  Effect.gen(function* () {
    const { service, settings, instances, selected } = yield* fixture();
    const configured = yield* service.setup({});
    const before = yield* settings.getSettings;
    const id = configured.provider!.instanceId;
    const instance = yield* instances.getInstance(id);
    yield* Ref.set(selected, "b".repeat(64));
    assert.equal((yield* service.inspect({})).state, "account_changed");
    const error = yield* Effect.flip(service.setup({}));
    assert.instanceOf(error, GrokBotOrchestratorError);
    assert.equal(error.reason, "account_changed");
    assert.deepStrictEqual(
      (yield* settings.getSettings).providerInstances,
      before.providerInstances,
    );
    assert.strictEqual(yield* instances.getInstance(id), instance);
  }).pipe(Effect.scoped),
);

it.effect(
  "rejects a missing bot before changing settings and re-enables the same bound instance",
  () =>
    Effect.gen(function* () {
      const { service, settings, instances } = yield* fixture();
      const missing = yield* Effect.flip(service.setup({ botId: "missing" }));
      assert.equal(missing.reason, "bot_not_found");
      assert.deepStrictEqual((yield* settings.getSettings).providerInstances, {});
      const configured = yield* service.setup({ botId: "durable-bot-1" });
      const id = configured.provider!.instanceId;
      const old = (yield* settings.getSettings).providerInstances[id]!;
      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: id,
        instance: { ...old, enabled: false },
      });
      const enabled = yield* service.setup({});
      assert.equal(enabled.provider?.instanceId, id);
      assert.equal(enabled.provider?.enabled, true);
      assert.equal((yield* instances.listInstances).length, 1);
    }).pipe(Effect.scoped),
);

it.effect(
  "hydration always reads the newest settings rather than applying stale queued snapshots",
  () =>
    Effect.gen(function* () {
      const { context, service, settings, instances } = yield* fixture();
      const configured = yield* service.setup({});
      const id = configured.provider!.instanceId;
      yield* settings.updateProviderInstance({ operation: "remove", instanceId: id });
      yield* Hydration.reconcileSettings.pipe(Effect.provide(context));
      assert.isUndefined(yield* instances.getInstance(id));
    }).pipe(Effect.scoped),
);

it("keeps setup behind the existing environment settings scope", () => {
  assert.deepStrictEqual(
    clientRpcRequiredScopes(WS_METHODS.grokBotsOrchestratorConfig, { action: "setup" }),
    [AuthSettingsWriteScope],
  );
  assert.deepStrictEqual(clientRpcRequiredScopes(WS_METHODS.grokBotsOpenThread, { botId: "bot" }), [
    AuthOrchestrationOperateScope,
  ]);
});

it.effect("explicit setup installs a missing bridge while inspection stays read-only", () =>
  Effect.gen(function* () {
    const { service, installs } = yield* fixture(false);
    yield* service.inspect({});
    assert.equal(yield* Ref.get(installs), 0);
    const configured = yield* service.setup({});
    assert.equal(yield* Ref.get(installs), 1);
    assert.isNotNull(configured.provider);
  }).pipe(Effect.scoped),
);

it.effect("an optional bridge installation failure does not block native provider setup", () =>
  Effect.gen(function* () {
    const { service, ready, installs } = yield* fixture(false, true);
    yield* Ref.set(ready, true);
    const configured = yield* service.setup({});
    assert.equal(yield* Ref.get(installs), 1);
    assert.equal(configured.state, "ready");
    assert.equal(configured.bridge.installed, false);
  }).pipe(Effect.scoped),
);

it("requires both settings and orchestration permissions to send setup", () => {
  assert.deepEqual(
    clientRpcRequiredScopes(WS_METHODS.grokBotsOrchestratorConfig, { action: "send_setup_prompt" }),
    [AuthSettingsWriteScope, AuthOrchestrationOperateScope],
  );
});
