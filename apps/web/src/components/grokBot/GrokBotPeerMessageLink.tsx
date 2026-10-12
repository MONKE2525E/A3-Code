import type {
  EnvironmentId,
  OrchestrationV2ConversationMessage,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { grokBotsListQuery } from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";
import { useThreadShells } from "~/state/entities";

import { GrokBotAvatar } from "./GrokBotAvatar";
import { grokBotIdForSenderThread } from "./grokBotSenderThread";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** The bot entry route resolves the peer's canonical conversation in this environment. */
export function GrokBotPeerMessageLink({
  environmentId,
  peer,
}: {
  readonly environmentId: EnvironmentId;
  readonly peer: NonNullable<OrchestrationV2ConversationMessage["grokBotPeer"]>;
}) {
  const roster = useEnvironmentQuery(grokBotsListQuery({ environmentId, input: {} }));
  const bot = roster.data?.find((candidate) => candidate.id === peer.botId);
  const name = bot?.name ?? peer.name;
  // Native bot recipients can be tagged as agents; the roster identifies routable bots.
  const isBot = bot !== undefined || (peer.kind !== "agent" && peer.kind !== "cloud-agent");
  if (!isBot) {
    return (
      <p className="mb-1 text-xs text-muted-foreground">
        {peer.direction === "from" ? "Message from " : "Messaged "}
        {name}
      </p>
    );
  }
  const link = (
    <Link
      to="/grok-bots/$botId"
      params={{ botId: peer.botId }}
      search={{ environmentId }}
      className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {name}
    </Link>
  );
  if (peer.direction === "to") {
    return <p className="mb-1 text-xs text-muted-foreground">Messaged {link}</p>;
  }
  // A bot sender shows only its mark. The name is the tooltip and the link's accessible name.
  // The roster may still be loading, so the mark falls back to the id-derived default look.
  return (
    <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
      Sent by
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/grok-bots/$botId"
              params={{ botId: peer.botId }}
              search={{ environmentId }}
              aria-label={`Open ${name}`}
              className="inline-flex min-w-0 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
            />
          }
        >
          <GrokBotAvatar
            bot={bot ?? { id: peer.botId, name, avatarShape: "", avatarColor: "" }}
            size="xs"
            environmentId={environmentId}
          />
        </TooltipTrigger>
        <TooltipPopup>Open {name}</TooltipPopup>
      </Tooltip>
    </p>
  );
}

/**
 * A generic agent message whose sender is a canonical bot thread shows that bot, the same as a
 * peer message. Any other sender keeps the caller's fallback line.
 */
export function AgentSenderAttribution({
  environmentId,
  senderThreadId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId: ThreadId | undefined;
  readonly children: ReactNode;
}) {
  // Subscribes only for agent-attributed rows, so ordinary user messages do not re-render on shell updates.
  const shells = useThreadShells();
  const botId = senderThreadId
    ? grokBotIdForSenderThread(shells, { environmentId, threadId: senderThreadId })
    : null;
  if (botId === null) return children;
  return (
    <GrokBotPeerMessageLink
      environmentId={environmentId}
      peer={{ botId, name: "Grok Bot", direction: "from", kind: "bot" }}
    />
  );
}
