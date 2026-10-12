import type { EnvironmentId, GrokBot } from "@t3tools/contracts";

import { grokBotsListQuery } from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";

import { WorkspaceBreadcrumbText } from "../WorkspaceBreadcrumb";
import { GrokBotAvatar } from "./GrokBotAvatar";
import { useGrokBotActivity } from "./grokBotActivity";
import { grokBotSurfaceKey } from "./grokBotPresentation";

/**
 * The header title of a canonical bot thread: the bot's avatar and current name, shown where
 * the project would be. Falls back to the thread title until the roster loads.
 */
export function GrokBotThreadHeading(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: GrokBot["id"];
  readonly fallbackTitle: string;
}) {
  const roster = useEnvironmentQuery(
    grokBotsListQuery({ environmentId: props.environmentId, input: {} }),
  ).data;
  const bot = roster?.find((entry) => entry.id === props.botId) ?? null;
  const activity = useGrokBotActivity(grokBotSurfaceKey(props.environmentId, props.botId));
  return (
    <span className="flex min-w-0 items-center gap-2">
      {bot ? (
        <GrokBotAvatar
          bot={bot}
          size="sm"
          environmentId={props.environmentId}
          featured={bot.featured}
          state={activity}
          restingPose="upright"
        />
      ) : null}
      <WorkspaceBreadcrumbText>{bot?.name ?? props.fallbackTitle}</WorkspaceBreadcrumbText>
    </span>
  );
}
