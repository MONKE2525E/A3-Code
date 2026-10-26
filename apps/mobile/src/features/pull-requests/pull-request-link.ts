import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { RepositoryIdentity } from "@t3tools/contracts";
/** What the native viewer's route takes; `host` is only set where the server reads it. */
export interface NativePullRequestTarget {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly host?: string;
}

interface LinkProject {
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  readonly id: string;
  readonly environmentId: string;
}

/** Resolve only checked-out repositories in the originating environment; other links stay external. */
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
  const link = sourceControlClients.parseChangeRequestUrl(input.url)?.link ?? null;
  if (link === null) return null;
  const projects = input.projects.filter(
    (project) => project.environmentId === input.environmentId,
  );
  const hostLevel = input.capabilities.threadPullRequests === true;
  // Older servers read only the repository's own project; newer ones lend any project on the
  // host its credentials, so a pull request from a repository nobody has checked out still opens.
  const project = hostLevel
    ? projects.find(
        (p) =>
          p.repositoryIdentity?.provider !== undefined &&
          sourceControlClients
            .get(p.repositoryIdentity.provider)
            .canReadChangeRequestOnHost(p.repositoryIdentity, link),
      )
    : projects.find(
        (p) =>
          p.repositoryIdentity?.provider !== undefined &&
          sourceControlClients
            .get(p.repositoryIdentity.provider)
            .isChangeRequestInRepository(p.repositoryIdentity, link),
      );
  if (project === undefined) return null;
  return {
    environmentId: input.environmentId,
    projectId: project.id,
    repository: hostLevel
      ? link.repository
      : (sourceControlClients.repositorySelector(project.repositoryIdentity) ?? link.repository),
    number: link.number,
    ...(hostLevel ? { host: link.authority ?? link.host } : {}),
  };
}
