import type { EnvironmentId } from "@t3tools/contracts";

import type { GrokBotActivity } from "./grokBotActivity";
import type { PinnedGrokBotVoiceCall } from "./useGrokBotVoiceCall";

export type GrokBotAvatarActivity = GrokBotActivity | "listening";

/** A call only animates its own bot in its original environment, until it ends. */
export function resolveGrokBotVoiceCallActivity({
  call,
  environmentId,
  botId,
  activity,
}: {
  readonly call: PinnedGrokBotVoiceCall | null;
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
  readonly activity: GrokBotAvatarActivity | undefined;
}): GrokBotAvatarActivity | undefined {
  if (call === null || call.environmentId !== environmentId || call.botId !== botId) {
    return activity;
  }
  switch (call.state.phase) {
    case "starting":
    case "connecting":
    case "reconnecting":
      return "loading";
    case "live":
      return "listening";
    case "idle":
      return activity;
  }
}
