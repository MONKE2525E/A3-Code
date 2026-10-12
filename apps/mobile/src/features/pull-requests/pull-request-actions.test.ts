import { SourceControlProviderKind } from "@t3tools/contracts";
import type { PullRequestAction } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestActionConfirmation,
  pullRequestMenuGroups,
  pullRequestMergeBox,
  type PullRequestMenuInput,
} from "./pull-request-actions";

const ALL: PullRequestAction[] = [
  "merge",
  "ready",
  "draft",
  "close",
  "reopen",
  "revert",
  "enable-auto-merge",
  "disable-auto-merge",
  "update-branch",
];

function input(
  detail: Partial<PullRequestMenuInput["detail"]> = {},
  rest: Partial<Omit<PullRequestMenuInput, "detail">> = {},
): PullRequestMenuInput {
  return {
    detail: {
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      autoMergeEnabled: false,
      checks: [],
      provider: SourceControlProviderKind.make("github"),
      mergeCapabilities: { merge: true, squash: true, rebase: false },
      capabilities: { mergeMethods: ["merge", "squash", "rebase"], actions: ALL },
      viewerPermissions: { actions: ALL },
      ...detail,
    } as PullRequestMenuInput["detail"],
    thread: null,
    canMergeSingle: true,
    mergeMethod: "squash",
    refreshing: false,
    actionPending: false,
    handoffPending: false,
    ...rest,
  };
}

const ids = (value: PullRequestMenuInput) =>
  pullRequestMenuGroups(value)
    .flat()
    .map((i) => i.id);

describe("pullRequestMenuGroups", () => {
  it("leaves merging to the merge box and keeps hand-offs, draft, sharing and close", () => {
    expect(ids(input())).toEqual([
      "refresh",
      "ask",
      "explain",
      "fix-findings",
      "draft",
      "open-host",
      "copy-link",
      "copy-number",
      "close",
    ]);
  });

  it("offers the reverse of each terminal state the host allows", () => {
    expect(ids(input({ isDraft: true }))).toContain("draft");
    expect(
      pullRequestMenuGroups(input({ isDraft: true }))
        .flat()
        .find((item) => item.id === "draft")?.title,
    ).toBe("Ready for review");
    expect(ids(input({ state: "closed" }))).toContain("reopen");
    expect(ids(input({ state: "merged" }))).toContain("revert");
    expect(ids(input({ state: "merged" }))).not.toContain("close");
  });

  it("acts on the originating thread and names it, and offers nothing to unlink outside one", () => {
    const inThread = pullRequestMenuGroups(
      input({}, { thread: { linked: true, canLink: true } }),
    ).flat();
    expect(inThread[0]).toMatchObject({ id: "link", title: "Unlink from this thread" });
    expect(inThread.find((item) => item.id === "fix-findings")?.title).toBe(
      "Fix findings in this thread",
    );
    const outside = pullRequestMenuGroups(input()).flat();
    expect(outside.some((item) => item.id === "link")).toBe(false);
    expect(outside.find((item) => item.id === "fix-findings")?.title).toBe(
      "Fix findings in a thread",
    );
  });

  it("disables host actions while one is pending", () => {
    const items = pullRequestMenuGroups(input({}, { actionPending: true })).flat();
    expect(items.find((item) => item.id === "close")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "copy-link")?.disabled).toBeUndefined();
  });
});

describe("pullRequestMergeBox", () => {
  const optionIds = (value: PullRequestMenuInput) =>
    pullRequestMergeBox(value).options.map((option) => option.id);

  it("merges with the chosen strategy and offers the others in the dropdown", () => {
    const box = pullRequestMergeBox(input());
    expect(box).toMatchObject({
      tone: "success",
      title: "Ready to merge",
      primary: { label: "Squash and merge", command: { kind: "merge", method: "squash" } },
    });
    expect(box.options.filter((option) => option.checked).map((option) => option.id)).toEqual([
      "method:squash",
    ]);
    expect(optionIds(input())).toEqual(["method:merge", "method:squash"]);
  });

  it("offers admin merge on GitHub wherever a normal merge would be", () => {
    const admin = (value: PullRequestMenuInput) =>
      pullRequestMergeBox(value).options.find((option) => option.id === "admin-merge");
    expect(admin(input({}, { canAdminMerge: true }))?.command).toEqual({
      kind: "admin-merge",
      method: "squash",
    });
    expect(admin(input())).toBeUndefined();
    expect(
      admin(input({ provider: SourceControlProviderKind.make("gitlab") }, { canAdminMerge: true })),
    ).toBeUndefined();
    expect(admin(input({ isDraft: true }, { canAdminMerge: true }))).toBeUndefined();
    expect(admin(input({ mergeability: "conflicting" }, { canAdminMerge: true }))).toBeUndefined();
    expect(admin(input({}, { canAdminMerge: true, canMergeSingle: false }))).toBeUndefined();
  });

  it("follows the desktop's primary control through drafts, conflicts and running checks", () => {
    expect(pullRequestMergeBox(input({ isDraft: true })).primary?.label).toBe("Ready for review");
    expect(pullRequestMergeBox(input({ mergeability: "conflicting" }))).toMatchObject({
      tone: "failure",
      title: "Merge conflicts",
      primary: { command: { kind: "resolve-conflicts" } },
    });
    const running = input({
      checks: [{ name: "ci", status: "pending", description: null, url: null }],
    } as never);
    expect(pullRequestMergeBox(running)).toMatchObject({
      tone: "pending",
      primary: { command: { kind: "enable-auto-merge", method: "squash" } },
    });
    expect(optionIds(running)).toContain("merge-now");
  });

  it("offers the way back out of an armed auto-merge and a stale branch", () => {
    expect(optionIds(input({ autoMergeEnabled: true }))).toContain("disable-auto-merge");
    expect(pullRequestMergeBox(input({ autoMergeEnabled: true })).title).toBe("Auto-merge enabled");
    const stale = pullRequestMergeBox(
      input({ baseComparison: "behind", behindBy: 3, baseBranch: "main" }),
    );
    expect(stale.options.find((option) => option.id === "update-branch")?.subtitle).toBe(
      "3 commits behind main",
    );
  });

  it("shows only the outcome once the pull request is merged or closed", () => {
    expect(pullRequestMergeBox(input({ state: "merged" }))).toMatchObject({
      tone: "merged",
      primary: null,
      options: [],
    });
    expect(pullRequestMergeBox(input({ state: "closed" })).title).toBe("Closed without merging");
  });
});

describe("pullRequestActionConfirmation", () => {
  it("confirms merges, close and revert, and runs draft changes directly", () => {
    expect(pullRequestActionConfirmation({ kind: "merge", method: "squash" }, 7)).toMatchObject({
      confirmText: "Squash and merge",
      message: "This merges #7 using squash.",
    });
    expect(pullRequestActionConfirmation({ kind: "action", action: "close" }, 7)?.destructive).toBe(
      true,
    );
    expect(pullRequestActionConfirmation({ kind: "action", action: "revert" }, 7)).not.toBeNull();
    expect(pullRequestActionConfirmation({ kind: "action", action: "draft" }, 7)).toBeNull();
  });
});
