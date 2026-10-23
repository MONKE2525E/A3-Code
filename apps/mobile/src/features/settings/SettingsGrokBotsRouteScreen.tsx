import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { GrokBot } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { grokBotsList, grokBotsOpenThread } from "../../state/grok-bots";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsGrokBotsRouteScreen() {
  const { environments, isReady } = useEnvironments();
  return (
    <SettingsScreen title="Grok bots">
      <ScreenScrollView contentContainerClassName="gap-5 px-5 py-4">
        <AppText className="text-foreground-muted">
          Open a bot on your connected computer to continue its conversation. T3 Connect works away
          from home.
        </AppText>
        {environments.length === 0 ? (
          <AppText>
            {isReady
              ? "Connect your computer in Settings → Environments to see its bots."
              : "Loading environments…"}
          </AppText>
        ) : (
          environments.map((environment) => (
            <EnvironmentBots key={environment.environmentId} environment={environment} />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentBots({ environment }: { readonly environment: EnvironmentPresentation }) {
  const { environmentId } = environment;
  const focused = useIsFocused();
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  // Official servers do not implement the fork's bot RPCs. Ordinary computer access still works.
  const supportsBots = providers?.some((provider) => provider.driver === "grok-bot") === true;
  const connected = environment.connection.phase === "connected";
  const bots = useEnvironmentQuery(
    focused && connected && supportsBots ? grokBotsList({ environmentId, input: {} }) : null,
  );
  const canOpen = useAtomValue(grokBotsOpenThread.permissionAtom(environmentId));
  const openThread = useAtomCommand(grokBotsOpenThread, { reportFailure: false });
  const selectWorkspace = useAndroidWorkspaceSelection();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const open = async (bot: GrokBot) => {
    if (pending.current || !canOpen || !connected) return;
    pending.current = true;
    setOpening(bot.id);
    setError(null);
    try {
      const result = await openThread({ environmentId, input: { botId: bot.id } });
      if (result._tag === "Success") {
        selectWorkspace({
          name: "Thread",
          params: { environmentId, threadId: result.value.threadId },
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not open this bot.");
      }
    } finally {
      pending.current = false;
      setOpening(null);
    }
  };
  const visibleBots = bots.data?.filter((bot) => !bot.hidden);
  return (
    <SettingsSection
      title={environment.label}
      footer={
        supportsBots && !canOpen
          ? "This connection needs permission to operate threads before it can open a bot."
          : undefined
      }
    >
      {!connected ? (
        <StatusText>Connect this environment to load its bots.</StatusText>
      ) : providers === null ? (
        <StatusText>Loading providers…</StatusText>
      ) : !supportsBots ? (
        <StatusText>
          Grok bots are available on computers running T3 Code GrokBot with the Grok Bot provider
          enabled. You can still use this computer's other threads.
        </StatusText>
      ) : bots.error ? (
        <View className="gap-3 p-4">
          <AppText accessibilityRole="alert">{bots.error}</AppText>
          <Button label="Try again" onPress={bots.refresh} />
        </View>
      ) : visibleBots === undefined ? (
        <StatusText>Loading bots…</StatusText>
      ) : visibleBots.length === 0 ? (
        <StatusText>No visible bots. Create or unhide a bot on your computer.</StatusText>
      ) : (
        visibleBots.map((bot) => (
          <ListRow
            key={bot.id}
            label={bot.label || bot.name}
            description={bot.description || undefined}
            detail={opening === bot.id ? "Opening…" : undefined}
            disabled={!canOpen || opening !== null}
            onPress={() => void open(bot)}
          />
        ))
      )}
      {supportsBots && connected && bots.data ? (
        <View className="px-4 py-3">
          <Button
            label="Refresh bots"
            tone="text"
            disabled={bots.isPending}
            onPress={bots.refresh}
          />
        </View>
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" className="px-4 py-3 text-danger-foreground">
          {error}
        </AppText>
      ) : null}
    </SettingsSection>
  );
}

function StatusText({ children }: { readonly children: string }) {
  return <AppText className="px-4 py-4 text-foreground-muted">{children}</AppText>;
}
