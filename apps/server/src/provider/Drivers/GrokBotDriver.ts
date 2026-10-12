import {
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { GrokBotProviderSettings } from "@t3tools/contracts/grokBotProvider";
import {
  type ProviderDriver,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { GrokBotNativeRuntimeService } from "../../grokBot/GrokBotNativeRuntimeService.ts";
import {
  createGrokBotAdapterV2,
  GROK_BOT_DRIVER_KIND,
  type GrokBotAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/GrokBotAdapterV2.ts";
import {
  GrokBotManagedBinding,
  GROK_BOT_PROTOCOL_BLOCKER,
} from "../../orchestration-v2/Adapters/GrokBotManagedBinding.ts";

const presentation = {
  displayName: "Grok Bot",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  supportedRuntimeModes: ["full-access"],
  requiresNewThreadForModelChange: true,
} as const;
const modelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const decodeSettings = Schema.decodeSync(GrokBotProviderSettings);
export type GrokBotDriverEnv = GrokBotAdapterV2DriverEnv | ProviderHost.ProviderHost;

/** Native bots are durable model choices; account changes never reuse an instance. */
export const checkGrokBotProvider = Effect.fnUntraced(function* (
  options: ProviderDriverCreateInput<GrokBotProviderSettings>,
) {
  const native = yield* GrokBotNativeRuntimeService;
  const binding = yield* GrokBotManagedBinding;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const continuationKey = `grok-bot/account/${options.config.accountBinding ?? "unbound"}`;
  const stamp = withInstanceIdentity({
    instanceId: options.instanceId,
    driverKind: GROK_BOT_DRIVER_KIND,
    displayName: options.displayName,
    accentColor: options.accentColor,
    continuationGroupKey: continuationKey,
  });
  const snapshot = (input: {
    readonly models?: readonly ServerProviderModel[];
    readonly authenticated?: boolean;
    readonly message: string;
    readonly usageLimits?: ServerProvider["usageLimits"];
    readonly account?: { readonly email?: string; readonly plan?: string };
  }): ServerProvider =>
    stamp(
      buildServerProvider({
        presentation,
        enabled: options.enabled,
        checkedAt,
        models: input.models ?? [],
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: input.authenticated
            ? {
                status: "authenticated",
                type: "cached_token",
                label: input.account?.plan ?? "Grok Bot",
                ...(input.account?.email ? { email: input.account.email } : {}),
              }
            : { status: "unknown" },
          message: input.message,
          ...(input.usageLimits === undefined ? {} : { usageLimits: input.usageLimits }),
        },
      }),
    );
  if (!options.enabled) return snapshot({ message: "Grok Bot is disabled." });
  if (options.config.accountBinding === null)
    return snapshot({
      message: "Choose the native Grok Bot account before enabling this provider.",
    });
  return yield* Effect.gen(function* () {
    if ((yield* native.accountBinding) !== options.config.accountBinding)
      return snapshot({
        message: "The selected Grok Bot account or team changed. Bind the provider again.",
      });
    const bots = yield* native.roster(options.config.accountBinding);
    const usageLimits = yield* native.usageLimits(options.config.accountBinding, checkedAt).pipe(
      Effect.orElseSucceed(() =>
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "The native Grok Bot allowance could not be read.",
        }),
      ),
    );
    const account = yield* native
      .accountInfo(options.config.accountBinding)
      .pipe(Effect.orElseSucceed(() => ({})));
    // Do not publish models from a different account if selection changes during discovery.
    if ((yield* native.accountBinding) !== options.config.accountBinding)
      return snapshot({
        message: "The selected Grok Bot account or team changed during discovery.",
      });
    const models: ServerProviderModel[] = bots.map((bot) => ({
      slug: bot.agentId,
      name: bot.name || bot.agentId,
      isCustom: false,
      capabilities: modelCapabilities,
    }));
    const availability = yield* binding.availability;
    const result = snapshot({
      models,
      authenticated: true,
      usageLimits,
      account,
      message: availability.reason ?? GROK_BOT_PROTOCOL_BLOCKER,
    });
    return availability.ready ? { ...result, status: "ready" as const } : result;
  }).pipe(
    Effect.orElseSucceed(() =>
      snapshot({ message: "The selected native Grok Bot account is unavailable." }),
    ),
  );
});

const unsupportedGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Grok Bot does not expose isolated text generation. Choose another provider for this operation.",
    }),
  );

export const GrokBotDriver: ProviderDriver<GrokBotProviderSettings, GrokBotDriverEnv> = {
  driverKind: GROK_BOT_DRIVER_KIND,
  metadata: {
    displayName: "Grok Bot",
    supportsMultipleInstances: false,
    hasDefaultInstance: false,
  },
  configSchema: GrokBotProviderSettings,
  defaultConfig: () => decodeSettings({}),
  create: (options) =>
    Effect.gen(function* () {
      const native = yield* GrokBotNativeRuntimeService;
      const binding = yield* GrokBotManagedBinding;
      const orchestrationAdapter = yield* createGrokBotAdapterV2(options);
      const check = checkGrokBotProvider(options).pipe(
        Effect.provideService(GrokBotNativeRuntimeService, native),
        Effect.provideService(GrokBotManagedBinding, binding),
      );
      const snapshot = yield* makeManagedServerProvider({
        resolveMaintenance: () =>
          Effect.succeed({ provider: GROK_BOT_DRIVER_KIND, packageName: null, update: null }),
        getSettings: Effect.succeed(options.config),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () => check,
        checkProvider: check,
      });
      return {
        instanceId: options.instanceId,
        driverKind: GROK_BOT_DRIVER_KIND,
        continuationIdentity: {
          driverKind: GROK_BOT_DRIVER_KIND,
          continuationKey: `grok-bot/account/${options.config.accountBinding ?? "unbound"}`,
        },
        displayName: options.displayName,
        accentColor: options.accentColor,
        enabled: options.enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration: {
          generateCommitMessage: () => unsupportedGeneration("generateCommitMessage"),
          generatePrContent: () => unsupportedGeneration("generatePrContent"),
          generateReviewGuide: () => unsupportedGeneration("generateReviewGuide"),
          generateBranchName: () => unsupportedGeneration("generateBranchName"),
          generateThreadTitle: () => unsupportedGeneration("generateThreadTitle"),
        },
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: GROK_BOT_DRIVER_KIND,
            instanceId: options.instanceId,
            detail: "Failed to build the native Grok Bot provider.",
            cause,
          }),
      ),
    ),
};
