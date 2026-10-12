import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { requestGuarded } from "@t3tools/client-runtime/rpc";
import * as GrokBotAvatarEngineHttp from "@t3tools/client-runtime/state/grok-bot-avatar-engine";
import { EnvironmentHttpConnectionNotReadyError } from "@t3tools/client-runtime/state/pull-requests";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  environmentRpcKey,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

// The roster carries bot profiles (name, avatar) that the Grok Bot app edits outside T3,
// so it polls fast enough that those edits show within seconds. The server's list cache
// is 5s, so polling below that would not return fresher data.
const GROK_BOTS_ROSTER_POLL_MS = 5_000;
const GROK_BOTS_ROSTER_REFRESH_MS = 30_000;
const GROK_BOTS_CONVERSATION_REFRESH_MS = 5_000;
const GROK_BOTS_ACTIVE_REFRESH_MS = 1_000;
const GROK_BOTS_REPLY_WAIT_MS = 60_000;
const conversationActivity = Atom.family((_key: string) =>
  Atom.make({ pending: 0, awaitingUntil: 0 }),
);

export const grokBotsStatusQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bots:status",
  tag: WS_METHODS.grokBotsStatus,
  staleTimeMs: 5_000,
  idleTtlMs: 5 * 60_000,
  refreshIntervalMs: GROK_BOTS_ROSTER_POLL_MS,
});

export const grokBotsListQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bots:list",
  tag: WS_METHODS.grokBotsList,
  staleTimeMs: 5_000,
  idleTtlMs: 5 * 60_000,
  refreshIntervalMs: GROK_BOTS_ROSTER_POLL_MS,
});

/**
 * Native Grok Bot provider state. The method is guarded (settings write scope),
 * so the query goes through the guarded request path that the query family excludes.
 */
export const grokBotsOrchestratorConfigQuery = createEnvironmentQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bots:orchestrator-config",
    staleTimeMs: 5_000,
    idleTtlMs: 5 * 60_000,
    refreshIntervalMs: GROK_BOTS_ROSTER_REFRESH_MS,
    execute: (input: { readonly botId?: string }) =>
      requestGuarded(WS_METHODS.grokBotsOrchestratorConfig, input),
  },
);

/** The engine is content-addressed, so a long stale time only avoids refetching the same bytes. */
export const grokBotAvatarEngineQuery = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bots:avatar-engine",
  staleTimeMs: 60 * 60_000,
  idleTtlMs: 5 * 60_000,
  execute: () =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const loader = yield* GrokBotAvatarEngineHttp.GrokBotAvatarEngineLoader;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) {
        return yield* new EnvironmentHttpConnectionNotReadyError({
          message: "The environment HTTP connection is not ready.",
        });
      }
      return yield* loader.load(prepared.value);
    }),
});

const readQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bots:read",
  tag: WS_METHODS.grokBotsRead,
  staleTimeMs: 1_000,
  idleTtlMs: 5 * 60_000,
});
const conversationQuery = Atom.family((key: string) => {
  const target = JSON.parse(key) as [EnvironmentId, { botId: string }];
  const source = readQuery({ environmentId: target[0], input: target[1] });
  return Atom.transform(
    source,
    (get) => {
      const result = get(source);
      const activity = get(conversationActivity(key));
      const streaming =
        AsyncResult.isSuccess(result) && result.value.messages.at(-1)?.streaming === true;
      // Schedule after each completed read so a slow gateway never gets overlapping polls.
      if (!result.waiting) {
        const active = activity.pending > 0 || activity.awaitingUntil > Date.now() || streaming;
        const timer = setTimeout(
          () => get.refresh(source),
          active ? GROK_BOTS_ACTIVE_REFRESH_MS : GROK_BOTS_CONVERSATION_REFRESH_MS,
        );
        get.addFinalizer(() => clearTimeout(timer));
      }
      return result;
    },
    { initialValueTarget: source },
  ).pipe(Atom.setIdleTTL(0));
});
export const grokBotsReadQuery = (target: Parameters<typeof readQuery>[0]) =>
  conversationQuery(environmentRpcKey(target));

/**
 * Re-reads the roster now, on top of the poll. Surfaces call this when they open, when the
 * window regains focus, and after a mutation settles, so profile edits never wait for a poll.
 */
export function refreshGrokBotRoster(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  registry.refresh(grokBotsStatusQuery({ environmentId, input: {} }));
  registry.refresh(grokBotsListQuery({ environmentId, input: {} }));
}

/** Re-reads one bot's conversation and the roster it is listed in. */
export function refreshGrokBotConversation(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  botId: string,
) {
  refreshGrokBotRoster(registry, environmentId);
  registry.refresh(grokBotsReadQuery({ environmentId, input: { botId } }));
}

export const grokBotsSetup = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:setup",
  tag: WS_METHODS.grokBotsSetup,
  onSuccess: (target, registry) =>
    Effect.sync(() => refreshGrokBotRoster(registry, target.environmentId)),
});

/** Explicitly enables the selected native account as one T3 provider instance. Creates no threads. */
export const grokBotsOrchestratorSetup = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:orchestrator-setup",
  tag: WS_METHODS.grokBotsOrchestratorConfig,
  onSuccess: (target, registry) =>
    Effect.sync(() => {
      registry.refresh(
        grokBotsOrchestratorConfigQuery({ environmentId: target.environmentId, input: {} }),
      );
      refreshGrokBotRoster(registry, target.environmentId);
    }),
});

/** The server finds or creates the bot's native thread. Opens are serial per bot, so a repeat open returns the same thread. */
export const grokBotsOpenThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:open-thread",
  tag: WS_METHODS.grokBotsOpenThread,
  concurrency: {
    mode: "serial",
    key: (target) => `${target.environmentId}:${target.input.botId}`,
  },
  onSuccess: (target, registry) =>
    Effect.sync(() => refreshGrokBotRoster(registry, target.environmentId)),
});

const sendCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:send",
  tag: WS_METHODS.grokBotsSend,
  concurrency: {
    mode: "serial",
    key: (target) => `${target.environmentId}:${target.input.botId}`,
  },
});
export const grokBotsSend: typeof sendCommand = {
  ...sendCommand,
  run: async (registry, target) => {
    const conversation = {
      environmentId: target.environmentId,
      input: { botId: target.input.botId },
    };
    const activity = conversationActivity(environmentRpcKey(conversation));
    registry.set(activity, {
      ...registry.get(activity),
      pending: registry.get(activity).pending + 1,
    });
    try {
      return await sendCommand.run(registry, target);
    } finally {
      registry.set(activity, {
        pending: Math.max(0, registry.get(activity).pending - 1),
        awaitingUntil: Date.now() + GROK_BOTS_REPLY_WAIT_MS,
      });
      // Uncertain delivery still needs a read; never resend it automatically.
      refreshGrokBotConversation(registry, target.environmentId, target.input.botId);
    }
  },
};

/**
 * Secret questions a bot is asking in one native session. The server reads only the transcript
 * and returns no values, so polling it is the only way a pending request reaches the screen.
 */
export const grokBotsSecretPendingQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bots:secret-pending",
    tag: WS_METHODS.grokBotsSecretPending,
    staleTimeMs: 1_000,
    idleTtlMs: 5 * 60_000,
    refreshIntervalMs: GROK_BOTS_CONVERSATION_REFRESH_MS,
  },
);

const secretSubmitCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:secret-submit",
  tag: WS_METHODS.grokBotsSecretSubmit,
});
/** Re-reads the pending list after every settle, so an answered or expired request leaves the screen. */
export const grokBotsSecretSubmit: typeof secretSubmitCommand = {
  ...secretSubmitCommand,
  run: async (registry, target) => {
    try {
      return await secretSubmitCommand.run(registry, target);
    } finally {
      registry.refresh(
        grokBotsSecretPendingQuery({
          environmentId: target.environmentId,
          input: { botId: target.input.botId, sessionId: target.input.sessionId },
        }),
      );
    }
  },
};

const secretDismissCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:secret-dismiss",
  tag: WS_METHODS.grokBotsSecretDismiss,
});
/** Native's widget dismissal, with the same pending re-read as a submit. */
export const grokBotsSecretDismiss: typeof secretDismissCommand = {
  ...secretDismissCommand,
  run: async (registry, target) => {
    try {
      return await secretDismissCommand.run(registry, target);
    } finally {
      registry.refresh(
        grokBotsSecretPendingQuery({
          environmentId: target.environmentId,
          input: { botId: target.input.botId, sessionId: target.input.sessionId },
        }),
      );
    }
  },
};

/** Native routines are owned by the Grok Bot account. T3 reads them and flips their enabled state only. */
export const grokBotsRoutinesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bots:routines",
  tag: WS_METHODS.grokBotsListRoutines,
  staleTimeMs: 15_000,
  idleTtlMs: 5 * 60_000,
  refreshIntervalMs: GROK_BOTS_ROSTER_REFRESH_MS,
});

/** Public marketplace listings. Read-only: browsing never imports or installs a template. */
export const grokBotsMarketplaceQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bots:marketplace",
  tag: WS_METHODS.grokBotsListMarketplace,
  staleTimeMs: 5 * 60_000,
  idleTtlMs: 5 * 60_000,
});

/** Catalog plugins shown beside bot templates. Read-only; a failure here never hides the bots. */
export const grokBotsMarketplacePluginsQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bots:marketplace-plugins",
    tag: WS_METHODS.grokBotsListMarketplacePlugins,
    staleTimeMs: 5 * 60_000,
    idleTtlMs: 5 * 60_000,
  },
);

/** Plugin ids installed on the account. Small, so an install or uninstall refreshes it directly. */
export const grokBotsInstalledPluginsQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bots:installed-plugins",
    tag: WS_METHODS.grokBotsListInstalledMarketplacePlugins,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
  },
);

export const grokBotsPluginConnectionsQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bots:plugin-connections",
    tag: WS_METHODS.grokBotsPluginConnections,
    staleTimeMs: 10_000,
  },
);
export const grokBotsPluginAuthenticate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:plugin-authenticate",
  tag: WS_METHODS.grokBotsPluginAuthenticate,
});
export const grokBotsPluginCompleteAuth = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:plugin-complete-auth",
  tag: WS_METHODS.grokBotsPluginCompleteAuth,
});

export const grokBotsInstallMarketplacePlugin = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:install-marketplace-plugin",
  tag: WS_METHODS.grokBotsInstallMarketplacePlugin,
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(
        grokBotsInstalledPluginsQuery({ environmentId: target.environmentId, input: {} }),
      ),
    ),
});

export const grokBotsUninstallMarketplacePlugin = createEnvironmentRpcCommand(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bots:uninstall-marketplace-plugin",
    tag: WS_METHODS.grokBotsUninstallMarketplacePlugin,
    onSuccess: (target, registry) =>
      Effect.sync(() =>
        registry.refresh(
          grokBotsInstalledPluginsQuery({ environmentId: target.environmentId, input: {} }),
        ),
      ),
  },
);

/** One template's recipe preview. Keyed by share id; the server downloads the recipe on demand. */
export const grokBotsMarketplaceTemplateQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bots:marketplace-template",
    tag: WS_METHODS.grokBotsGetMarketplaceTemplate,
    staleTimeMs: 5 * 60_000,
    idleTtlMs: 5 * 60_000,
  },
);

/** Creates one bot from a template. The roster poll picks the new bot up once the server's list cache expires. */
export const grokBotsImportMarketplaceTemplate = createEnvironmentRpcCommand(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bots:import-marketplace-template",
    tag: WS_METHODS.grokBotsImportMarketplaceTemplate,
    onSuccess: (target, registry) =>
      Effect.sync(() => refreshGrokBotRoster(registry, target.environmentId)),
  },
);

/** Native skills, mentionable bots, and connectors for the grok-bot composer. */
export const grokBotsComposerResourcesQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bots:composer-resources",
    tag: WS_METHODS.grokBotsListComposerResources,
    staleTimeMs: 15_000,
    idleTtlMs: 5 * 60_000,
    refreshIntervalMs: GROK_BOTS_ROSTER_REFRESH_MS,
  },
);

export const grokBotsSetRoutineEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:set-routine-enabled",
  tag: WS_METHODS.grokBotsSetRoutineEnabled,
  concurrency: {
    mode: "serial",
    key: (target) => `${target.environmentId}:${target.input.botId}:${target.input.routineId}`,
  },
  onSuccess: (target, registry) =>
    Effect.sync(() => {
      registry.refresh(grokBotsRoutinesQuery({ environmentId: target.environmentId, input: {} }));
      refreshGrokBotRoster(registry, target.environmentId);
    }),
});

/** Creates one bot on the Grok Bot account. The roster refresh shows it in the sidebar. */
export const grokBotsCreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:create",
  tag: WS_METHODS.grokBotsCreate,
  onSuccess: (target, registry) =>
    Effect.sync(() => refreshGrokBotRoster(registry, target.environmentId)),
});

export const grokBotsUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:update",
  tag: WS_METHODS.grokBotsUpdate,
  concurrency: {
    mode: "serial",
    key: (target) => `${target.environmentId}:${target.input.botId}`,
  },
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      refreshGrokBotConversation(registry, target.environmentId, target.input.botId),
    ),
});

/** Deletes the bot from the Grok Bot account. The roster refresh removes it from the sidebar. */
export const grokBotsDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:delete",
  tag: WS_METHODS.grokBotsDelete,
  concurrency: {
    mode: "serial",
    key: (target) => `${target.environmentId}:${target.input.botId}`,
  },
  onSuccess: (target, registry) =>
    Effect.sync(() => refreshGrokBotRoster(registry, target.environmentId)),
});

export const grokBotsDeleteRoutine = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:delete-routine",
  tag: WS_METHODS.grokBotsDeleteRoutine,
  concurrency: {
    mode: "serial",
    key: (target) => `${target.environmentId}:${target.input.botId}:${target.input.routineId}`,
  },
  onSuccess: (target, registry) =>
    Effect.sync(() => {
      registry.refresh(grokBotsRoutinesQuery({ environmentId: target.environmentId, input: {} }));
      refreshGrokBotRoster(registry, target.environmentId);
    }),
});
