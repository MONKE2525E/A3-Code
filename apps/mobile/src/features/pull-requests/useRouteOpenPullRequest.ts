import { useRoute } from "@react-navigation/native";
import { useCallback } from "react";
import { type ExternalUrlTarget, tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useOpenPullRequest as useResolvedPullRequest } from "./useOpenPullRequest";

/**
 * Resolve links in the environment and thread of the current route unless the caller names an
 * environment. Callers that know the link's environment pass it as the second argument.
 */
export function useRouteOpenPullRequest(options?: { readonly replace?: boolean }) {
  const route = useRoute();
  const routeParams = route.params as
    | { environmentId?: string | string[]; threadId?: string | string[] }
    | undefined;
  const first = (value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ? text : undefined;
  };
  const environmentId = first(routeParams?.environmentId);
  const threadId = first(routeParams?.threadId);
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
