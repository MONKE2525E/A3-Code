import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * The server finds or creates the persistent Muse thread; a repeat open returns the same one.
 * Call only after `resolveMuseAgentNativeOpenPlan` says `open`. Ordinary threads must not.
 */
export const museAgentOpenThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:muse-agent:open-thread",
  tag: WS_METHODS.museAgentsOpenThread,
  concurrency: {
    mode: "serial",
    key: (target) => `${target.environmentId}:muse`,
  },
});
