import * as Schema from "effect/Schema";

import { PullRequestOperationError } from "@t3tools/contracts";

const isPullRequestOperationError = Schema.is(PullRequestOperationError);

export function isPullRequestNotFound(failure: unknown): boolean {
  return isPullRequestOperationError(failure) && failure.reason === "not-found";
}

/**
 * The internal wrapper every failed operation arrives in: which operation ran, and which tool
 * said no. A reader has no use for either.
 */
const OPERATION_PREFIX = /^Pull request operation \w+ failed:\s*/iu;

/**
 * Sentences that report only that a tool exited: true, and no help at all. Anything else the
 * host says is worth more than what this page could invent, so only these are replaced.
 */
const TOOL_NOISE = [
  /^(github|gitlab|bitbucket|azure devops)?\s*(cli|api)?\s*(command\s*)?failed\.?$/iu,
  /^exited? with (code|status) \d+\.?$/iu,
  /^unknown error\.?$/iu,
];

/** How much of a host's own message a toast can carry before it stops being read. */
const FAILURE_DETAIL_MAX_LENGTH = 320;

/**
 * What to put under a failed action. The host's own sentence when it said something — it knows
 * why, and this page does not — and otherwise what to go and check, because "the command failed"
 * leaves the reader pressing the same button again.
 */
export function readableFailure(failure: unknown, hint: string): string {
  const raw =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  const detail = raw.replace(OPERATION_PREFIX, "").trim();
  if (detail.length === 0 || TOOL_NOISE.some((pattern) => pattern.test(detail))) return hint;
  const bounded =
    detail.length <= FAILURE_DETAIL_MAX_LENGTH
      ? detail
      : `${detail.slice(0, FAILURE_DETAIL_MAX_LENGTH - 1)}…`;
  // The host's words alone: the hint is a guess about why, and a guess printed under a reason
  // that contradicts it is worse than no guess at all.
  return bounded;
}
