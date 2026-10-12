import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState } from "react";

import { grokBotsListQuery, grokBotsOpenThread } from "../../state/grokBots";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { GrokBotEntryLoading } from "./GrokBotEntryLoading";
import { grokBotEntryPhase } from "./grokBotEntryPhase";
import { cachedGrokBotNativeInstanceId } from "./grokBotCachedThread";
import { grokBotNativeInstanceId } from "./grokBotNativeThread";
import { grokBotSettingsDestinationSearch } from "./grokBotPresentation";
import {
  useCachedGrokBotNativeThread,
  useGrokBotNativeActions,
  useGrokBotNativeReadiness,
} from "./useGrokBotNative";

/**
 * Bot chats are ordinary native threads. A cached thread opens at once and the thread's
 * own sync refreshes it; otherwise this route asks the server for the bot's thread.
 * No legacy conversation is read or sent.
 */
export function GrokBotNativeEntry({
  environmentId,
  botId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  /** False while the selected environment is offline; cached threads still open, nothing else can. */
  readonly connected: boolean;
}) {
  const navigate = useNavigate();
  const readiness = useGrokBotNativeReadiness(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  // Opening needs the bound provider only; sending readiness does not gate it. A fresh config that
  // rejects the account clears the binding, which cancels any open still in flight.
  const openInstanceId =
    grokBotNativeInstanceId(readiness) === null
      ? null
      : cachedGrokBotNativeInstanceId(config, readiness);
  // The hook already suppresses a stale cache when the account changed or the bridge is unavailable.
  const cachedThreadId = useCachedGrokBotNativeThread(environmentId, botId, readiness);
  const canOpen = useAtomValue(grokBotsOpenThread.permissionAtom(environmentId));
  const roster = useEnvironmentQuery(
    connected && openInstanceId !== null && cachedThreadId === null
      ? grokBotsListQuery({ environmentId, input: {} })
      : null,
  );
  const bot = roster.data?.find((entry) => entry.id === botId) ?? null;
  // A boolean keeps roster refreshes from re-running the open; the bot object changes on each refresh.
  const botFound = bot !== null;
  const { openBot } = useGrokBotNativeActions(environmentId);
  const [openFailure, setOpenFailure] = useState<string | null>(null);

  // Layout timing redirects before paint, and the cached branch renders nothing, so no loading screen flashes.
  useLayoutEffect(() => {
    if (cachedThreadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, cachedThreadId)),
      replace: true,
    });
  }, [cachedThreadId, environmentId, navigate]);

  useEffect(() => {
    // A cached thread opens without asking the server; a failure holds the open until "Try again" clears it, which re-runs this effect.
    if (
      cachedThreadId !== null ||
      !connected ||
      openInstanceId === null ||
      !botFound ||
      !canOpen ||
      openFailure !== null
    )
      return;
    let active = true;
    openBot(botId).then(
      (threadId) => {
        if (!active) return;
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
          replace: true,
        });
      },
      (error: unknown) => {
        if (active) setOpenFailure(error instanceof Error ? error.message : "An error occurred.");
      },
    );
    return () => {
      active = false;
    };
  }, [
    botFound,
    botId,
    cachedThreadId,
    connected,
    canOpen,
    environmentId,
    navigate,
    openBot,
    openInstanceId,
    openFailure,
  ]);

  if (cachedThreadId !== null) {
    // The thread's own sync shows "Syncing messages..." in its composer while cached messages stay visible.
    return null;
  }
  if (!connected) {
    return (
      <GrokBotEntryMessage
        title="Reconnect this environment"
        description="This Grok Bot chat stays with the selected environment. Reconnect it or choose a connected one."
        actionLabel="Open settings"
        onAction={() =>
          void navigate({
            to: "/settings/providers",
            search: grokBotSettingsDestinationSearch({ environmentId, botId }),
            hash: "grok-bots-bridge",
          })
        }
      />
    );
  }
  if (readiness.kind === "pending") {
    return <GrokBotEntryLoading phase="connecting" bot={null} />;
  }
  if (readiness.kind === "ready" || readiness.kind === "blocked") {
    if (!canOpen) {
      return (
        <GrokBotEntryMessage
          title="Grok Bot is unavailable"
          description="Your access to this environment does not allow opening bot threads."
        />
      );
    }
    if (roster.error) {
      return <GrokBotEntryMessage title="Could not load bots" description={roster.error} />;
    }
    if (roster.data && bot === null) {
      return <GrokBotEntryMessage title="Bot not found" description="It may have been removed." />;
    }
    if (openFailure !== null) {
      return (
        <GrokBotEntryMessage
          title="Could not open the Grok Bot thread"
          description={openFailure}
          actionLabel="Try again"
          onAction={() => setOpenFailure(null)}
        />
      );
    }
    return (
      <GrokBotEntryLoading phase={grokBotEntryPhase({ readinessPending: false, bot })} bot={bot} />
    );
  }
  return (
    <GrokBotEntryMessage
      title={readiness.kind === "denied" ? "Grok Bot is unavailable" : "Set up Grok Bot"}
      description={readiness.message}
      actionLabel="Open settings"
      onAction={() =>
        void navigate({
          to: "/settings/providers",
          search: grokBotSettingsDestinationSearch({ environmentId, botId }),
          hash: "grok-bots-bridge",
        })
      }
    />
  );
}

function GrokBotEntryMessage({
  title,
  description,
  actionLabel,
  onAction,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <Empty size="hero">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {actionLabel && onAction ? (
        <Button size="sm" variant="outline" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </Empty>
  );
}
