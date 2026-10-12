import { describe, expect, it } from "vite-plus/test";

import { adminMergeShellCommand, readAdminMergeOutput } from "./pull-request-admin-merge";

describe("adminMergeShellCommand", () => {
  it("merges with the chosen strategy, bypassing branch protection", () => {
    expect(adminMergeShellCommand({ repository: "acme/app", number: 42, method: "squash" })).toBe(
      `exec sh -c 'gh pr merge 42 --repo acme/app --squash --admin; printf "\\n%s%s:%d\\n" __T3_ADMIN_MERGE _EXIT $?'\r`,
    );
  });

  it("names an Enterprise host, and leaves github.com implied", () => {
    expect(
      adminMergeShellCommand({
        repository: "acme/app",
        number: 7,
        method: "merge",
        host: "GitHub.example.com",
      }),
    ).toContain("--repo github.example.com/acme/app --merge");
    expect(
      adminMergeShellCommand({
        repository: "acme/app",
        number: 7,
        method: "rebase",
        host: "github.com",
      }),
    ).toContain("--repo acme/app --rebase");
  });

  it("refuses anything that could escape the quoted command", () => {
    expect(
      adminMergeShellCommand({ repository: "acme/app'; rm -rf ~", number: 1, method: "merge" }),
    ).toBe(null);
    expect(
      adminMergeShellCommand({ repository: "acme/app", number: 1, method: "merge", host: "a b" }),
    ).toBe(null);
    expect(adminMergeShellCommand({ repository: "acme/app", number: 1.5, method: "merge" })).toBe(
      null,
    );
  });
});

describe("readAdminMergeOutput", () => {
  const echoed = `~/code/app $ exec sh -c 'gh pr merge 42 --repo acme/app --squash --admin; printf "\\n%s%s:%d\\n" __T3_ADMIN_MERGE _EXIT $?'\r\n`;

  it("keeps waiting until the exit marker arrives, even though the echo names it", () => {
    expect(readAdminMergeOutput(echoed)).toEqual({ kind: "running" });
  });

  it("reports a merge on a zero exit", () => {
    expect(
      readAdminMergeOutput(
        `${echoed}\u001b[32m✓\u001b[0m Squashed and merged pull request #42\r\n\r\n__T3_ADMIN_MERGE_EXIT:0\r\n`,
      ),
    ).toEqual({ kind: "merged" });
  });

  it("carries the CLI's own failure, without the echoed command", () => {
    expect(
      readAdminMergeOutput(
        `${echoed}GraphQL: You're not authorized to push to this branch.\r\n\r\n__T3_ADMIN_MERGE_EXIT:1\r\n`,
      ),
    ).toEqual({
      kind: "failed",
      exitCode: 1,
      message: "GraphQL: You're not authorized to push to this branch.",
    });
  });

  it("drops the CLI's progress spinner from the failure", () => {
    expect(
      readAdminMergeOutput(
        `${echoed}Working...\rGraphQL: MONKE2525E does not have the correct permissions to execute \`MergePullRequest\`\r\n__T3_ADMIN_MERGE_EXIT:1\r\n`,
      ),
    ).toMatchObject({
      message:
        "GraphQL: MONKE2525E does not have the correct permissions to execute `MergePullRequest`",
    });
  });

  it("explains a missing CLI", () => {
    expect(readAdminMergeOutput(`${echoed}\r\n__T3_ADMIN_MERGE_EXIT:127\r\n`)).toMatchObject({
      kind: "failed",
      message: "The GitHub CLI (gh) is not installed on this environment.",
    });
  });
});
