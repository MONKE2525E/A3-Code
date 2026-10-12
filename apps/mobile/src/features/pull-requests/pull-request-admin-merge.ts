import type { PullRequestMergeMethod } from "@t3tools/contracts";

/**
 * Admin merge is not a host action the upstream server offers, so the phone types the GitHub CLI
 * command into a short-lived terminal on the environment instead. Everything typed there is built
 * here, from values checked against what GitHub allows, so nothing a pull request says can reach
 * the shell.
 */

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d+)?$/;

/** Split so the line the shell echoes back never contains the marker it prints. */
const EXIT_MARKER_HEAD = "__T3_ADMIN_MERGE";
const EXIT_MARKER_TAIL = "_EXIT";
const EXIT_MARKER_PATTERN = new RegExp(`${EXIT_MARKER_HEAD}${EXIT_MARKER_TAIL}:(\\d+)`);

export const ADMIN_MERGE_TERMINAL_THREAD_ID = "t3-mobile-pr-admin-merge";

/** Keeps `gh` from prompting, paging or colouring what the phone has to read back. */
export const ADMIN_MERGE_TERMINAL_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_PAGER: "cat",
  NO_COLOR: "1",
  CLICOLOR: "0",
} as const;

export interface AdminMergeTarget {
  readonly repository: string;
  readonly number: number;
  readonly host?: string | undefined;
  readonly method: PullRequestMergeMethod;
}

/**
 * The line typed into the terminal, or null when the target is not something the CLI can name
 * safely. `exec sh -c` makes the result independent of the user's own shell (bash, zsh, fish),
 * and the shell exits with it, so the terminal never lingers at a prompt.
 */
export function adminMergeShellCommand(target: AdminMergeTarget): string | null {
  if (!REPOSITORY_PATTERN.test(target.repository)) return null;
  if (!Number.isSafeInteger(target.number) || target.number <= 0) return null;
  const host = target.host?.toLowerCase();
  if (host !== undefined && !HOST_PATTERN.test(host)) return null;
  const repository =
    host && host !== "github.com" ? `${host}/${target.repository}` : target.repository;
  const merge = `gh pr merge ${target.number} --repo ${repository} --${target.method} --admin`;
  const report = `printf "\\n%s%s:%d\\n" ${EXIT_MARKER_HEAD} ${EXIT_MARKER_TAIL} $?`;
  return `exec sh -c '${merge}; ${report}'\r`;
}

export type AdminMergeOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "merged" }
  | { readonly kind: "failed"; readonly exitCode: number; readonly message: string };

// oxlint-disable-next-line no-control-regex -- terminal output carries ANSI escapes to strip
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

/**
 * Reads the terminal's output so far. The CLI's own words are the lines between the echoed
 * command and the exit marker; the last few of them are the failure a reader needs.
 */
export function readAdminMergeOutput(output: string): AdminMergeOutcome {
  // A lone carriage return redraws the line, as a spinner does; read it as a new line.
  const clean = output.replace(ANSI_PATTERN, "").replace(/\r\n?/g, "\n");
  const match = EXIT_MARKER_PATTERN.exec(clean);
  if (!match) return { kind: "running" };
  const exitCode = Number(match[1]);
  if (exitCode === 0) return { kind: "merged" };
  const before = clean.slice(0, match.index);
  const commandAt = before.lastIndexOf("gh pr merge");
  const afterCommand =
    commandAt === -1 ? before : before.slice(before.indexOf("\n", commandAt) + 1);
  const lines = afterCommand
    .split("\n")
    .map((line) => line.trim())
    // `gh` draws a "Working..." spinner while it waits on the host; it says nothing on failure.
    .filter((line) => line.length > 0 && !/^working\.*$/i.test(line));
  return {
    kind: "failed",
    exitCode,
    message:
      lines.slice(-4).join("\n") ||
      (exitCode === 127
        ? "The GitHub CLI (gh) is not installed on this environment."
        : `gh exited with code ${exitCode}.`),
  };
}
