import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { museAgentProfileQuery } from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { environmentThreadShells } from "~/state/threads";

import { MuseAgentAvatar } from "./MuseAgentAvatar";
import { museAvatarStateForStatus } from "./aiAgents";
import { useMuseAgentAvatar } from "./useMuseAgentAvatar";

/**
 * The chat header for the native Muse thread: the agent's own face and name instead of a project.
 * Its avatar follows the thread's run, the same as the sidebar row.
 */
export function MuseAgentThreadHeading({
  environmentId,
  threadId,
  fallbackTitle,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly fallbackTitle: string;
}) {
  const profile = useEnvironmentQuery(museAgentProfileQuery({ environmentId, input: {} })).data;
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const status = useMemo(
    () => threads.find((thread) => thread.id === threadId)?.status,
    [threadId, threads],
  );
  const state = museAvatarStateForStatus(status);
  const avatar = useMuseAgentAvatar(environmentId, profile, { state });
  const name = profile?.name?.trim() || fallbackTitle || "Muse";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <MuseAgentAvatar
        name={name}
        imageUrl={avatar.imageUrl}
        videoUrl={avatar.videoUrl}
        active={state !== "idle"}
        size="sm"
      />
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
    </span>
  );
}
