import {
  GrokBotError,
  GrokBotOrchestratorError,
  ProviderDriverKind,
  ProviderInstanceId,
  type GrokBotOrchestratorConfig,
  type GrokBotOrchestratorInput,
  type GrokBotOrchestratorStatusInput,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { GrokBotProviderSettings } from "@t3tools/contracts/grokBotProvider";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Binding from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Hydration from "../provider/ProviderInstanceRegistryHydration.ts";
import * as Mutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as Settings from "../serverSettings.ts";
import * as Native from "./GrokBotNativeRuntimeService.ts";
import * as GrokBotService from "./GrokBotService.ts";
import * as GuidedSetup from "./GrokBotSetupService.ts";

const instructions =
  "Open a bot from Grok Bots. Its persistent conversation stays in No project. Name the project where its agents should work; use t3_project_list to find it and pass projectId to delegate_task. Its native V2 run owns delegated tasks, permissions, delegated task cancellation, and completion delivery. Link this environment to T3 Connect when public endpoint readiness is blocked.";
const decodeSettings = Schema.decodeUnknownOption(GrokBotProviderSettings);
const bindingOf = (instance: ProviderInstanceConfig) =>
  Option.getOrUndefined(decodeSettings(instance.config ?? {}))?.accountBinding;
const configuredBots = (settings: ServerSettings) =>
  Object.entries(settings.providerInstances)
    .filter(([, instance]) => instance.driver === "grok-bot")
    .map(([id, instance]) => ({ id: ProviderInstanceId.make(id), instance }));
const settingsError = () => new GrokBotOrchestratorError({ reason: "settings_failed" });

export class GrokBotOrchestratorService extends Context.Service<
  GrokBotOrchestratorService,
  {
    readonly inspect: (
      input: typeof GrokBotOrchestratorInput.Type,
    ) => Effect.Effect<
      typeof GrokBotOrchestratorConfig.Type,
      GrokBotError | GrokBotOrchestratorError
    >;
    readonly setup: (
      input: typeof GrokBotOrchestratorStatusInput.Type,
    ) => Effect.Effect<
      typeof GrokBotOrchestratorConfig.Type,
      GrokBotError | GrokBotOrchestratorError
    >;
  }
>()("t3/grokBot/GrokBotOrchestratorService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const hash = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(Binding.GROK_BOT_MANAGED_SKILL_BODY),
  );
  const skillSetup = {
    workflowPath: Binding.GROK_BOT_MANAGED_WORKFLOW_PATH,
    prompt: Binding.grokBotSkillSetupPrompt(Buffer.from(hash).toString("hex")),
  };
  const guidedSetup = yield* GuidedSetup.GrokBotSetupService;
  const bots = yield* GrokBotService.GrokBotService;
  const native = yield* Native.GrokBotNativeRuntimeService;
  const settings = yield* Settings.ServerSettingsService;
  const instances = yield* Instances.ProviderInstanceRegistry;
  const mutator = yield* Mutator.ProviderInstanceRegistryMutator;
  const managed = yield* Binding.GrokBotManagedBinding;
  const setupLock = yield* Semaphore.make(1);
  const nativeSelection = Effect.gen(function* () {
    const accountBinding = yield* native.accountBinding;
    const roster = yield* native.roster(accountBinding);
    if ((yield* native.accountBinding) !== accountBinding)
      return yield* new GrokBotOrchestratorError({ reason: "account_changed" });
    return { accountBinding, roster };
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "GrokBotOrchestratorError"
        ? error
        : new GrokBotOrchestratorError({ reason: "native_account_unavailable" }),
    ),
  );

  const status = Effect.fn("GrokBotOrchestratorService.status")(function* (
    input: typeof GrokBotOrchestratorStatusInput.Type,
  ) {
    const bridge = yield* bots.status;
    const current = yield* settings.getSettings.pipe(Effect.mapError(settingsError));
    const selection = yield* nativeSelection.pipe(Effect.option);
    const entries = configuredBots(current);
    const matching = Option.isSome(selection)
      ? entries.find(({ instance }) => bindingOf(instance) === selection.value.accountBinding)
      : undefined;
    const instance = matching === undefined ? undefined : yield* instances.getInstance(matching.id);
    const provider = instance === undefined ? null : yield* instance.snapshot.refresh;
    const availability = yield* managed.availability.pipe(
      Effect.orElseSucceed(() => ({
        ready: false,
        reason: "The native account or public T3 Connect endpoint is unavailable.",
      })),
    );
    const botIds = Option.isSome(selection) ? selection.value.roster.map((bot) => bot.agentId) : [];
    if (input.botId !== undefined && Option.isSome(selection) && !botIds.includes(input.botId))
      return yield* new GrokBotError({ reason: "bot_not_found" });
    const guidedStatus = yield* guidedSetup.status.pipe(
      Effect.catchTags({
        GrokBotSetupError: (error) =>
          Effect.succeed({
            phase:
              error.stage === "account" ? ("needs_prerequisite" as const) : ("failed" as const),
            complete: false,
            primaryBot: null,
            mcpUrl: null,
            terminalCommand: null,
            authorizationUrl: null,
            retryable: error.stage === "read",
            error:
              error.stage === "account"
                ? "Sign in to GrokBot on the hosting computer, then check again."
                : "Setup status could not be read. Check the account and connection, then try again.",
            updatedAtMs: 0,
          }),
      }),
    );
    return {
      bridge,
      botIds: botIds.filter((id) => input.botId === undefined || id === input.botId),
      provider,
      state: Option.isNone(selection)
        ? ("native_account_unavailable" as const)
        : entries.length > 0 && matching === undefined
          ? ("account_changed" as const)
          : matching === undefined
            ? ("not_configured" as const)
            : provider?.enabled && provider.status === "ready" && availability.ready
              ? ("ready" as const)
              : ("blocked" as const),
      authentication: "native_account" as const,
      directDelegationSupported: true as const,
      publicEndpointReadiness: { ready: availability.ready, reason: availability.reason ?? null },
      instructions,
      skillSetup,
      setupStatus: guidedStatus,
    };
  });

  const setup = Effect.fn("GrokBotOrchestratorService.setup")(function* (
    input: typeof GrokBotOrchestratorStatusInput.Type,
  ) {
    return yield* setupLock.withPermits(1)(
      Effect.gen(function* () {
        const selection = yield* nativeSelection;
        if (
          input.botId !== undefined &&
          !selection.roster.some((bot) => bot.agentId === input.botId)
        )
          return yield* new GrokBotError({ reason: "bot_not_found" });
        const current = yield* settings.getSettings.pipe(Effect.mapError(settingsError));
        const entries = configuredBots(current);
        const matching = entries.find(
          ({ instance }) => bindingOf(instance) === selection.accountBinding,
        );
        if (entries.length > 0 && matching === undefined)
          return yield* new GrokBotOrchestratorError({ reason: "account_changed" });
        const id =
          matching?.id ??
          ProviderInstanceId.make(`grok-bot-${selection.accountBinding.slice(0, 32)}`);
        if (
          (yield* native.accountBinding.pipe(
            Effect.mapError(
              () => new GrokBotOrchestratorError({ reason: "native_account_unavailable" }),
            ),
          )) !== selection.accountBinding
        )
          return yield* new GrokBotOrchestratorError({ reason: "account_changed" });
        // The bridge adds bot management, but its installation must not block native chats.
        if (!(yield* bots.status).installed) {
          yield* bots.setup.pipe(
            Effect.catch((error) =>
              Effect.logWarning("Grok Bot bridge setup failed; native chats continue", { error }),
            ),
          );
        }
        if (matching === undefined || matching.instance.enabled === false) {
          yield* settings
            .updateProviderInstance({
              operation: matching === undefined ? "create" : "upsert",
              instanceId: id,
              instance: {
                ...matching?.instance,
                driver: ProviderDriverKind.make("grok-bot"),
                enabled: true,
                config: { accountBinding: selection.accountBinding },
              },
            })
            .pipe(Effect.mapError(settingsError));
        }
        // Reconcile the existing registry before reading its actual model catalog.
        yield* Hydration.reconcileSettings.pipe(
          Effect.provideService(Mutator.ProviderInstanceRegistryMutator, mutator),
          Effect.provideService(Settings.ServerSettingsService, settings),
          Effect.mapError(settingsError),
        );
        if ((yield* instances.getInstance(id)) === undefined)
          return yield* new GrokBotOrchestratorError({ reason: "provider_unavailable" });
        return yield* status(input);
      }),
    );
  });
  return GrokBotOrchestratorService.of({
    inspect: (input) =>
      input.action === "send_setup_prompt"
        ? Effect.gen(function* () {
            yield* setup(input);
            const setupStatus = yield* guidedSetup.send.pipe(
              Effect.mapError(
                (error) =>
                  new GrokBotOrchestratorError({
                    reason:
                      error.stage === "account"
                        ? "native_account_unavailable"
                        : "provider_unavailable",
                  }),
              ),
            );
            return { ...(yield* status(input)), setupStatus };
          })
        : input.action === "setup"
          ? setup(input)
          : status(input),
    setup,
  });
});

export const layer = Layer.effect(GrokBotOrchestratorService, make);
