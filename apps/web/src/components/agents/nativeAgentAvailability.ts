import type { ProviderInstanceConfig } from "@t3tools/contracts";

export type AgentMarketplace = "muse-agent" | "grok-bot";

/** Discovery follows configured providers, never applications detected on the host. */
export function enabledAgentMarketplaces(
  instances: Readonly<Record<string, ProviderInstanceConfig>> | undefined,
): AgentMarketplace[] {
  const enabled = new Set<string>(
    Object.values(instances ?? {})
      .filter((instance) => instance.enabled !== false)
      .map((instance) => instance.driver),
  );
  return (["muse-agent", "grok-bot"] as const).filter((driver) => enabled.has(driver));
}

export function selectedAgentMarketplace(
  available: readonly AgentMarketplace[],
  requested: AgentMarketplace | null,
): AgentMarketplace | null {
  return requested !== null && available.includes(requested) ? requested : (available[0] ?? null);
}
