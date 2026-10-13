import type { EnvironmentId, GrokBotConnectorCard } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { WorkLogRow } from "../chat/WorkLog";
import { GrokBotConnectorIcon } from "./GrokBotConnectorIcon";
import { GrokBotSetupAuthorize } from "./GrokBotSetupAuthorize";

/**
 * A connector the bot asked the user to sign in to. Connecting runs the same protected flow as the
 * plugin's account list, so the user never leaves the conversation to approve it. `settled` is set
 * when the transcript already holds the bot's confirmation.
 */
export function GrokBotConnectorCardView({
  environmentId,
  card,
  settled,
}: {
  readonly environmentId: EnvironmentId;
  readonly card: GrokBotConnectorCard;
  readonly settled: boolean;
}) {
  const [connected, setConnected] = useState(false);
  if (card.variant === "connected" || settled || connected) {
    return (
      <WorkLogRow
        data-grokbot-connector-card="connected"
        icon={<CheckIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={`${card.connector} connected`}
      />
    );
  }
  return (
    <section
      data-grokbot-connector-card="connect"
      aria-label={`Connect ${card.connector}`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <GrokBotConnectorIcon logoUrl={null} />
          <span className="min-w-0 truncate">{card.connector}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          Your bot needs you to approve this connector before it can use it.
        </p>
      </div>
      <GrokBotSetupAuthorize
        environmentId={environmentId}
        serverId={card.serverId}
        label={`Connect ${card.connector}`}
        watchesCompletion
        refresh={() => setConnected(true)}
      />
    </section>
  );
}
