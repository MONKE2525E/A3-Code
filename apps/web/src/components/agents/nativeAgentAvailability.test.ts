import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { enabledAgentMarketplaces, selectedAgentMarketplace } from "./nativeAgentAvailability";

it("exposes only enabled, configured native providers and selects the remaining marketplace", () => {
  expect(enabledAgentMarketplaces(undefined)).toEqual([]);
  const providers = enabledAgentMarketplaces({
    muse: { driver: ProviderDriverKind.make("muse-agent"), enabled: false, config: {} },
    grok: { driver: ProviderDriverKind.make("grok-bot"), enabled: true, config: {} },
    codex: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
  });
  expect(providers).toEqual(["grok-bot"]);
  expect(selectedAgentMarketplace(providers, "muse-agent")).toBe("grok-bot");
  expect(selectedAgentMarketplace([], null)).toBeNull();
  expect(selectedAgentMarketplace(["muse-agent", "grok-bot"], "grok-bot")).toBe("grok-bot");
});
