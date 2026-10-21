import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const NativeAgentSource = Schema.Literals(["grok-bot", "muse-agent"]);
export type NativeAgentSource = typeof NativeAgentSource.Type;

export const NativeAgentReference = Schema.Struct({
  source: NativeAgentSource,
  providerInstanceId: ProviderInstanceId,
  agentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type NativeAgentReference = typeof NativeAgentReference.Type;

export const NativeAgentOpenThreadInput = Schema.Struct({
  ...NativeAgentReference.fields,
  /** Muse only: the conversation to open. Omitted opens Main chat. */
  sessionId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  ),
});
export type NativeAgentOpenThreadInput = typeof NativeAgentOpenThreadInput.Type;
export const NativeAgentOpenThreadResult = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
});

/** Native chat namespaces remain distinct from coding providers and delegated agents. */
export function nativeAgentSourceForDriver(driver: string): NativeAgentSource | undefined {
  return driver === "grok-bot" || driver === "muse-agent" ? driver : undefined;
}

/** Historical Grok identities are preserved; Muse has its own canonical namespace. */
export function nativeAgentSourceForThread(thread: {
  readonly id: string;
}): NativeAgentSource | undefined {
  if (thread.id.startsWith("grok-bot:")) return "grok-bot";
  if (thread.id.startsWith("muse-agent:")) return "muse-agent";
  return undefined;
}

export function isNativeAgentBackingThread(thread: { readonly id: string }): boolean {
  return nativeAgentSourceForThread(thread) !== undefined;
}

/** A canonical ID is opaque; instance and native identity come from the saved selection. */
export function nativeAgentBackingThreadReference(thread: {
  readonly id: string;
  readonly modelSelection: { readonly instanceId: ProviderInstanceId; readonly model: string };
}): NativeAgentReference | undefined {
  const source = nativeAgentSourceForThread(thread);
  return source === undefined
    ? undefined
    : {
        source,
        providerInstanceId: thread.modelSelection.instanceId,
        agentId: thread.modelSelection.model,
      };
}
