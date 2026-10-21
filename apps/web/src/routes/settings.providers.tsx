import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import {
  providerSelectionSearch,
  validateGrokBotSettingsSearch,
} from "../components/grokBot/grokBotPresentation";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const navigate = useNavigate();
  // Keep the picked provider in the URL so the scope sentence can swap in the Grok Bot picker.
  const selectInstance = (instanceId: ProviderInstanceId, isGrokBot: boolean) =>
    void navigate({
      to: "/settings/providers",
      search: (previous) => providerSelectionSearch(previous, { instanceId, isGrokBot }),
      replace: true,
      resetScroll: false,
    });
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its providers.`
          : "Connect an environment to set up its providers."}
      </p>
    );
  }
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
      projectIds={
        scope.kind === "project" || scope.kind === "checkout"
          ? scope.members
              .filter((member) => member.environmentId === environment.environmentId)
              .map((member) => member.id)
          : []
      }
      {...(target.botId ? { botId: target.botId } : {})}
      {...(target.provider ? { provider: target.provider } : {})}
      onSelectInstance={selectInstance}
      scoped
    />
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...validateGrokBotSettingsSearch(raw),
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
