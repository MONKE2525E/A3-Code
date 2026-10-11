import type { ProviderInstanceId, ServerConfig } from "@t3tools/contracts";
import { GrokBotProviderSettings } from "@t3tools/contracts/grokBotProvider";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  findGrokBotNativeThread,
  grokBotNativeInstanceId,
  type GrokBotNativeReadiness,
  type GrokBotNativeThreadCandidate,
} from "./grokBotNativeThread";

const decodeSettings = Schema.decodeUnknownOption(GrokBotProviderSettings);

/** Archived conversations need the server open path to restore their active state. */
export function findCachedGrokBotNativeThread<T extends GrokBotNativeThreadCandidate>(
  threads: ReadonlyArray<T>,
  input: { readonly instanceId: ProviderInstanceId; readonly botId: string },
): T | null {
  const thread = findGrokBotNativeThread(threads, input);
  return thread?.archivedAt === null ? thread : null;
}

/** Only transport failures permit offline browsing; account and permission failures stay authoritative. */
export function isGrokBotReadinessTransportFailure(failure: unknown): boolean {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) return false;
  if (
    failure._tag === "EnvironmentRpcUnavailableError" ||
    failure._tag === "ConnectionTransientError"
  )
    return true;
  if (failure._tag !== "RpcClientError" || !("reason" in failure)) return false;
  const reason = failure.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    "_tag" in reason &&
    (reason._tag === "SocketOpenError" ||
      reason._tag === "SocketCloseError" ||
      reason._tag === "SocketReadError" ||
      reason._tag === "SocketWriteError")
  );
}

/** Browse a previously verified account while its fresh readiness query loads. */
export function cachedGrokBotNativeInstanceId(
  config: Pick<ServerConfig, "providers" | "settings"> | null,
  readiness: GrokBotNativeReadiness,
): ProviderInstanceId | null {
  const liveInstance = grokBotNativeInstanceId(readiness);
  if (config === null) return liveInstance;
  // A fresh rejection wins over a cached provider. Never infer the account from an instance ID.
  if (liveInstance === null && readiness.kind !== "pending") return null;
  const candidates = config.providers.filter((provider) => {
    if (
      provider.driver !== "grok-bot" ||
      !provider.enabled ||
      provider.availability === "unavailable" ||
      provider.auth.status !== "authenticated"
    )
      return false;
    const instance = config.settings.providerInstances[provider.instanceId];
    if (instance?.driver !== "grok-bot" || instance.enabled === false) return false;
    const binding = Option.getOrNull(decodeSettings(instance.config ?? {}))?.accountBinding;
    return binding != null && provider.continuation?.groupKey === `grok-bot/account/${binding}`;
  });
  // Settings and provider streams can invalidate a retained successful readiness query first.
  if (liveInstance !== null) {
    return candidates.some((provider) => provider.instanceId === liveInstance)
      ? liveInstance
      : null;
  }
  // Multiple account snapshots are ambiguous until the server resolves the selected account.
  return candidates.length === 1 ? candidates[0]!.instanceId : null;
}
