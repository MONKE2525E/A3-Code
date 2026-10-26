import { EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Platform } from "react-native";
import { resetAndroidWorkspace } from "../../lib/android-workspace-navigation";

import { type ExternalUrlTarget, tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { resolveNativePullRequestLink } from "./pull-request-link";

/** Read projects and capabilities on press so project changes do not rerender every chat link. */
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
        const params = { ...target, ...(threadId ? { threadId } : {}) };
        if (Platform.OS === "android" && !threadId) {
          resetAndroidWorkspace(navigation);
          navigation.dispatch(StackActions.push("PullRequest", params));
        } else
          navigation.dispatch(
            (options?.replace ? StackActions.replace : StackActions.push)("PullRequest", params),
          );
        return true;
      }
      return tryOpenExternalUrl(url, external);
    },
    [navigation, options?.replace],
  );
}
