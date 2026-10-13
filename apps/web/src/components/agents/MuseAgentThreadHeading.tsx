import type { EnvironmentId } from "@t3tools/contracts";

import { museAgentProfileQuery } from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";

import { MuseAgentAvatar } from "./MuseAgentAvatar";
import { useMuseAgentAvatar } from "./useMuseAgentAvatar";

/** The chat header for the native Muse thread: the agent's own face and name instead of a project. */
export function MuseAgentThreadHeading({
  environmentId,
  fallbackTitle,
  active = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly fallbackTitle: string;
  readonly active?: boolean;
}) {
  const profile = useEnvironmentQuery(museAgentProfileQuery({ environmentId, input: {} })).data;
  const avatar = useMuseAgentAvatar(environmentId, profile, { loadVideo: active });
  const name = profile?.name?.trim() || fallbackTitle || "Muse";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <MuseAgentAvatar
        name={name}
        imageUrl={avatar.imageUrl}
        videoUrl={avatar.videoUrl}
        active={active}
        size="sm"
      />
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
    </span>
  );
}
