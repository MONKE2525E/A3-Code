import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import {
  openOnHostLabel,
  PULL_REQUEST_MERGE_METHOD_LABELS,
  pullRequestHandoffLabels,
  resolvePullRequestPrimaryControl,
} from "@t3tools/shared/pullRequestHandoff";

import type { AppSymbolName } from "../../components/AppSymbol";
import { summarizePullRequestChecks, type PullRequestChecksTone } from "./pull-request-model";

/** The desktop's checks rollup: failures first, then anything still waiting, then a pass. */
function checksState(checks: PullRequestDetail["checks"]) {
  if (checks.length === 0) return null;
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing" as const;
  if (statuses.has("pending") || statuses.has("action-required")) return "pending" as const;
  return statuses.has("success") ? ("passing" as const) : null;
}

export type PullRequestMenuCommand =
  | { readonly kind: "link"; readonly linked: boolean }
  | { readonly kind: "refresh" }
  | { readonly kind: "ask" }
  | { readonly kind: "explain" }
  | { readonly kind: "fix-findings" }
  | { readonly kind: "action"; readonly action: PullRequestAction }
  | { readonly kind: "merge"; readonly method: PullRequestMergeMethod }
  | { readonly kind: "admin-merge"; readonly method: PullRequestMergeMethod }
  | { readonly kind: "select-merge-method"; readonly method: PullRequestMergeMethod }
  | { readonly kind: "enable-auto-merge"; readonly method: PullRequestMergeMethod }
  | { readonly kind: "resolve-conflicts" }
  | { readonly kind: "open-host" }
  | { readonly kind: "copy-link" }
  | { readonly kind: "copy-number" };

export interface PullRequestMenuItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly icon: AppSymbolName;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** Marks the chosen option in a single-choice group, such as the merge strategy. */
  readonly checked?: boolean;
  readonly command: PullRequestMenuCommand;
}

/** The pull request state the menu reads; the detail plus what the screen knows around it. */
export interface PullRequestMenuInput {
  readonly detail: Pick<
    PullRequestDetail,
    | "state"
    | "isDraft"
    | "mergeability"
    | "autoMergeEnabled"
    | "autoMergeMethod"
    | "capabilities"
    | "viewerPermissions"
    | "mergeCapabilities"
    | "checks"
    | "provider"
  > &
    Partial<Pick<PullRequestDetail, "baseComparison" | "behindBy" | "baseBranch">>;
  /** The thread the viewer was opened from, or null when opened from the pull request list. */
  readonly thread: { readonly linked: boolean; readonly canLink: boolean } | null;
  /** False while a stacked pull request's stack is unknown, or when it belongs to one. */
  readonly canMergeSingle: boolean;
  readonly mergeMethod: PullRequestMergeMethod;
  /** Whether this client can run `gh pr merge --admin` on the environment. */
  readonly canAdminMerge?: boolean;
  readonly refreshing: boolean;
  readonly actionPending: boolean;
  readonly handoffPending: boolean;
}

/** The merge strategies the host offers that this repository also allows. */
export function allowedMergeMethods(
  detail: Pick<PullRequestDetail, "capabilities" | "mergeCapabilities">,
): PullRequestMergeMethod[] {
  return detail.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method]);
}

const MERGE_METHOD_SUBTITLES: Record<PullRequestMergeMethod, string> = {
  merge: "Keeps every commit and adds a merge commit.",
  squash: "Combines every commit into one.",
  rebase: "Replays each commit onto the base branch.",
};

function hostActions(detail: PullRequestMenuInput["detail"]) {
  return (action: PullRequestAction) =>
    detail.capabilities.actions.includes(action) &&
    detail.viewerPermissions.actions.includes(action);
}

/**
 * The three-dot menu, grouped where the desktop menu draws separators: hand-offs to an agent,
 * the draft toggle, sharing, then the one lifecycle change the state allows. Merging lives in
 * the merge box's own split button, as it does beside the desktop header's Merge pill.
 */
export function pullRequestMenuGroups(input: PullRequestMenuInput): PullRequestMenuItem[][] {
  const { detail } = input;
  const can = hostActions(detail);
  const open = detail.state === "open";
  const handoffLabels = pullRequestHandoffLabels(input.thread !== null);
  const busy = input.actionPending;

  const agent: PullRequestMenuItem[] = [];
  if (input.thread && (input.thread.linked || input.thread.canLink)) {
    agent.push({
      id: "link",
      title: input.thread.linked ? "Unlink from this thread" : "Link to this thread",
      icon: input.thread.linked ? "pin.slash" : "link",
      disabled: busy,
      command: { kind: "link", linked: input.thread.linked },
    });
  }
  agent.push(
    {
      id: "refresh",
      title: "Refresh",
      icon: "arrow.clockwise",
      disabled: input.refreshing,
      command: { kind: "refresh" },
    },
    {
      id: "ask",
      title: "Ask a question",
      subtitle: input.thread
        ? "Adds the pull request to this thread's composer."
        : "Opens a thread that knows which pull request you mean.",
      icon: "text.bubble",
      disabled: input.handoffPending || busy,
      command: { kind: "ask" },
    },
    {
      id: "explain",
      title: "Explain this PR",
      subtitle: "A walk through the diff and what to read closely.",
      icon: "doc.text",
      disabled: input.handoffPending || busy,
      command: { kind: "explain" },
    },
    {
      id: "fix-findings",
      title: handoffLabels.fixFindings,
      icon: "hammer",
      disabled: input.handoffPending || busy,
      command: { kind: "fix-findings" },
    },
  );

  const actions: PullRequestMenuItem[] = [];
  if (open && can(detail.isDraft ? "ready" : "draft")) {
    actions.push({
      id: "draft",
      title: detail.isDraft ? "Ready for review" : "Convert to draft",
      icon: detail.isDraft ? "eye" : "doc",
      disabled: busy,
      command: { kind: "action", action: detail.isDraft ? "ready" : "draft" },
    });
  }

  const share: PullRequestMenuItem[] = [
    {
      id: "open-host",
      title: openOnHostLabel(detail.provider),
      icon: "safari",
      command: { kind: "open-host" },
    },
    { id: "copy-link", title: "Copy link", icon: "link", command: { kind: "copy-link" } },
    {
      id: "copy-number",
      title: "Copy PR number",
      icon: "doc.on.doc",
      command: { kind: "copy-number" },
    },
  ];

  const lifecycle: PullRequestMenuItem[] = [];
  if (open && can("close")) {
    lifecycle.push({
      id: "close",
      title: "Close pull request",
      icon: "xmark.circle",
      destructive: true,
      disabled: busy,
      command: { kind: "action", action: "close" },
    });
  } else if (detail.state === "closed" && can("reopen")) {
    lifecycle.push({
      id: "reopen",
      title: "Reopen pull request",
      icon: "arrow.uturn.backward",
      disabled: busy,
      command: { kind: "action", action: "reopen" },
    });
  } else if (detail.state === "merged" && can("revert")) {
    lifecycle.push({
      id: "revert",
      title: "Revert changes",
      icon: "arrow.uturn.backward",
      disabled: busy,
      command: { kind: "action", action: "revert" },
    });
  }

  return [agent, actions, share, lifecycle].filter((group) => group.length > 0);
}

export type PullRequestMergeTone = PullRequestChecksTone | "merged" | "closed" | "draft";

/** The merge box: where the pull request stands, the one button that moves it, and the rest. */
export interface PullRequestMergeBox {
  readonly tone: PullRequestMergeTone;
  readonly title: string;
  readonly detail: string | null;
  readonly primary: {
    readonly label: string;
    readonly icon: AppSymbolName;
    readonly command: PullRequestMenuCommand;
    readonly disabled: boolean;
  } | null;
  /** The split button's dropdown: strategy, admin merge, auto-merge and branch upkeep. */
  readonly options: ReadonlyArray<PullRequestMenuItem>;
}

/**
 * The desktop header's merge area, laid out as a phone-width box. The primary control is the
 * shared resolver's, so the phone and the desktop never disagree about whether this is a merge,
 * a ready-for-review, a conflict to resolve or an auto-merge to arm. Admin merge is offered only
 * on GitHub, only where a normal merge would be (open, not a draft, no conflicts, not stacked),
 * and only where the client can reach a terminal on the environment to run the CLI.
 */
export function pullRequestMergeBox(input: PullRequestMenuInput): PullRequestMergeBox {
  const { detail } = input;
  const can = hostActions(detail);
  const methods = allowedMergeMethods(detail);
  const method = input.mergeMethod;
  const methodLabel = PULL_REQUEST_MERGE_METHOD_LABELS[method];
  const busy = input.actionPending;
  const checks = summarizePullRequestChecks(detail.checks);
  const primaryControl = resolvePullRequestPrimaryControl({
    state: detail.state,
    isDraft: detail.isDraft,
    mergeability: detail.mergeability,
    checksState: checksState(detail.checks),
    autoMergeEnabled: detail.autoMergeEnabled,
    hasMergeMethod: methods.length > 0,
    canMerge: input.canMergeSingle && can("merge"),
    canMarkReady: can("ready"),
    canEnableAutoMerge: input.canMergeSingle && can("enable-auto-merge"),
  });

  if (detail.state === "merged") {
    return { tone: "merged", title: "Merged", detail: null, primary: null, options: [] };
  }
  if (detail.state === "closed") {
    return {
      tone: "closed",
      title: "Closed without merging",
      detail: null,
      primary: null,
      options: [],
    };
  }

  const conflicting = detail.mergeability === "conflicting";
  const behind = detail.baseComparison === "behind";
  const behindLabel = behind
    ? detail.behindBy
      ? `${detail.behindBy} ${detail.behindBy === 1 ? "commit" : "commits"} behind ${detail.baseBranch ?? "the base"}`
      : `Behind ${detail.baseBranch ?? "the base"}`
    : null;
  const facts = [
    checks.tone === "none" ? null : checks.label,
    conflicting
      ? null
      : detail.mergeability === "mergeable"
        ? "No conflicts"
        : "Checking for conflicts",
    behindLabel,
  ].filter((fact): fact is string => fact !== null);

  const status: Pick<PullRequestMergeBox, "tone" | "title" | "detail"> = detail.isDraft
    ? { tone: "draft", title: "Draft", detail: "Mark it ready for review before merging." }
    : conflicting
      ? {
          tone: "failure",
          title: "Merge conflicts",
          detail: `Conflicts with ${detail.baseBranch ?? "the base branch"} must be resolved first.`,
        }
      : detail.autoMergeEnabled === true
        ? {
            tone: "pending",
            title: "Auto-merge enabled",
            detail: `Merges with ${PULL_REQUEST_MERGE_METHOD_LABELS[detail.autoMergeMethod ?? method].toLowerCase()} once every requirement passes.`,
          }
        : checks.tone === "failure"
          ? { tone: "failure", title: "Checks failing", detail: facts.join(" · ") }
          : checks.tone === "pending"
            ? { tone: "pending", title: "Checks running", detail: facts.join(" · ") }
            : detail.mergeability === "mergeable"
              ? { tone: "success", title: "Ready to merge", detail: facts.join(" · ") || null }
              : { tone: "none", title: "Checking mergeability", detail: facts.join(" · ") || null };

  const primary: PullRequestMergeBox["primary"] =
    primaryControl === "merge"
      ? {
          label: methodLabel,
          icon: "arrow.triangle.merge",
          command: { kind: "merge", method },
          disabled: busy,
        }
      : primaryControl === "enable-auto-merge"
        ? {
            label: "Enable auto-merge",
            icon: "bolt.circle",
            command: { kind: "enable-auto-merge", method },
            disabled: busy,
          }
        : primaryControl === "ready"
          ? {
              label: "Ready for review",
              icon: "eye",
              command: { kind: "action", action: "ready" },
              disabled: busy,
            }
          : primaryControl === "resolve"
            ? {
                label: "Resolve conflicts",
                icon: "hammer",
                command: { kind: "resolve-conflicts" },
                disabled: busy || input.handoffPending,
              }
            : null;

  const mergeable = input.canMergeSingle && !detail.isDraft && !conflicting;
  const options: PullRequestMenuItem[] = [];
  if (mergeable && methods.length > 1 && (can("merge") || can("enable-auto-merge"))) {
    for (const option of methods) {
      options.push({
        id: `method:${option}`,
        title: PULL_REQUEST_MERGE_METHOD_LABELS[option],
        subtitle: MERGE_METHOD_SUBTITLES[option],
        icon: "arrow.triangle.merge",
        checked: option === method,
        command: { kind: "select-merge-method", method: option },
      });
    }
  }
  if (primaryControl === "enable-auto-merge" && mergeable && can("merge")) {
    options.push({
      id: "merge-now",
      title: "Merge now",
      subtitle: `${methodLabel}, without waiting for checks.`,
      icon: "arrow.triangle.merge",
      disabled: busy,
      command: { kind: "merge", method },
    });
  }
  if (
    mergeable &&
    methods.length > 0 &&
    input.canAdminMerge === true &&
    detail.provider === "github"
  ) {
    options.push({
      id: "admin-merge",
      title: "Merge as admin",
      subtitle: `${methodLabel}, bypassing branch protection.`,
      icon: "lock.shield",
      disabled: busy,
      command: { kind: "admin-merge", method },
    });
  }
  if (detail.autoMergeEnabled === true && input.canMergeSingle && can("disable-auto-merge")) {
    options.push({
      id: "disable-auto-merge",
      title: "Disable auto-merge",
      icon: "bolt.slash",
      disabled: busy,
      command: { kind: "action", action: "disable-auto-merge" },
    });
  }
  if (behind && can("update-branch")) {
    options.push({
      id: "update-branch",
      title: "Update branch",
      subtitle: behindLabel ?? undefined,
      icon: "arrow.triangle.2.circlepath",
      disabled: busy,
      command: { kind: "action", action: "update-branch" },
    });
  }

  return { ...status, primary, options };
}

/**
 * What to ask before a host action that cannot be taken back from here, worded as the desktop
 * dialog words it. Null for the actions the desktop runs on the press.
 */
export function pullRequestActionConfirmation(
  command: PullRequestMenuCommand,
  number: number,
): { title: string; message: string; confirmText: string; destructive: boolean } | null {
  switch (command.kind) {
    case "merge":
      return {
        title: "Merge pull request?",
        message: `This merges #${number} using ${command.method}.`,
        confirmText: PULL_REQUEST_MERGE_METHOD_LABELS[command.method],
        destructive: false,
      };
    case "admin-merge":
      return {
        title: "Merge as admin?",
        message: `This merges #${number} using ${command.method} and bypasses branch protection, including required checks and reviews. It runs the GitHub CLI on your environment as you.`,
        confirmText: "Merge as admin",
        destructive: true,
      };
    case "enable-auto-merge":
      return {
        title: "Enable auto-merge?",
        message: `This merges #${number} using ${command.method} as soon as the host considers it ready, which may be immediately.`,
        confirmText: "Enable auto-merge",
        destructive: false,
      };
    case "action":
      if (command.action === "close")
        return {
          title: "Close pull request?",
          message: `This closes #${number} without merging it.`,
          confirmText: "Close",
          destructive: true,
        };
      if (command.action === "revert")
        return {
          title: "Revert these changes?",
          message: `This opens a new pull request that reverses the changes merged by #${number}.`,
          confirmText: "Create revert PR",
          destructive: false,
        };
      return null;
    default:
      return null;
  }
}
