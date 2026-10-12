import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "../connection/runtime";

export const grokBotHostMachinesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bot:host-machines",
  tag: WS_METHODS.grokBotsHostMachines,
  staleTimeMs: 10_000,
  idleTtlMs: 60_000,
});
export const grokBotHostMachineUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "grok-bot:host-machine-update",
  tag: WS_METHODS.grokBotsHostMachineUpdate,
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(
        grokBotHostMachinesQuery({ environmentId: target.environmentId, input: {} }),
      ),
    ),
});
export const grokBotNetworkQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bot:network",
  tag: WS_METHODS.grokBotsNetworkRead,
  staleTimeMs: 5_000,
  refreshIntervalMs: 5_000,
  idleTtlMs: 0,
});
export const grokBotNetworkSet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "grok-bot:network-set",
  tag: WS_METHODS.grokBotsNetworkSet,
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(grokBotNetworkQuery({ environmentId: target.environmentId, input: {} })),
    ),
});
