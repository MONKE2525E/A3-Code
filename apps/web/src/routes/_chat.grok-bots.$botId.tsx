import { createFileRoute } from "@tanstack/react-router";

import {
  resolveGrokBotSelectedEnvironment,
  validateGrokBotConversationSearch,
} from "../components/grokBot/grokBotPresentation";
import { GrokBotConversationView } from "../components/grokBot/GrokBotConversationView";
import { GrokBotNativeEntry } from "../components/grokBot/GrokBotNativeEntry";
import { useSelectedGrokBotEnvironmentId } from "../components/grokBot/useGrokBotEnvironment";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { useConnectedEnvironmentIds } from "../state/environments";

function GrokBotConversationRoute() {
  const { botId } = Route.useParams();
  const { view } = Route.useSearch();
  const selectedEnvironmentId = useSelectedGrokBotEnvironmentId();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const resolved = resolveGrokBotSelectedEnvironment({
    selectedEnvironmentId,
    connectedEnvironmentIds,
  });
  if (resolved.kind === "no-environment") {
    return (
      <Empty size="hero">
        <EmptyHeader>
          <EmptyTitle>Choose an environment</EmptyTitle>
          <EmptyDescription>Connect an environment to open this Grok Bot chat.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (view === "history" && resolved.kind === "environment") {
    return (
      <GrokBotConversationView environmentId={resolved.environmentId} botId={botId} readOnly />
    );
  }
  // Keyed by environment and bot so a previous bot's or environment's open request or failure never carries over.
  // A disconnected selected environment still reaches the cached lookup; the entry asks to reconnect only when none resolves.
  return (
    <GrokBotNativeEntry
      key={`${resolved.environmentId}:${botId}`}
      environmentId={resolved.environmentId}
      botId={botId}
      connected={resolved.kind === "environment"}
    />
  );
}

export const Route = createFileRoute("/_chat/grok-bots/$botId")({
  validateSearch: validateGrokBotConversationSearch,
  component: GrokBotConversationRoute,
});
