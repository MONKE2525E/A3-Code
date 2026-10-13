import { TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import { MuseAgentProviderSettings } from "@t3tools/contracts/museAgent";
import type {
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Native from "../../museAgent/MuseAgentNativeRuntimeService.ts";
import * as ToolsPort from "../../museAgent/MuseAgentDirectToolsPort.ts";
import {
  createMuseAgentAdapterV2,
  MUSE_AGENT_DRIVER_KIND,
} from "../../orchestration-v2/Adapters/MuseAgentAdapterV2.ts";

const presentation = {
  displayName: "Muse",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  supportedRuntimeModes: ["full-access"],
  requiresNewThreadForModelChange: true,
} as const;
const modelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const decodeSettings = Schema.decodeSync(MuseAgentProviderSettings);
export type MuseAgentDriverEnv =
  | Native.MuseAgentNativeRuntimeService
  | ToolsPort.MuseAgentDirectToolsPort
  | ProviderHost.ProviderHost;

const checkMuseAgentProvider = Effect.fnUntraced(function* (
  options: ProviderDriverCreateInput<MuseAgentProviderSettings>,
) {
  const native = yield* Native.MuseAgentNativeRuntimeService;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const status = yield* native.status;
  const stamp = withInstanceIdentity({
    instanceId: options.instanceId,
    driverKind: MUSE_AGENT_DRIVER_KIND,
    displayName: options.displayName,
    accentColor: options.accentColor,
    continuationGroupKey: `muse-agent/account/${options.config.accountBinding ?? "unbound"}`,
  });
  const snapshot = (message: string, ready = false): ServerProvider =>
    stamp(
      buildServerProvider({
        presentation,
        enabled: options.enabled,
        checkedAt,
        models: ready
          ? [{ slug: "muse", name: "Muse", isCustom: false, capabilities: modelCapabilities }]
          : [],
        probe: {
          installed: status.installed,
          version: null,
          status: ready ? "ready" : "error",
          auth: ready
            ? { status: "authenticated", type: "cached_token", label: "Muse" }
            : { status: "unknown" },
          message,
        },
      }),
    );
  if (!options.enabled) return snapshot("Muse is disabled.");
  const binding = options.config.accountBinding;
  if (!binding) return snapshot("Connect the native Muse account before enabling this provider.");
  return yield* Effect.gen(function* () {
    if ((yield* native.accountBinding) !== binding)
      return snapshot(
        "The selected Muse account or cloud workspace changed. Set up a new provider binding.",
      );
    yield* native.resolveSession(binding);
    return snapshot("Muse is connected.", true);
  }).pipe(
    Effect.orElseSucceed(() =>
      snapshot("The authenticated Muse session is unavailable. Open Muse and reconnect."),
    ),
  );
});
const unsupportedGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Native Muse does not expose isolated text generation. Choose another provider for this operation.",
    }),
  );

export const MuseAgentDriver: ProviderDriver<MuseAgentProviderSettings, MuseAgentDriverEnv> = {
  driverKind: MUSE_AGENT_DRIVER_KIND,
  metadata: { displayName: "Muse", supportsMultipleInstances: false, hasDefaultInstance: false },
  configSchema: MuseAgentProviderSettings,
  defaultConfig: () => decodeSettings({}),
  create: (options) =>
    Effect.gen(function* () {
      const native = yield* Native.MuseAgentNativeRuntimeService;
      const orchestrationAdapter = yield* createMuseAgentAdapterV2(options);
      const check = checkMuseAgentProvider(options).pipe(
        Effect.provideService(Native.MuseAgentNativeRuntimeService, native),
      );
      const snapshot = yield* makeManagedServerProvider({
        resolveMaintenance: () =>
          Effect.succeed({ provider: MUSE_AGENT_DRIVER_KIND, packageName: null, update: null }),
        getSettings: Effect.succeed(options.config),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () => check,
        checkProvider: check,
      });
      return {
        instanceId: options.instanceId,
        driverKind: MUSE_AGENT_DRIVER_KIND,
        continuationIdentity: {
          driverKind: MUSE_AGENT_DRIVER_KIND,
          continuationKey: `muse-agent/account/${options.config.accountBinding ?? "unbound"}`,
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
            driver: MUSE_AGENT_DRIVER_KIND,
            instanceId: options.instanceId,
            detail: "Failed to build the native Muse provider.",
            cause,
          }),
      ),
    ),
};
