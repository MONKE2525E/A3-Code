import type { EnvironmentId } from "@t3tools/contracts";
import { useSearch } from "@tanstack/react-router";

import { usePrimaryEnvironmentId } from "~/state/environments";

export function useSelectedGrokBotEnvironmentId(): EnvironmentId | null {
  const searchEnvironmentId = useSearch({
    strict: false,
    select: (search) => {
      const value = (search as { environmentId?: unknown }).environmentId;
      return typeof value === "string" && value.trim().length > 0 ? (value as EnvironmentId) : null;
    },
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Thread route params scope the conversation, not the global bot roster.
  return searchEnvironmentId ?? primaryEnvironmentId;
}
