import { describe, expect, it } from "vite-plus/test";
import type { RepositoryIdentity } from "@t3tools/contracts";

import { resolveNativePullRequestLink } from "./pull-request-link";

function identity(
  provider: string,
  canonicalKey: string,
  displayName: string,
  remoteUrl: string,
): RepositoryIdentity {
  const [owner, name] = displayName.split("/");
  return {
    canonicalKey,
    provider,
    displayName,
    owner,
    name,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  } as RepositoryIdentity;
}

const app = {
  id: "project-app",
  environmentId: "env-a",
  repositoryIdentity: identity(
    "github",
    "github.com/example/app",
    "example/app",
    "https://github.com/example/app.git",
  ),
};
const sameRepoElsewhere = { ...app, id: "project-app-b", environmentId: "env-b" };
const enterprise = {
  id: "project-enterprise",
  environmentId: "env-a",
  repositoryIdentity: identity(
    "github",
    "github.acme.test/team/api",
    "team/api",
    "https://github.acme.test/team/api.git",
  ),
};
const supported = { pullRequests: true, threadPullRequests: true };

function resolve(
  url: string,
  overrides: Partial<Parameters<typeof resolveNativePullRequestLink>[0]> = {},
) {
  return resolveNativePullRequestLink({
    url,
    environmentId: "env-a",
    projects: [app, enterprise, sameRepoElsewhere],
    capabilities: supported,
    ...overrides,
  });
}

describe("native pull request link routing", () => {
  it("opens a canonical GitHub link for the project that holds the repository", () => {
    expect(resolve("https://github.com/example/app/pull/42")).toEqual({
      environmentId: "env-a",
      projectId: "project-app",
      repository: "example/app",
      number: 42,
      host: "github.com",
    });
  });

  it("ignores the query, fragment and trailing page of a link", () => {
    for (const url of [
      "https://github.com/example/app/pull/42?notification_referrer_id=x",
      "https://github.com/example/app/pull/42#issuecomment-1",
      "https://github.com/example/app/pull/42/files#diff-abc",
      "https://github.com/example/app/pull/42/",
      "HTTPS://GitHub.com/Example/App/pull/42",
    ]) {
      expect(resolve(url)).toMatchObject({ projectId: "project-app", number: 42 });
    }
  });

  it("resolves inside the environment the link was read in, never another that holds the repository", () => {
    expect(resolve("https://github.com/example/app/pull/7", { environmentId: "env-b" })).toEqual({
      environmentId: "env-b",
      projectId: "project-app-b",
      repository: "example/app",
      number: 7,
      host: "github.com",
    });
    expect(resolve("https://github.com/example/app/pull/7", { environmentId: "env-c" })).toBeNull();
  });

  it("keeps enterprise installs apart from github.com", () => {
    expect(resolve("https://github.acme.test/team/api/pull/3")).toMatchObject({
      projectId: "project-enterprise",
      host: "github.acme.test",
    });
    expect(resolve("https://github.com/team/api/pull/3")).toMatchObject({
      repository: "team/api",
      // Not the enterprise project: only the host-level fallback finds a project here.
      host: "github.com",
    });
  });

  it("lends a pull request from an unseen repository a project on the same host", () => {
    expect(resolve("https://github.com/someone/else/pull/9")).toMatchObject({
      projectId: "project-app",
      repository: "someone/else",
      host: "github.com",
    });
  });

  it("falls back to the project's own repository on servers without host-level reads", () => {
    const legacy = { pullRequests: true, threadPullRequests: false };
    expect(resolve("https://github.com/example/app/pull/42", { capabilities: legacy })).toEqual({
      environmentId: "env-a",
      projectId: "project-app",
      repository: "example/app",
      number: 42,
    });
    // An unseen repository has no project to read it with there.
    expect(resolve("https://github.com/someone/else/pull/9", { capabilities: legacy })).toBeNull();
  });

  it("leaves a link external when the environment cannot read pull requests", () => {
    expect(resolve("https://github.com/example/app/pull/42", { capabilities: null })).toBeNull();
    expect(
      resolve("https://github.com/example/app/pull/42", {
        capabilities: { pullRequests: false, threadPullRequests: true },
      }),
    ).toBeNull();
  });

  it("does not claim lookalike hosts, issues, repository pages or other schemes", () => {
    for (const url of [
      "https://github.com.evil.test/example/app/pull/42",
      "https://evil.test/example/app/pull/42",
      "https://notgithub.com/example/app/pull/42",
      "https://github.com/example/app/issues/42",
      "https://github.com/example/app",
      "https://github.com/example/app/pull/0",
      "https://github.com/example/app/pull/9007199254740993",
      "https://github.com/example/app/pulls",
      "https://gitlab.com/example/app/-/merge_requests/42",
      "javascript:alert(1)",
      "mailto:someone@example.com",
      "not a url",
    ]) {
      expect(resolve(url), url).toBeNull();
    }
  });
});
