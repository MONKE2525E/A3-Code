import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { createMuseAgentComputerStreamCommand } from "@t3tools/client-runtime/state/muse-agent-computer-stream";
import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

// Profile edits happen in the Muse app, so the roster polls like Grok's; detection is cheap.
const MUSE_AGENT_POLL_MS = 5_000;

/** Runtime found, session found, and the capabilities the server can actually back. */
export const museAgentStatusQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:muse-agent:status",
  tag: WS_METHODS.museAgentsStatus,
  staleTimeMs: 5_000,
  idleTtlMs: 5 * 60_000,
  refreshIntervalMs: MUSE_AGENT_POLL_MS,
});

/** The one personal assistant's name and art. Image and video URLs are served by this environment. */
export const museAgentProfileQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:muse-agent:profile",
  tag: WS_METHODS.museAgentsProfile,
  staleTimeMs: 5_000,
  idleTtlMs: 5 * 60_000,
  refreshIntervalMs: MUSE_AGENT_POLL_MS,
});

export function refreshMuseAgent(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  registry.refresh(museAgentStatusQuery({ environmentId, input: {} }));
  registry.refresh(museAgentProfileQuery({ environmentId, input: {} }));
}

/** Explicit, idempotent detection and provider enable. Creates no threads. */
export const museAgentSetup = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:muse-agent:setup",
  tag: WS_METHODS.museAgentsSetup,
  onSuccess: (target, registry) =>
    Effect.sync(() => refreshMuseAgent(registry, target.environmentId)),
});

export const museAgentCloseSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:muse-agent:close-sign-in",
  tag: WS_METHODS.museAgentsCloseSignIn,
});

export const museAgentSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:muse-agent:sign-in",
  tag: WS_METHODS.museAgentsSignIn,
});

/**
 * Native Muse feature reads, one tagged operation per call. Short stale time: these are the
 * account's live data, refreshed by the panel's retry and after every write.
 */
export const museAgentFeatureReadQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:muse-agent:feature-read",
    tag: WS_METHODS.museAgentsFeatureRead,
    staleTimeMs: 10_000,
    idleTtlMs: 60_000,
  },
);

export const museAgentCredentialRequestsQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:muse-agent:credential-requests",
    tag: WS_METHODS.museAgentsFeatureRead,
    staleTimeMs: 1000,
    idleTtlMs: 10000,
    refreshIntervalMs: 5000,
  },
);

/** Guarded native writes: routine delete, conversation rename, archive and unarchive. */
export const museAgentFeatureUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:muse-agent:feature-update",
  tag: WS_METHODS.museAgentsFeatureUpdate,
  onSuccess: (target, registry) =>
    Effect.sync(() => {
      const { providerInstanceId } = target.input;
      if ("connectorId" in target.input) {
        registry.refresh(
          museAgentFeatureReadQuery({
            environmentId: target.environmentId,
            input: { operation: "connectors", providerInstanceId },
          }),
        );
        for (const operation of ["connector_info", "connector_accounts"] as const)
          registry.refresh(
            museAgentFeatureReadQuery({
              environmentId: target.environmentId,
              input: { operation, providerInstanceId, connectorId: target.input.connectorId },
            }),
          );
      }
      if (target.input.operation === "computer_action") {
        // Stop/close change one task and the computer list; refresh both, never the other tabs.
        const { sessionId, taskId } = target.input;
        for (const input of [
          { operation: "computer" },
          { operation: "computer_task", sessionId, taskId },
        ] as const) {
          registry.refresh(
            museAgentFeatureReadQuery({
              environmentId: target.environmentId,
              input: { ...input, providerInstanceId },
            }),
          );
        }
        return;
      }
      for (const input of [
        { operation: "tasks" },
        { operation: "sessions", view: "active" },
        { operation: "sessions", view: "archived" },
        { operation: "pending_deliveries" },
      ] as const) {
        registry.refresh(
          museAgentFeatureReadQuery({
            environmentId: target.environmentId,
            input: { ...input, providerInstanceId },
          }),
        );
      }
    }),
});

/**
 * Explicit "load earlier Muse history". Importing one older page into the same T3 thread writes,
 * so it is an operate-scoped feature update, never a cached query. The metadata inspect stays on
 * `museAgentFeatureReadQuery` and is refreshed once the import finishes.
 */
export const museAgentHistoryPageCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:muse-agent:history-page",
  tag: WS_METHODS.museAgentsFeatureUpdate,
  concurrency: {
    mode: "serial",
    key: (target) => `${target.environmentId}:muse-history`,
  },
  onSuccess: (target, registry) =>
    Effect.sync(() => {
      if (target.input.operation !== "history_page") return;
      const { providerInstanceId, threadId } = target.input;
      registry.refresh(
        museAgentFeatureReadQuery({
          environmentId: target.environmentId,
          input: { operation: "history_page", providerInstanceId, threadId },
        }),
      );
    }),
});

/** Mints a fresh ticketed socket URL for one interactive computer viewer. Never cached or stored. */
export const museAgentComputerStreamCommand =
  createMuseAgentComputerStreamCommand(connectionAtomRuntime);

/** The server finds or creates the persistent Muse thread; a repeat open returns the same one. */
export const museAgentOpenThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:muse-agent:open-thread",
  tag: WS_METHODS.museAgentsOpenThread,
  onSuccess: (target, registry, result) =>
    Effect.sync(() => {
      refreshMuseAgent(registry, target.environmentId);
      registry.refresh(
        museAgentFeatureReadQuery({
          environmentId: target.environmentId,
          input: {
            operation: "history_page",
            providerInstanceId: target.input.providerInstanceId,
            threadId: result.threadId,
          },
        }),
      );
    }),
  concurrency: {
    mode: "serial",
    key: (target) => `${target.environmentId}:muse`,
  },
});

export const museAgentOptionWidgetsQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:muse-agent:option-widgets",
    tag: WS_METHODS.museAgentsFeatureRead,
    staleTimeMs: 1000,
    idleTtlMs: 10000,
  },
);
