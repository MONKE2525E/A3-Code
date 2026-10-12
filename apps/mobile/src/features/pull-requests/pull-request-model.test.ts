import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  PullRequestOperationError,
  type PullRequestListEntry,
} from "@t3tools/contracts";
import {
  countActivePullRequestFilters,
  DEFAULT_PULL_REQUEST_FILTERS,
  describePullRequestFailure,
  matchesPullRequestQuery,
  mergePullRequestPages,
  pullRequestFailureMessage,
  resolvePullRequestListStatus,
  resolvePullRequestNotices,
  resolvePullRequestPresentation,
  sortPullRequestChecks,
  sortPullRequests,
  summarizePullRequestChecks,
  usesPullRequestSplitView,
} from "./pull-request-model";

function entry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: ProjectId.make("project-a"),
    projectTitle: "Example",
    repository: "example/app",
    number: 42,
    title: "Add mobile PR viewer",
    url: "https://github.com/example/app/pull/42",
    author: { login: "contributor", name: null, avatarUrl: null },
    headBranch: "mobile-pr",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  };
}

describe("mobile PR listing", () => {
  it("deduplicates repository pages while keeping different hosts and repositories separate", () => {
    const original = entry();
    const updated = entry({ title: "Updated title", updatedAt: "2026-10-05T00:00:00Z" });
    const otherHost = entry({ host: "github.example.com" });
    const otherRepo = entry({ repository: "example/other" });
    const rows = mergePullRequestPages([
      [original, otherHost],
      [updated, otherRepo],
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.title).toBe("Updated title");
  });
  it("finds numbers, titles, authors and repositories for hosts without text search", () => {
    for (const query of ["#42", "MOBILE", "contributor", "example/app", " "])
      expect(matchesPullRequestQuery(entry(), query)).toBe(true);
    expect(matchesPullRequestQuery(entry(), "missing")).toBe(false);
  });
  it("uses available pane width for folded and unfolded layouts", () => {
    expect(usesPullRequestSplitView(412)).toBe(false);
    expect(usesPullRequestSplitView(600)).toBe(false);
    // An unfolded Fold gives the pull request the whole width instead of a cramped half.
    expect(usesPullRequestSplitView(750)).toBe(false);
    expect(usesPullRequestSplitView(840)).toBe(true);
  });
});

describe("PR list sorting and filters", () => {
  it("sorts on native engines without Array.toSorted", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    // eslint-disable-next-line no-extend-native -- Emulate the native engine's missing API.
    Object.defineProperty(Array.prototype, "toSorted", { value: undefined, configurable: true });
    try {
      expect(sortPullRequests([entry()], "updated")).toHaveLength(1);
      expect(sortPullRequestChecks([{ status: "success" }, { status: "failure" }])).toEqual([
        { status: "failure" },
        { status: "success" },
      ]);
    } finally {
      if (descriptor) {
        // eslint-disable-next-line no-extend-native -- Restore the host API after the regression test.
        Object.defineProperty(Array.prototype, "toSorted", descriptor);
      }
    }
  });
  const rows = [
    entry({ number: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" }),
    entry({ number: 2, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }),
    entry({ number: 3, createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" }),
  ];
  const numbers = (sort: Parameters<typeof sortPullRequests>[1]) =>
    sortPullRequests(rows, sort).map((row) => row.number);
  it("orders loaded rows by update or creation time in either direction", () => {
    expect(numbers("updated")).toEqual([3, 1, 2]);
    expect(numbers("stale")).toEqual([2, 1, 3]);
    expect(numbers("newest")).toEqual([2, 3, 1]);
    expect(numbers("oldest")).toEqual([1, 3, 2]);
  });
  it("does not reorder the rows it was given", () => {
    sortPullRequests(rows, "oldest");
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
  });
  it("counts only filters that differ from the defaults", () => {
    expect(countActivePullRequestFilters(DEFAULT_PULL_REQUEST_FILTERS)).toBe(0);
    expect(
      countActivePullRequestFilters({
        ...DEFAULT_PULL_REQUEST_FILTERS,
        sort: "oldest",
        state: "merged",
        projectId: "project-a",
      }),
    ).toBe(2);
  });
  it("searches branch names too", () => {
    expect(matchesPullRequestQuery(entry(), "mobile-pr")).toBe(true);
  });
});

describe("PR presentation", () => {
  it("lets a draft outrank conflicts and a finished state outrank both", () => {
    const base = { state: "open", isDraft: true, mergeability: "conflicting" } as const;
    expect(resolvePullRequestPresentation(base, "dark").label).toBe("Draft");
    expect(resolvePullRequestPresentation({ ...base, isDraft: false }, "dark").label).toBe(
      "Conflicts",
    );
    expect(resolvePullRequestPresentation({ ...base, state: "merged" }, "light").label).toBe(
      "Merged",
    );
    expect(resolvePullRequestPresentation({ ...base, state: "closed" }, "light").label).toBe(
      "Closed",
    );
  });
  it("uses a different ink per theme", () => {
    const open = { state: "open", isDraft: false, mergeability: "mergeable" } as const;
    expect(resolvePullRequestPresentation(open, "light").color).not.toBe(
      resolvePullRequestPresentation(open, "dark").color,
    );
  });
});

describe("PR checks", () => {
  it("treats checks requiring action as failures and sorts them before running checks", () => {
    const checks = [{ status: "pending" as const }, { status: "action-required" as const }];
    expect(summarizePullRequestChecks(checks)).toEqual({
      tone: "failure",
      label: "1 of 2 checks failing",
    });
    expect(sortPullRequestChecks(checks).map((check) => check.status)).toEqual([
      "action-required",
      "pending",
    ]);
  });
  it("summarizes failures before running checks before a clean run", () => {
    expect(summarizePullRequestChecks([]).tone).toBe("none");
    expect(summarizePullRequestChecks([{ status: "success" }, { status: "skipped" }])).toEqual({
      tone: "success",
      label: "2 checks passed",
    });
    expect(summarizePullRequestChecks([{ status: "success" }, { status: "pending" }])).toEqual({
      tone: "pending",
      label: "1 check running",
    });
    expect(
      summarizePullRequestChecks([
        { status: "pending" },
        { status: "failure" },
        { status: "success" },
      ]),
    ).toEqual({ tone: "failure", label: "1 of 3 checks failing" });
  });
  it("lists checks that need attention first", () => {
    const statuses = sortPullRequestChecks([
      { status: "success" },
      { status: "skipped" },
      { status: "pending" },
      { status: "cancelled" },
    ]).map((check) => check.status);
    expect(statuses).toEqual(["cancelled", "pending", "success", "skipped"]);
  });
});

describe("PR list status", () => {
  const healthy = { error: null, projectErrors: [], unconfigured: [] };
  const base = {
    rowCount: 0,
    hasData: true,
    pending: false,
    query: "",
    searching: false,
    filterCount: 0,
    projectCount: 2,
    pullRequestsSupported: true as boolean | undefined,
    health: healthy,
  };
  it("shows rows whenever there are rows, and carries problems as notices instead", () => {
    const health = {
      error: "Rate limited",
      projectErrors: [{ projectTitle: "App", message: "No access" }],
      unconfigured: [{ host: "git.example.com", detail: null }],
    };
    expect(resolvePullRequestListStatus({ ...base, rowCount: 3, health })).toEqual({
      kind: "rows",
    });
    expect(resolvePullRequestNotices(health)).toEqual([
      "Rate limited Showing the last pull requests loaded.",
      "App: No access",
      "git.example.com: Configure this provider on the environment.",
    ]);
  });
  it("reports a failed first load as an error, never as an empty list", () => {
    expect(
      resolvePullRequestListStatus({
        ...base,
        hasData: false,
        health: { ...healthy, error: "Rate limited" },
      }),
    ).toEqual({ kind: "error", title: "Could not load pull requests", message: "Rate limited" });
    expect(resolvePullRequestListStatus({ ...base, hasData: false, pending: true }).kind).toBe(
      "loading",
    );
  });
  it("does not call an unreadable project's empty answer 'no pull requests'", () => {
    const status = resolvePullRequestListStatus({
      ...base,
      health: { ...healthy, projectErrors: [{ projectTitle: "App", message: "No access" }] },
    });
    expect(status).toMatchObject({ kind: "error", message: "App: No access" });
    const setup = resolvePullRequestListStatus({
      ...base,
      health: { ...healthy, unconfigured: [{ host: "github.com", detail: "gh is not signed in" }] },
    });
    expect(setup).toMatchObject({ kind: "setup", message: "github.com: gh is not signed in" });
  });
  it("tells a search, a filter and a plain empty answer apart", () => {
    expect(resolvePullRequestListStatus({ ...base, query: "auth" }).kind).toBe("empty-search");
    expect(resolvePullRequestListStatus({ ...base, filterCount: 1 }).kind).toBe("empty-filtered");
    expect(resolvePullRequestListStatus(base).kind).toBe("empty");
  });
  it("says so when the environment cannot list pull requests, instead of showing an error", () => {
    expect(
      resolvePullRequestListStatus({ ...base, hasData: false, pullRequestsSupported: false }),
    ).toMatchObject({ kind: "unsupported", title: "Pull requests unavailable" });
  });
  it("waits on an environment that has not reported its capabilities", () => {
    expect(
      resolvePullRequestListStatus({
        ...base,
        hasData: false,
        pullRequestsSupported: undefined,
      }).kind,
    ).toBe("loading");
    // A failed read is still reported while the capabilities are unknown.
    expect(
      resolvePullRequestListStatus({
        ...base,
        hasData: false,
        pullRequestsSupported: undefined,
        health: { ...healthy, error: "Offline" },
      }).kind,
    ).toBe("error");
  });
  it("does not call a search that is still running an empty answer", () => {
    expect(resolvePullRequestListStatus({ ...base, query: "auth", searching: true })).toMatchObject(
      { kind: "loading", caption: 'Searching for "auth"' },
    );
    expect(resolvePullRequestListStatus({ ...base, query: "auth", searching: false }).kind).toBe(
      "empty-search",
    );
  });
  it("names an environment with no projects before blaming the filters or the search", () => {
    expect(
      resolvePullRequestListStatus({ ...base, projectCount: 0, query: "auth", filterCount: 2 })
        .kind,
    ).toBe("no-projects");
  });
  it("lets an unreadable project outrank a missing one", () => {
    expect(
      resolvePullRequestListStatus({
        ...base,
        projectCount: 0,
        health: { ...healthy, projectErrors: [{ projectTitle: "App", message: "No access" }] },
      }).kind,
    ).toBe("error");
  });
});

describe("PR failure presentation", () => {
  it("drops the operation wrapper and keeps the host's own sentence", () => {
    expect(
      pullRequestFailureMessage(
        "Pull request operation detail failed: API rate limit exceeded. Try again in 12 minutes.",
      ),
    ).toBe("API rate limit exceeded. Try again in 12 minutes.");
  });
  it("replaces bare tool noise with what to check", () => {
    for (const message of ["GitHub CLI failed", "exited with code 1", "", null])
      expect(pullRequestFailureMessage(message)).toMatch(/signed in to the host/);
  });
  it("tells a pull request that is not there from one that failed to load", () => {
    const notFound = new PullRequestOperationError({
      operation: "detail",
      detail: "Could not resolve to a PullRequest",
      reason: "not-found",
    });
    expect(
      describePullRequestFailure({ failure: notFound, message: notFound.message, number: 9 }),
    ).toEqual({
      title: "Pull request #9 not found",
      message: "It may be an issue rather than a pull request, or this account can't see it.",
    });
    const rejected = new PullRequestOperationError({
      operation: "detail",
      detail: "Bad credentials",
    });
    expect(
      describePullRequestFailure({ failure: rejected, message: rejected.message, number: 9 }),
    ).toEqual({ title: "Could not load this pull request", message: "Bad credentials" });
  });
});
