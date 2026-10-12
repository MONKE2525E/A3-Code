import {
  type ChangeRequestProject,
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
  parseChangeRequestUrl,
} from "@t3tools/shared/changeRequestUrl";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

/** What the native viewer's route takes; `host` is only set where the server reads it. */
export interface NativePullRequestTarget {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly host?: string;
}

interface LinkProject extends ChangeRequestProject {
  readonly id: string;
  readonly environmentId: string;
}

/**
 * The native viewer's route for a pull request link, or null when the link is an ordinary one.
 *
 * Mirrors the desktop reading of the same link: the URL is parsed by the shared reader, then
 * resolved to a project on the environment the link was read in. A lookalike hostname, an issue,
 * or a repository nobody on this environment has checked out matches no project, so it stays an
 * external link. Only the thread's own environment is searched: that is the one the viewer reads
 * on, and two environments can hold the same repository.
 */
export function resolveNativePullRequestLink(input: {
  readonly url: string;
  readonly environmentId: string;
  readonly projects: ReadonlyArray<LinkProject>;
  readonly capabilities:
    | { readonly pullRequests?: boolean; readonly threadPullRequests?: boolean }
    | null
    | undefined;
}): NativePullRequestTarget | null {
  if (input.capabilities?.pullRequests !== true) return null;
  const link = parseChangeRequestUrl(input.url);
  if (link === null) return null;
  const projects = input.projects.filter(
    (project) => project.environmentId === input.environmentId,
  );
  const hostLevel = input.capabilities.threadPullRequests === true;
  // Older servers read only the repository's own project; newer ones lend any project on the
  // host its credentials, so a pull request from a repository nobody has checked out still opens.
  const project = hostLevel
    ? findProjectOnChangeRequestHost(projects, link)
    : findProjectForChangeRequest(projects, link);
  if (project === undefined) return null;
  return {
    environmentId: input.environmentId,
    projectId: project.id,
    repository: hostLevel
      ? link.repository
      : (sourceControlRepositorySelector(project.repositoryIdentity) ?? link.repository),
    number: link.number,
    ...(hostLevel ? { host: link.authority ?? link.host } : {}),
  };
}
