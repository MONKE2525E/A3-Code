import { useRoute } from "@react-navigation/native";
import { useCallback } from "react";
import { type ExternalUrlTarget, tryOpenExternalUrl } from "../lib/openExternalUrl";
import { useOpenPullRequest as useResolvedPullRequest } from "../features/pull-requests/useOpenPullRequest";

/** Resolve links in their originating environment and carry the thread into the shared viewer. */
export function useOpenPullRequest(options?: {
  readonly replace?: boolean;
  readonly context?: { readonly environmentId: string; readonly projectId: string };
}) {
  const route = useRoute();
  const routeContext = route.params as
    | { environmentId?: string | string[]; threadId?: string | string[] }
    | undefined;
  const first = (value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ? text : undefined;
  };
  const environmentId = options?.context?.environmentId ?? first(routeContext?.environmentId);
  const threadId = first(routeContext?.threadId);
  const openResolved = useResolvedPullRequest(options);
  return useCallback(
    async (
      url: string,
      sourceEnvironmentId = environmentId,
      external: ExternalUrlTarget = "pull-request",
      sourceThreadId = threadId,
    ) =>
      sourceEnvironmentId
        ? openResolved(url, sourceEnvironmentId, external, sourceThreadId)
        : tryOpenExternalUrl(url, external),
    [environmentId, threadId, openResolved],
  );
}
