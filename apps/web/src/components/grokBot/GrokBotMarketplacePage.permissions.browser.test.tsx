import { EnvironmentId, clientRpcRequiredScopes, WS_METHODS } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ scopes: [] as string[] }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (required: string[]) => required.every((scope) => mocks.scopes.includes(scope)),
}));
vi.mock("/src/state/museAgent.ts", () => ({
  museAgentStatusQuery: () => "status",
  museAgentFeatureReadQuery: (query: unknown) => query,
  museAgentFeatureUpdate: {
    permissionAtom: (_env: unknown, input: unknown) =>
      clientRpcRequiredScopes(WS_METHODS.museAgentsFeatureUpdate, input),
  },
  refreshMuseAgent: vi.fn(),
}));
vi.mock("/src/state/query.ts", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data:
      query === "status"
        ? { ready: true, provider: { instanceId: "muse-test" } }
        : {
            operation: "connectors",
            data: [
              {
                id: "synthetic",
                name: "Synthetic connection",
                description: "Test",
                state: "disconnected",
              },
            ],
          },
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("/src/state/use-atom-command.ts", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("/src/hooks/useSettings.ts", () => ({
  useEnvironmentSettings: () => ({
    providerInstances: { muse: { driver: "muse-agent", enabled: true } },
  }),
}));
vi.mock("/src/components/settings/SettingsScopeContext.tsx", () => ({
  useSettingsScope: () => ({
    environment: { environmentId: EnvironmentId.make("test-env") },
    scope: { kind: "environment" },
  }),
}));
vi.mock("/src/components/settings/settingsLayout.tsx", () => ({
  SettingsPageContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock("/src/components/settings/settingsSearch.ts", () => ({ searchableSetting: () => ({}) }));
vi.mock("/src/components/grokBot/marketplaceIconCache.ts", () => ({
  loadMarketplaceIcon: async () => null,
}));
vi.mock("/src/components/grokBot/GrokBotPluginAuthCallback.tsx", () => ({
  GrokBotPluginAuthCallback: () => null,
}));
vi.mock("/src/components/grokBot/GrokBotMarketplaceBrowse.tsx", () => ({
  GrokBotMarketplaceBrowse: () => null,
}));
vi.mock("/src/components/agents/MuseAgentFeaturesDialog.tsx", () => ({
  MuseAgentSkillsSection: () => null,
}));
vi.mock("/src/components/agents/AddMuseAgentProviderStep.tsx", () => ({
  AddMuseAgentProviderStep: () => null,
}));
import { GrokBotMarketplacePage } from "./GrokBotMarketplacePage";

it.each([
  { scopes: ["orchestration:operate"], enabled: false },
  { scopes: ["settings:write"], enabled: true },
])("gates marketplace connection controls for $scopes", async ({ scopes, enabled }) => {
  mocks.scopes = scopes;
  await using screen = await render(<GrokBotMarketplacePage />);
  const connect = screen.getByRole("button", { name: "Connect Synthetic connection" });
  await expect.element(connect).toBeVisible();
  if (enabled) await expect.element(connect).toBeEnabled();
  else await expect.element(connect).toBeDisabled();
  if (!enabled) {
    await connect.click({ force: true });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  }
});
