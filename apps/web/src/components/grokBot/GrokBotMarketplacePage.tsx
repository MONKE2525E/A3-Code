import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  enabledAgentMarketplaces,
  selectedAgentMarketplace,
  type AgentMarketplace,
} from "../agents/nativeAgentAvailability";
import { museAgentStatusQuery, museAgentFeatureUpdate, refreshMuseAgent } from "~/state/museAgent";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { MuseAgentConnectionsSection } from "../agents/MuseAgentConnectionsSection";
import { MuseAgentSkillsSection } from "../agents/MuseAgentFeaturesDialog";
import { AddMuseAgentProviderStep } from "../agents/AddMuseAgentProviderStep";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { grokBotsStatusQuery } from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";

import { GrokBotMarketplaceBrowse } from "./GrokBotMarketplaceBrowse";
import { GrokBotPluginAuthCallback } from "./GrokBotPluginAuthCallback";
import { grokBotNativeReady } from "./grokBotConnection";
import { GROK_BOT_PROVIDER_INTENT } from "./grokBotPresentation";

/** The Marketplace settings tab: browse public Grok Bot templates and import one as a new bot. */
export function GrokBotMarketplacePage() {
  const { environment, scope } = useSettingsScope();
  return (
    <SettingsPageContainer showScope={false}>
      <GrokBotPluginAuthCallback />
      {environment ? (
        <MarketplaceBody environmentId={environment.environmentId} />
      ) : (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          {scope.kind === "environment"
            ? `Reconnect ${scope.label} to browse its marketplace.`
            : "Connect an environment to browse the marketplace."}
        </p>
      )}
    </SettingsPageContainer>
  );
}

function MarketplaceBody({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const available = enabledAgentMarketplaces(settings.providerInstances);
  const [requested, setRequested] = useState<AgentMarketplace | null>(null);
  const selected = selectedAgentMarketplace(available, requested);
  if (selected === null)
    return (
      <p className="px-4 text-sm text-muted-foreground">
        Add Muse or Grok Bot in Providers to use the marketplace.
      </p>
    );
  return (
    <div className="grid gap-4">
      {available.length > 1 ? (
        <div role="group" aria-label="Marketplace provider" className="flex gap-1 px-4">
          {available.map((provider) => (
            <Button
              key={provider}
              size="sm"
              variant={selected === provider ? "secondary" : "ghost"}
              aria-pressed={selected === provider}
              onClick={() => setRequested(provider)}
            >
              {provider === "muse-agent" ? "Muse" : "Grok Bots"}
            </Button>
          ))}
        </div>
      ) : null}
      {selected === "muse-agent" ? (
        <MuseMarketplace key={environmentId} environmentId={environmentId} />
      ) : (
        <GrokMarketplace key={environmentId} environmentId={environmentId} />
      )}
    </div>
  );
}

function MuseMarketplace({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const status = useEnvironmentQuery(museAgentStatusQuery({ environmentId, input: {} }));
  const canWrite = useAtomValue(museAgentFeatureUpdate.permissionAtom(environmentId));
  const provider = status.data?.ready ? status.data.provider : null;
  return (
    <SettingsSection title="Muse marketplace">
      <div className="grid gap-6 px-4 py-4">
        {provider ? (
          <>
            <section className="grid gap-3">
              <h3 className="text-base font-semibold">Connections</h3>
              <MuseAgentConnectionsSection
                environmentId={environmentId}
                providerInstanceId={provider.instanceId}
                canWrite={canWrite}
              />
            </section>
            <section className="grid gap-3">
              <h3 className="text-base font-semibold">Skills</h3>
              <MuseAgentSkillsSection
                environmentId={environmentId}
                providerInstanceId={provider.instanceId}
              />
            </section>
          </>
        ) : (
          <AddMuseAgentProviderStep
            environmentId={environmentId}
            environmentLabel="this environment"
            onConnected={() => refreshMuseAgent(appAtomRegistry, environmentId)}
          />
        )}
      </div>
    </SettingsSection>
  );
}

function GrokMarketplace({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const status = useEnvironmentQuery(grokBotsStatusQuery({ environmentId, input: {} }));
  const ready = grokBotNativeReady(status.data);
  return (
    <SettingsSection {...searchableSetting("grok-bots-marketplace")}>
      <div className="px-3 py-4 sm:px-4">
        {ready ? (
          <GrokBotMarketplaceBrowse key={environmentId} environmentId={environmentId} />
        ) : status.data === null && status.error === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="xs" />
            Checking the Grok Bot connection
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              {status.error ?? "Set up and sign in to Grok Bot to browse templates."}
            </span>
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/settings/providers"
                  search={{ provider: GROK_BOT_PROVIDER_INTENT, machine: environmentId }}
                />
              }
            >
              Open Grok Bot settings
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
