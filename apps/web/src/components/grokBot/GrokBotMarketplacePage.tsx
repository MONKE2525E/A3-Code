import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

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
