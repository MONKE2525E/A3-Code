import { EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";

import { type ExternalUrlTarget, tryOpenExternalUrl } from "../lib/openExternalUrl";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentProjects } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { resolveNativePullRequestLink } from "../lib/pullRequestLink";

/**
 * Opens a link in the native pull request viewer when it names a repository the environment can
 * read, and externally otherwise. `environmentId` is the environment the link was read in: the
 * thread's, for a chat link. `threadId` is the thread it was read in, which the viewer hands off
 * to and returns to. Resolves to whether anything opened.
 *
 * Projects and capabilities are read when the link is pressed rather than subscribed to, so a
 * thread full of links does not re-render when the project list changes.
 */
export function useOpenPullRequest(options?: { readonly replace?: boolean }) {
  const navigation = useNavigation();
  return useCallback(
    async (
      url: string,
      environmentId: string,
      external: ExternalUrlTarget = "pull-request",
      threadId?: string,
    ): Promise<boolean> => {
      const target = resolveNativePullRequestLink({
        url,
        environmentId,
        projects: appAtomRegistry.get(environmentProjects.projectsAtom),
        capabilities: appAtomRegistry.get(
          serverEnvironment.configValueAtom(EnvironmentId.make(environmentId)),
        )?.environment.capabilities,
      });
      if (target) {
        // A push, not a navigate: a link inside one pull request opens another on top of it, and
        // Back returns to the first.
        navigation.dispatch(
          (options?.replace ? StackActions.replace : StackActions.push)("PullRequest", {
            ...target,
            ...(threadId ? { threadId } : {}),
          }),
        );
        return true;
      }
      return tryOpenExternalUrl(url, external);
    },
    [navigation, options?.replace],
  );
}
