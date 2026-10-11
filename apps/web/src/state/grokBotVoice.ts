import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

// Voice commands are guarded (operate scope). Their results carry short-lived realtime secrets,
// so callers read them once and nothing here keeps a command result in an atom.
export const grokBotsVoiceStart = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:voice-start",
  tag: WS_METHODS.grokBotsVoiceStart,
});

export const grokBotsVoiceRefresh = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:voice-refresh",
  tag: WS_METHODS.grokBotsVoiceRefresh,
});

export const grokBotsVoiceTool = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:voice-tool",
  tag: WS_METHODS.grokBotsVoiceTool,
});

export const grokBotsVoiceConnected = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:voice-connected",
  tag: WS_METHODS.grokBotsVoiceConnected,
});

export const grokBotsVoiceEnd = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:grok-bots:voice-end",
  tag: WS_METHODS.grokBotsVoiceEnd,
});
