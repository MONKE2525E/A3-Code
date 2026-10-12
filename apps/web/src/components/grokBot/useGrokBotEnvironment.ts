import type { EnvironmentId } from "@t3tools/contracts";
import { useParams, useSearch } from "@tanstack/react-router";

import { usePrimaryEnvironmentId } from "~/state/environments";

export function useSelectedGrokBotEnvironmentId(): EnvironmentId | null {
  const searchEnvironmentId = useSearch({
    strict: false,
    select: (search) => {
      const value = (search as { environmentId?: unknown }).environmentId;
      return typeof value === "string" && value.trim().length > 0 ? (value as EnvironmentId) : null;
    },
  });
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) =>
      typeof params.environmentId === "string" && params.environmentId.trim().length > 0
        ? (params.environmentId as EnvironmentId)
        : null,
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return searchEnvironmentId ?? routeEnvironmentId ?? primaryEnvironmentId;
}
