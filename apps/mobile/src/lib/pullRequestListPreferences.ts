import type { PullRequestInvolvement, PullRequestListState } from "@t3tools/contracts";

export interface PullRequestListPreferences {
  readonly state?: PullRequestListState;
  readonly involvement?: PullRequestInvolvement;
  readonly sort?: "updated" | "stale" | "newest" | "oldest";
  readonly environmentId?: string;
  readonly projectId?: string;
}

/** Ignore invalid saved selections without losing the other preferences. */
export function sanitizePullRequestListPreferences(value: unknown): PullRequestListPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: {
    state?: PullRequestListState;
    involvement?: PullRequestInvolvement;
    sort?: PullRequestListPreferences["sort"];
    environmentId?: string;
    projectId?: string;
  } = {};
  if (
    "state" in value &&
    (value.state === "open" ||
      value.state === "closed" ||
      value.state === "merged" ||
      value.state === "all")
  )
    result.state = value.state;
  if (
    "involvement" in value &&
    (value.involvement === "all" ||
      value.involvement === "authored" ||
      value.involvement === "reviewing")
  )
    result.involvement = value.involvement;
  if (
    "sort" in value &&
    (value.sort === "updated" ||
      value.sort === "stale" ||
      value.sort === "newest" ||
      value.sort === "oldest")
  )
    result.sort = value.sort;
  if (
    "environmentId" in value &&
    typeof value.environmentId === "string" &&
    value.environmentId.length > 0
  )
    result.environmentId = value.environmentId;
  if ("projectId" in value && typeof value.projectId === "string" && value.projectId.length > 0)
    result.projectId = value.projectId;
  return result;
}
