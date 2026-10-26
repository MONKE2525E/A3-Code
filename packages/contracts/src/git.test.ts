import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsCreateWorktreeResult,
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
} from "./git.ts";

const decodeCreateWorktreeResult = Schema.decodeUnknownSync(VcsCreateWorktreeResult);

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toContain("Git command failed");
  });
});

describe("VcsCreateWorktreeResult", () => {
  it("retains the original tip for safe rollback and accepts legacy results", () => {
    const worktree = { path: "/tmp/worktree", refName: "feature-2" };
    expect(decodeCreateWorktreeResult({ worktree }).createdBranch).toBeUndefined();
    expect(
      decodeCreateWorktreeResult({
        worktree,
        createdBranch: { commitSha: "original-tip" },
      }).createdBranch,
    ).toEqual({ commitSha: "original-tip" });
    expect(() => decodeCreateWorktreeResult({ worktree, createdBranch: true })).toThrow();
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("GitRunStackedActionInput", () => {
  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});
