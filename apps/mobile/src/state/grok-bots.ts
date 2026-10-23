import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const grokBotsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:grok-bots:list",
  tag: WS_METHODS.grokBotsList,
  staleTimeMs: 5_000,
  idleTtlMs: 0,
});

export const grokBotsOpenThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:grok-bots:open-thread",
  tag: WS_METHODS.grokBotsOpenThread,
  concurrency: { mode: "serial", key: (target) => `${target.environmentId}:${target.input.botId}` },
});
