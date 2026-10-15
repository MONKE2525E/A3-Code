// @vitest-environment jsdom
import { EnvironmentId, clientRpcRequiredScopes, WS_METHODS } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ scopes: [] as string[] }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (required: string[]) => required.every((scope) => mocks.scopes.includes(scope)),
}));
vi.mock("~/state/museAgent", () => ({
  museAgentStatusQuery: () => "status",
  museAgentFeatureReadQuery: (query: unknown) => query,
  museAgentFeatureUpdate: {
    permissionAtom: (_env: unknown, input: unknown) =>
      clientRpcRequiredScopes(WS_METHODS.museAgentsFeatureUpdate, input),
  },
  refreshMuseAgent: vi.fn(),
}));
vi.mock("~/state/query", () => ({
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
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    providerInstances: { muse: { driver: "muse-agent", enabled: true } },
  }),
}));
vi.mock("~/components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environment: { environmentId: EnvironmentId.make("test-env") },
    scope: { kind: "environment" },
  }),
}));
vi.mock("~/components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock("~/components/settings/settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./GrokBotPluginAuthCallback", () => ({ GrokBotPluginAuthCallback: () => null }));
vi.mock("./GrokBotMarketplaceBrowse", () => ({ GrokBotMarketplaceBrowse: () => null }));
vi.mock("../agents/MuseAgentFeaturesDialog", () => ({ MuseAgentSkillsSection: () => null }));
vi.mock("../agents/AddMuseAgentProviderStep", () => ({ AddMuseAgentProviderStep: () => null }));
import { GrokBotMarketplacePage } from "./GrokBotMarketplacePage";

it.each([
  { scopes: ["orchestration:operate"], enabled: false },
  { scopes: ["settings:write"], enabled: true },
])("gates marketplace connection controls for $scopes", async ({ scopes, enabled }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.scopes = scopes;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<GrokBotMarketplacePage />));
    const connect = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Connect Synthetic connection"]',
    )!;
    expect(connect).not.toBeNull();
    expect(connect.disabled).toBe(!enabled);
    if (!enabled) {
      await act(async () => connect.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
