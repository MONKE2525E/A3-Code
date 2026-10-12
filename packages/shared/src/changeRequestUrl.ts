import {
  pullRequestHostOf,
  type RepositoryIdentity,
  type SourceControlProviderKind,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { canonicalRepositoryKey } from "./sourceControl.ts";

/**
 * A change request named the way a thread link names one: the host below which the repository
 * is addressed, the repository path as that host writes it, and the number.
 *
 * The two strings are what `pullRequestHostOf` and the project's `repositoryIdentity` produce
 * from a git remote — lower case, no port, the full path below the host — because links are
 * matched against those. Anything else matches nothing.
 */
export interface ChangeRequestLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  /** Forgejo's HTTP host and port, separate from the portless repository identity. */
  readonly authority?: string;
}

/** The host itself, one of its subdomains, or an install named after the provider. */
function isHostOf(hostname: string, apex: string, label?: string): boolean {
  if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  return label !== undefined && hostname.split(".").includes(label);
}

/**
 * The repository and number behind a change request URL on a host this can read, or null for
 * anything else — an issue, a commit, a repository root, a host this cannot tell apart from an
 * ordinary link. A doubtful match is worse than no match, so nothing here guesses.
 *
 * Each host is recognised by the path shape it alone uses, guarded by a hostname it could
 * plausibly be served from, since self-hosted installs are named whatever their admin chose:
 * GitLab's `/-/` marker is unique enough to trust on any hostname, while `/pull/` is generic
 * enough that it is only believed from a GitHub-ish host.
 *
 * Nothing here tries to tell a lookalike hostname from a real one — `github.com.evil.test` and
 * the rest are an open set, and blocking spellings of it costs real hosts (`gitlab.com.br` is a
 * registrable domain). What a claim is worth is decided where it is used.
 */
export function parseChangeRequestUrl(targetUrl: string): ChangeRequestLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  // `javascript:`, `mailto:` and friends have no host to speak of and nothing to open.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  // GitCafe, only on its own two hosts: /{owner}/{repo}/pulls/{n}
  if (host === "git.cafe" || host === "staging.git.cafe") {
    const match = /^\/([^/]+\/[^/]+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  // GitHub, and any Enterprise install: /{owner}/{repo}/pull/{n}
  if (isHostOf(host, "github.com", "github")) {
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (match) return claim(host, match);
  }
  // Forgejo and Gitea use /pulls/ on arbitrary self-hosted domains.
  const forgejo = /^\/([^/]+(?:\/[^/]+)+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (forgejo) {
    const link = claim(host, forgejo);
    return link === null ? null : { ...link, authority: url.host.toLowerCase() };
  }
  // GitLab, self-hosted included: /{group}/[{subgroup}/...]{repo}/-/merge_requests/{n}. The `/-/`
  // separator is GitLab's own, so the hostname is not asked about.
  const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (gitlab) return claim(host, gitlab);
  // Bitbucket Cloud: /{workspace}/{repo}/pull-requests/{n}
  if (isHostOf(host, "bitbucket.org", "bitbucket")) {
    const match = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  // Azure DevOps, both the current host and the per-organisation one it replaced. `_git` is part
  // of the repository path there, as it is in the remote URL the identity is read from.
  if (isHostOf(host, "dev.azure.com") || host.endsWith(".visualstudio.com")) {
    const match = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  return null;
}

function claim(host: string, match: RegExpExecArray | null): ChangeRequestLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

/** The web URL a host writes for a change request; null when the host shape is unknown. */
export function changeRequestUrlFor(
  kind: string | null | undefined,
  host: string,
  repository: string,
  number: number,
  remoteUrl?: string,
): string | null {
  switch (kind) {
    case "github":
      return `https://${host}/${repository}/pull/${number}`;
    case "gitcafe":
      return `https://${host}/${repository}/pulls/${number}`;
    case "forgejo": {
      try {
        const remote = new URL(remoteUrl ?? "");
        if (
          (remote.protocol === "http:" || remote.protocol === "https:") &&
          (remote.hostname.toLowerCase() === host.toLowerCase() ||
            remote.host.toLowerCase() === host.toLowerCase())
        ) {
          return `${remote.origin}/${repository}/pulls/${number}`;
        }
      } catch {
        // SSH remotes do not specify the server's web origin.
      }
      return `https://${host}/${repository}/pulls/${number}`;
    }
    case "gitlab":
      return `https://${host}/${repository}/-/merge_requests/${number}`;
    case "bitbucket":
      return `https://${host}/${repository}/pull-requests/${number}`;
    case "azure-devops":
      return `https://${canonicalRepositoryKey(`${host}/${repository}`.toLowerCase())}/pullrequest/${number}`;
    default:
      return null;
  }
}

/** Builds a GitHub URL that remains available when the pull request API cannot be read. */
export function gitHubPullRequestBrowserUrl(
  identity: RepositoryIdentity | null | undefined,
  repository: string,
  number: number,
): string | null {
  if (identity?.provider !== "github" || !Number.isSafeInteger(number) || number < 1) return null;
  const repositoryPath = repository.split("/");
  if (
    repositoryPath.length !== 2 ||
    repositoryPath.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }

  let origin: string | null = null;
  try {
    const remoteUrl = new URL(identity.locator.remoteUrl.trim());
    if (remoteUrl.protocol === "http:" || remoteUrl.protocol === "https:") {
      origin = remoteUrl.origin;
    }
  } catch {
    // SCP-style remotes are read from their normalized identity below.
  }
  const hostname = identity.canonicalKey.split("/")[0];
  if (origin === null && !hostname) return null;

  try {
    const url = new URL(origin ?? `https://${hostname}`);
    url.pathname = `/${repositoryPath.join("/")}/pull/${number}`;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The pull-request URL a GitHub-style `#123` autolink might name. GitHub writes every bare
 * reference through `/issues/`, including pull requests, so this only builds a candidate: the
 * caller must successfully read it as a pull request before treating it as one.
 */
export function pullRequestCandidateUrlFromReferenceAutolink(targetUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !(
      url.hostname.toLowerCase() === "github.com" ||
      url.hostname.toLowerCase().endsWith(".github.com") ||
      url.hostname.toLowerCase().split(".").includes("github")
    )
  ) {
    return null;
  }
  const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  url.pathname = `/${match[1]}/pull/${match[2]}`;
  return url.toString();
}

/** Match a stored PR without requiring its project to remain available. */
export function matchesLinkedPullRequestUrl(
  linkedPullRequest: ThreadLinkedPullRequest,
  targetUrl: string,
): boolean {
  const linked = parseChangeRequestUrl(linkedPullRequest.url);
  const target = parseChangeRequestUrl(targetUrl);
  return (
    linked !== null &&
    target !== null &&
    linked.host === target.host &&
    linked.repository === target.repository &&
    linked.number === target.number &&
    linked.authority === target.authority
  );
}

/** The repository root behind a recognised change-request URL, without PR-specific state. */
export function changeRequestRepositoryUrl(targetUrl: string): string | null {
  const changeRequest = parseChangeRequestUrl(targetUrl);
  if (changeRequest === null) return null;
  const url = new URL(targetUrl);
  const repositoryPath =
    /^(.*?)\/-\/merge_requests\/\d+(?:\/|$)/iu.exec(url.pathname)?.[1] ??
    /^(.*?)(?:\/pulls?\/\d+|\/-\/merge_requests\/\d+|\/pull-requests\/\d+|\/pullrequest\/\d+)(?:\/|$)/iu.exec(
      url.pathname,
    )?.[1];
  if (!repositoryPath) return null;
  url.pathname = repositoryPath;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function siblingPullRequestUrl(url: string, number: number): string | null {
  const reference = parseChangeRequestUrl(url);
  if (reference === null || !Number.isSafeInteger(number) || number < 1) return null;
  const sibling = new URL(url);
  const route = /^\/(-\/merge_requests|pulls?|pull-requests|pullrequest)\/\d+(?:\/|$)/u.exec(
    sibling.pathname.slice(reference.repository.length + 1),
  )?.[1];
  if (route === undefined) return null;
  sibling.pathname = `/${reference.repository}/${route}/${number}`;
  sibling.search = "";
  sibling.hash = "";
  return sibling.toString();
}

/** What project matching reads: a project's recorded repository, nothing else. */
export interface ChangeRequestProject {
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

function resolvedForgejoRepository(project: ChangeRequestProject): URL | null {
  const identity = project.repositoryIdentity;
  if (identity?.provider !== "forgejo" || !identity.webUrl) return null;
  try {
    const url = new URL(identity.webUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Keep Forgejo servers on different HTTP ports separate when selecting a project. */
function matchesChangeRequestAuthority(
  project: ChangeRequestProject,
  link: ChangeRequestLink,
): boolean {
  if (link.authority === undefined) return true;
  try {
    const remote = new URL(project.repositoryIdentity?.locator.remoteUrl ?? "");
    if (remote.protocol === "http:" || remote.protocol === "https:") {
      return remote.host.toLowerCase() === link.authority;
    }
  } catch {
    // SSH remotes do not specify the server's HTTP port; tea resolves the configured login.
  }
  return true;
}

/**
 * The project a link belongs to, or nothing. Matched the way the server matches: the repository
 * identity is the full path below the host where one was recorded — which is what nested GitLab
 * groups and Azure project paths need — and the host is the first segment of the canonical
 * remote, so github.com and an Enterprise install stay apart.
 *
 * Resolving the project is what makes recognising a URL safe: a lookalike hostname matches no
 * project and stays an ordinary link.
 */
export function findProjectForChangeRequest<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ChangeRequestLink,
): Project | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity || !matchesChangeRequestAuthority(project, link)) return false;
    const kind = identity.provider as SourceControlProviderKind | undefined;
    if (kind === undefined) return false;
    const web = resolvedForgejoRepository(project);
    if (web)
      return (
        web.host.toLowerCase() === (link.authority ?? link.host).toLowerCase() &&
        web.pathname.replace(/^\/+|\/+$/g, "").toLowerCase() === link.repository.toLowerCase()
      );
    if (kind === "azure-devops") {
      return (
        canonicalRepositoryKey(identity.canonicalKey.toLowerCase()) ===
        canonicalRepositoryKey(`${link.host}/${link.repository}`.toLowerCase())
      );
    }
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    return (
      repository !== null &&
      repository.toLowerCase() === link.repository.toLowerCase() &&
      (pullRequestHostOf(identity, kind) === link.host.toLowerCase() ||
        pullRequestHostOf(identity, kind) === link.authority)
    );
  });
}

/**
 * Any project checked out from the link's host. Thread links are host-level, so a pull request
 * from a repository nobody has checked out is still linkable as long as one project on that
 * host can lend the server its credentials. The link's own project, when it exists, comes first.
 */
export function findProjectOnChangeRequestHost<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ChangeRequestLink,
): Project | undefined {
  const own = findProjectForChangeRequest(projects, link);
  if (own !== undefined) return own;
  // Azure CLI reads use the checkout's organization and project, not host-wide credentials.
  if (
    canonicalRepositoryKey(`${link.host}/${link.repository}`.toLowerCase()).startsWith(
      "dev.azure.com/",
    )
  )
    return undefined;
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    const kind = identity?.provider as SourceControlProviderKind | undefined;
    const web = resolvedForgejoRepository(project);
    if (web) {
      const mount = web.pathname
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .slice(0, -2)
        .join("/");
      return (
        web.host.toLowerCase() === (link.authority ?? link.host).toLowerCase() &&
        (!mount || link.repository.toLowerCase().startsWith(`${mount.toLowerCase()}/`))
      );
    }
    return (
      identity != null &&
      kind !== undefined &&
      kind !== "azure-devops" &&
      matchesChangeRequestAuthority(project, link) &&
      (pullRequestHostOf(identity, kind) === link.host.toLowerCase() ||
        pullRequestHostOf(identity, kind) === link.authority)
    );
  });
}
