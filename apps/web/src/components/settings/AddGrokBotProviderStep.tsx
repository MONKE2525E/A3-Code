import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";

import {
  grokBotsOrchestratorConfigQuery,
  grokBotsOrchestratorSetup,
  grokBotsSetup,
} from "../../state/grokBots";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { grokBotAccountCopy, grokBotCliCopy, grokBotMcpCopy } from "../grokBot/grokBotConnection";
import { grokBotFailureMessage } from "../grokBot/grokBotPresentation";
import { GrokBotSkillSetupPanel } from "../grokBot/GrokBotSkillSetupPanel";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";

type ConnectStage =
  | { readonly kind: "checking" }
  | { readonly kind: "read-error"; readonly message: string }
  | { readonly kind: "install" }
  | { readonly kind: "sign-in" }
  | { readonly kind: "connect"; readonly botCount: number }
  | { readonly kind: "ready"; readonly botCount: number }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "reconnect"; readonly botCount: number }
  | { readonly kind: "endpoint"; readonly message: string; readonly reconnect: boolean };

/** The wizard offers one next action at a time, derived from the bridge and provider state. */
export function stageFromConfig(
  config: NonNullable<ReturnType<typeof useGrokConfig>["data"]> | null,
  readError: string | null = null,
): ConnectStage {
  // A failed refresh keeps the previous data, so a non-null error outranks it.
  if (readError !== null) return { kind: "read-error", message: readError };
  if (config === null) return { kind: "checking" };
  const { nativeAvailable } = config.bridge;
  if (nativeAvailable === false || config.state === "native_account_unavailable") {
    return { kind: "sign-in" };
  }
  // Older servers do not report native sign-in, so they still need the CLI bridge and its session.
  // Otherwise the desktop sign-in drives setup and managed turns, and the bridge is not required.
  if (nativeAvailable === undefined) {
    if (!config.bridge.installed) return { kind: "install" };
    if (!config.bridge.sessionPresent) return { kind: "sign-in" };
  }
  const botCount = config.botIds.length;
  switch (config.state) {
    case "ready":
      return { kind: "ready", botCount };
    case "account_changed":
      return {
        kind: "blocked",
        message:
          "A Grok Bot provider for a different account or team already exists. Remove it from Providers, then add this one.",
      };
    case "blocked": {
      // A disabled provider for this account is re-enabled by the same setup action.
      const disabled = config.provider?.enabled === false;
      if (!config.publicEndpointReadiness.ready) {
        return {
          kind: "endpoint",
          message:
            config.publicEndpointReadiness.reason ??
            "Bots cannot reach this T3 Code server yet. Set up a public connection, then check again.",
          reconnect: disabled,
        };
      }
      if (disabled) return { kind: "reconnect", botCount };
      return {
        kind: "blocked",
        message: "The provider is set up but not ready. Check the connection and try again.",
      };
    }
    default:
      return { kind: "connect", botCount };
  }
}

function useGrokConfig(environmentId: EnvironmentId) {
  return useEnvironmentQuery(grokBotsOrchestratorConfigQuery({ environmentId, input: {} }));
}

/**
 * Grok Bot is account-bound rather than configured, so it replaces the identity and config
 * steps with install, sign-in, and connect, reusing the same RPCs as the Grok Bot editor.
 */
export function AddGrokBotProviderStep({
  environmentId,
  environmentLabel,
  onConnected,
  onOpenConnections,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onConnected: (instanceId: ProviderInstanceId | undefined) => void;
  readonly onOpenConnections: () => void;
}) {
  const config = useGrokConfig(environmentId);
  const canInstall = useAtomValue(grokBotsSetup.permissionAtom(environmentId));
  const canConnect = useAtomValue(grokBotsOrchestratorSetup.permissionAtom(environmentId));
  const install = useAtomCommand(grokBotsSetup, { reportFailure: false });
  const connect = useAtomCommand(grokBotsOrchestratorSetup, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectSnapshot, setConnectSnapshot] = useState<{
    readonly result: NonNullable<typeof config.data>;
    readonly queryData: typeof config.data;
  } | null>(null);

  // Keep the connect payload only until the live query refreshes or errors.
  const setupConfig =
    connectSnapshot !== null && config.error === null && config.data === connectSnapshot.queryData
      ? connectSnapshot.result
      : null;
  const activeConfig = setupConfig ?? config.data;
  const stage = stageFromConfig(activeConfig, config.error);
  const skillSetup = activeConfig?.skillSetup;
  const skillSetupPrompt = skillSetup?.prompt.trim() ? skillSetup.prompt : undefined;

  const run = async (action: "install" | "connect") => {
    setPending(true);
    setError(null);
    const result =
      action === "install"
        ? await install({ environmentId, input: {} })
        : await connect({ environmentId, input: { action: "setup" } });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setError(grokBotFailureMessage(squashAtomCommandFailure(result)));
      return;
    }
    const value = result.value;
    // Ready connect stays open for the one-time shared-skill prompt. Older servers
    // without skillSetup still land on the existing Continue action.
    if (action === "connect" && "state" in value) {
      setConnectSnapshot({ result: value, queryData: config.data });
    }
    config.refresh();
  };

  const copy = describe(stage, environmentLabel);

  return (
    <div className="grid gap-3 pt-4" aria-live="polite">
      <div className="grid gap-1">
        <h3 className="text-sm font-medium text-foreground">{copy.title}</h3>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
      </div>
      {activeConfig ? <GrokBotSetupStatuses config={activeConfig} /> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {(stage.kind === "ready" || stage.kind === "endpoint") &&
      (skillSetupPrompt !== undefined || activeConfig?.setupStatus !== undefined) ? (
        <GrokBotSkillSetupPanel
          environmentId={environmentId}
          prompt={skillSetupPrompt}
          setupStatus={activeConfig?.setupStatus}
          refresh={config.refresh}
          refreshing={config.isPending}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {stage.kind === "install" ? (
          <Button size="sm" disabled={!canInstall || pending} onClick={() => void run("install")}>
            {pending ? <Spinner size="xs" /> : null}
            Install community bridge
          </Button>
        ) : null}
        {stage.kind === "connect" || stage.kind === "reconnect" ? (
          <Button size="sm" disabled={!canConnect || pending} onClick={() => void run("connect")}>
            {pending ? <Spinner size="xs" /> : null}
            {stage.kind === "reconnect" ? "Reconnect Grok Bot" : "Connect Grok Bot"}
          </Button>
        ) : null}
        {stage.kind === "ready" ? (
          <Button size="sm" onClick={() => onConnected(activeConfig?.provider?.instanceId)}>
            {skillSetupPrompt !== undefined ? "Continue" : "Open Grok Bot settings"}
          </Button>
        ) : null}
        {stage.kind === "endpoint" ? (
          <>
            <Button size="sm" onClick={onOpenConnections}>
              Open Settings → Connections
            </Button>
            {stage.reconnect ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={!canConnect || pending}
                onClick={() => void run("connect")}
              >
                {pending ? <Spinner size="xs" /> : null}
                Reconnect Grok Bot
              </Button>
            ) : null}
          </>
        ) : null}
        {stage.kind !== "checking" && stage.kind !== "ready" ? (
          <Button
            size="sm"
            variant={stage.kind === "sign-in" ? "default" : "ghost-muted"}
            disabled={pending}
            onClick={() => config.refresh()}
          >
            <RefreshIcon refreshing={config.isPending} />
            {stage.kind === "sign-in" ? "I signed in, check again" : "Check again"}
          </Button>
        ) : null}
        {(stage.kind === "install" && !canInstall) ||
        ((stage.kind === "connect" || stage.kind === "reconnect") && !canConnect) ? (
          <span className="text-xs text-muted-foreground">Needs settings write access.</span>
        ) : null}
      </div>
    </div>
  );
}

function GrokBotSetupStatuses({
  config,
}: {
  readonly config: NonNullable<ReturnType<typeof useGrokConfig>["data"]>;
}) {
  const { bridge } = config;
  // Servers without `nativeAvailable` only report the CLI session, so fall back to it.
  const nativeSignedIn = bridge.nativeAvailable ?? bridge.sessionPresent;
  const items = [
    {
      ...grokBotCliCopy(bridge),
      status: bridge.installed
        ? "Ready"
        : bridge.nativeAvailable !== undefined
          ? "Optional"
          : "Needs attention",
    },
    {
      ...grokBotAccountCopy({ sessionPresent: nativeSignedIn }),
      status: nativeSignedIn ? "Ready" : "Needs attention",
    },
    {
      ...grokBotMcpCopy(config.publicEndpointReadiness),
      status: config.publicEndpointReadiness.ready ? "Ready" : "Needs attention",
    },
  ];
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.title}>
          <span className="font-medium text-foreground/80">{item.title}</span>
          {" · "}
          {item.status}
        </li>
      ))}
    </ul>
  );
}

function describe(stage: ConnectStage, environmentLabel: string) {
  switch (stage.kind) {
    case "checking":
      return {
        title: "Checking Grok Bot",
        description: `Looking for the Grok Bot app on ${environmentLabel}.`,
      };
    case "install":
      return {
        title: "Install the Grok Bot bridge",
        description: `Install the community bridge on ${environmentLabel}. It uses the Grok Bot desktop app's sign-in on that computer.`,
      };
    case "sign-in":
      return {
        title: "Sign in to Grok Bot",
        description: `Open the Grok Bot app on ${environmentLabel} and sign in. T3 Code uses that desktop sign-in, so there is no API key to paste.`,
      };
    case "connect":
      return {
        title: stage.botCount === 1 ? "1 bot found" : `${stage.botCount} bots found`,
        description:
          "Connect your Grok Bot account to import them. They appear in the sidebar, and nothing is sent to them yet.",
      };
    case "ready":
      return {
        title: "Grok Bot is connected",
        description:
          stage.botCount === 1
            ? "Your bot is in the sidebar."
            : `Your ${stage.botCount} bots are in the sidebar.`,
      };
    case "reconnect":
      return {
        title: "Grok Bot is turned off",
        description: `The provider for this account is disabled on ${environmentLabel}. Reconnect to turn it back on.`,
      };
    case "read-error":
      return {
        title: "Could not read Grok Bot",
        description: `${stage.message} Check that ${environmentLabel} is reachable, then check again.`,
      };
    case "endpoint":
      return {
        title: "Bots can't reach this server yet",
        description: `${stage.message} Pair or expose ${environmentLabel} under Settings → Connections.`,
      };
    case "blocked":
      return { title: "Grok Bot needs attention", description: stage.message };
  }
}
