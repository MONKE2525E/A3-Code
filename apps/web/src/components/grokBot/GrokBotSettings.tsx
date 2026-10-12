import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { RedactedSensitiveText } from "~/components/settings/RedactedSensitiveText";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import {
  grokBotsListQuery,
  grokBotsOrchestratorConfigQuery,
  grokBotsOrchestratorSetup,
  grokBotsSetup,
  grokBotsStatusQuery,
} from "~/state/grokBots";
import { grokBotComputerUpgradeScheduleQuery } from "~/state/grokBotComputer";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  GrokBotComputerMaintenance,
  describeComputerUpgradeSchedule,
} from "./GrokBotComputerMaintenance";
import { GrokBotCreateDraft } from "./GrokBotCreateDraft";
import { GrokBotLimitations } from "./GrokBotLimitations";
import { GrokBotProfileEditor } from "./GrokBotProfileEditor";
import { GrokBotSkillSetupPanel } from "./GrokBotSkillSetupPanel";
import {
  grokBotAccountCopy,
  grokBotCliCopy,
  grokBotMcpCopy,
  grokBotNativeReady,
  grokBotNativeSignedIn,
  grokBotProviderAuthFields,
  grokBotSkillCopy,
} from "./grokBotConnection";
import {
  grokBotFailureMessage,
  grokBotSurfaceKey,
  sortGrokBotsForEditor,
} from "./grokBotPresentation";

/** The bot editor inside the Providers page, for one environment. */
export function GrokBotProviderEditor({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId?: string | undefined;
}) {
  return <GrokBotSettingsBody environmentId={environmentId} selectedBotId={botId} />;
}

function GrokBotSettingsBody({
  environmentId,
  selectedBotId,
}: {
  readonly environmentId: EnvironmentId;
  readonly selectedBotId?: string | undefined;
}) {
  const status = useEnvironmentQuery(grokBotsStatusQuery({ environmentId, input: {} }));
  // Roster and computer are native reads, so the desktop sign-in is enough without the CLI.
  const nativeReady = grokBotNativeReady(status.data);
  const roster = useEnvironmentQuery(
    nativeReady ? grokBotsListQuery({ environmentId, input: {} }) : null,
  );
  const computerSchedule = useEnvironmentQuery(
    nativeReady ? grokBotComputerUpgradeScheduleQuery({ environmentId, input: {} }) : null,
  );
  const canSetup = useAtomValue(grokBotsSetup.permissionAtom(environmentId));
  const setup = useAtomCommand(grokBotsSetup, { reportFailure: false });
  const [setupPending, setSetupPending] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const canConfigureProvider = useAtomValue(
    grokBotsOrchestratorSetup.permissionAtom(environmentId),
  );
  const providerConfig = useEnvironmentQuery(
    grokBotsOrchestratorConfigQuery({ environmentId, input: {} }),
  );
  const setupProvider = useAtomCommand(grokBotsOrchestratorSetup, { reportFailure: false });
  const [providerPending, setProviderPending] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const bots = useMemo(() => sortGrokBotsForEditor(roster.data ?? []), [roster.data]);
  const [drafting, setDrafting] = useState(false);
  // Creating a bot goes through the gateway CLI, so it keeps the CLI check.
  const canStartDraft = status.data?.installed === true && status.data.sessionPresent === true;
  const selected = bots.find((bot) => bot.id === selectedBotId) ?? bots[0] ?? null;
  const skillSetup = providerConfig.data?.skillSetup;
  const skillSetupPrompt = skillSetup?.prompt.trim() ? skillSetup.prompt : undefined;
  const bridge = providerConfig.data?.bridge ?? status.data;
  const auth = grokBotProviderAuthFields(providerConfig.data?.provider?.auth);
  const cli = grokBotCliCopy(bridge);
  const nativeSignedIn = grokBotNativeSignedIn(bridge);
  const account = grokBotAccountCopy({
    sessionPresent: nativeSignedIn,
    email: auth.email,
    plan: auth.plan,
  });
  const mcp = grokBotMcpCopy(providerConfig.data?.publicEndpointReadiness);
  const skill = grokBotSkillCopy(skillSetupPrompt !== undefined);

  const refreshAll = () => {
    status.refresh();
    roster.refresh();
    providerConfig.refresh();
  };

  const runProviderSetup = async () => {
    setProviderPending(true);
    setProviderError(null);
    const result = await setupProvider({ environmentId, input: { action: "setup" } });
    setProviderPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setProviderError(grokBotFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const runSetup = async () => {
    setSetupPending(true);
    setSetupError(null);
    const result = await setup({ environmentId, input: {} });
    setSetupPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setSetupError(grokBotFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSection
        {...searchableSetting("grok-bots-bridge")}
        headerAction={
          <Button size="xs" variant="ghost-muted" onClick={refreshAll}>
            <RefreshIcon refreshing={status.isPending || roster.isPending} />
            Refresh
          </Button>
        }
      >
        <SettingsRow
          title={cli.title}
          description={
            status.isPending && status.data === null && status.error === null
              ? "Checking the Grok Bot bridge."
              : cli.description
          }
          control={
            bridge?.installed === true ? (
              <span className="text-xs text-muted-foreground">Installed</span>
            ) : (
              <Button
                size="sm"
                variant={nativeReady ? "outline" : "default"}
                disabled={!canSetup || setupPending}
                onClick={() => void runSetup()}
              >
                {setupPending ? <Spinner size="xs" /> : null}
                {nativeReady ? "Set up CLI bridge" : "Set up Grok Bot"}
              </Button>
            )
          }
        />
        <SettingsRow
          title={account.title}
          description={
            nativeSignedIn && auth.email ? (
              <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1">
                <RedactedSensitiveText
                  value={auth.email}
                  ariaLabel="Toggle account email visibility"
                  revealTooltip="Click to reveal email"
                  hideTooltip="Click to hide email"
                  className="max-w-full truncate"
                />
                {auth.plan ? <span>· {auth.plan}</span> : null}
              </span>
            ) : (
              account.description
            )
          }
          control={
            nativeSignedIn ? (
              <span className="text-xs text-muted-foreground">Signed in</span>
            ) : (
              <Button size="sm" variant="outline" onClick={refreshAll}>
                <RefreshCwIcon />
                Check again
              </Button>
            )
          }
        />
        {setupError ? (
          <SettingsRow title="Setup could not finish" description={setupError} />
        ) : null}
        {status.error ? (
          <SettingsRow
            title="Could not read the connection"
            description={status.error}
            control={
              <Button size="sm" variant="outline" onClick={refreshAll}>
                <RefreshCwIcon />
                Retry
              </Button>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Native provider">
        {providerConfig.error ? (
          <SettingsRow
            title="Could not read the provider"
            description={providerConfig.error}
            control={
              <Button size="sm" variant="outline" onClick={() => providerConfig.refresh()}>
                <RefreshCwIcon />
                Retry
              </Button>
            }
          />
        ) : providerConfig.data === null ? (
          <SettingsRow
            title="Checking the provider"
            description="Reading the native Grok Bot provider."
          />
        ) : (
          <>
            <SettingsRow
              title="Provider"
              description={providerCopy(providerConfig.data.state)}
              control={
                providerConfig.data.state === "not_configured" ||
                providerConfig.data.state === "blocked" ? (
                  canConfigureProvider ? (
                    <Button
                      size="sm"
                      disabled={providerPending}
                      onClick={() => void runProviderSetup()}
                    >
                      {providerPending ? <Spinner size="xs" /> : null}
                      {providerConfig.data.state === "blocked"
                        ? "Retry provider setup"
                        : "Set up provider"}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Needs settings write access
                    </span>
                  )
                ) : providerConfig.data.state === "ready" ? (
                  <span className="text-xs text-muted-foreground">Ready</span>
                ) : providerConfig.data.state === "native_account_unavailable" ||
                  providerConfig.data.state === "account_changed" ? (
                  <Button size="sm" variant="outline" onClick={refreshAll}>
                    <RefreshCwIcon />
                    Check again
                  </Button>
                ) : null
              }
            />
            <SettingsRow
              title={mcp.title}
              description={mcp.description}
              control={
                providerConfig.data.publicEndpointReadiness.ready ? (
                  <span className="text-xs text-muted-foreground">Ready</span>
                ) : (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      render={
                        <Link to="/settings/connections" search={{ machine: environmentId }} />
                      }
                    >
                      Open Connections
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost-muted"
                      onClick={() => providerConfig.refresh()}
                    >
                      <RefreshIcon refreshing={providerConfig.isPending} />
                      Check again
                    </Button>
                  </div>
                )
              }
            />
            {providerError ? (
              <SettingsRow title="Provider setup could not finish" description={providerError} />
            ) : null}
            {skillSetupPrompt !== undefined || providerConfig.data.setupStatus !== undefined ? (
              <SettingsRow title={skill.title}>
                <div className="pt-2">
                  <GrokBotSkillSetupPanel
                    environmentId={environmentId}
                    prompt={skillSetupPrompt}
                    setupStatus={providerConfig.data.setupStatus}
                    refresh={providerConfig.refresh}
                    refreshing={providerConfig.isPending}
                  />
                </div>
              </SettingsRow>
            ) : null}
          </>
        )}
      </SettingsSection>

      {nativeReady ? (
        <SettingsSection {...searchableSetting("grok-bots-computer")} title="Computer">
          <SettingsRow
            title="Cloud computer"
            description="Update or reset the Grok Bot computer for your whole account."
            control={<GrokBotComputerMaintenance environmentId={environmentId} />}
          />
          <SettingsRow
            title="Scheduled upgrade"
            description={
              computerSchedule.error
                ? "Could not read the upgrade schedule."
                : computerSchedule.data === null
                  ? "Checking the upgrade schedule."
                  : describeComputerUpgradeSchedule(computerSchedule.data.schedule)
            }
          />
          <SettingsRow
            title="Grok Bot desktop app"
            description="T3 Code cannot update the Grok Bot desktop app. Update it in the Grok Bot app."
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        {...searchableSetting("grok-bots-editor")}
        headerAction={
          canStartDraft && !drafting ? (
            <Button size="xs" variant="ghost-muted" onClick={() => setDrafting(true)}>
              New bot
            </Button>
          ) : null
        }
      >
        {drafting && canStartDraft ? (
          <div className="px-3 py-4 sm:px-4">
            <GrokBotCreateDraft environmentId={environmentId} onCancel={() => setDrafting(false)} />
          </div>
        ) : !nativeReady && status.data?.installed !== true ? (
          <SettingsRow
            title="Bots"
            description="Set up the connection first. T3 Code lists bots from your Grok Bot account and does not add sample bots."
          />
        ) : !nativeReady ? (
          <SettingsRow
            title="Bots"
            description="Sign in to Grok Bot, then refresh to load your bots."
          />
        ) : roster.error ? (
          <SettingsRow title="Could not load bots" description={roster.error} />
        ) : roster.isPending && roster.data === null ? (
          <SettingsRow title="Loading bots" description="Reading your Grok Bot account." />
        ) : bots.length === 0 ? (
          <SettingsRow
            title="No bots yet"
            description="Create bots in Grok Bot. They will show up here after you refresh."
          />
        ) : (
          <>
            {selected ? (
              <div className="px-3 py-4 sm:px-4">
                <GrokBotProfileEditor
                  key={grokBotSurfaceKey(environmentId, selected.id)}
                  environmentId={environmentId}
                  bot={selected}
                />
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>
      <SettingsSection title="Limits">
        <div className="px-3 py-3 sm:px-4">
          <GrokBotLimitations />
        </div>
      </SettingsSection>
    </div>
  );
}

function providerCopy(
  state: "not_configured" | "ready" | "blocked" | "account_changed" | "native_account_unavailable",
): string {
  switch (state) {
    case "not_configured":
      return "Add the signed-in Grok Bot account as a T3 provider. Setup creates no threads.";
    case "ready":
      return "The Grok Bot account is set up as a provider. Its bots appear in the sidebar.";
    case "blocked":
      return "The provider is set up but not ready yet. Check the public endpoint and sign-in below.";
    case "account_changed":
      return "This provider belongs to a different account or team. Restore that selection or remove the old provider in Settings before setting up another.";
    case "native_account_unavailable":
      return "Sign in to the native Grok Bot app before setting up its T3 provider.";
  }
}
