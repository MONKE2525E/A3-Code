import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestActivity,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  planThreadPullRequestMutation,
  threadPullRequestLinkMode,
} from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
  matchesLinkedPullRequestUrl,
  parseChangeRequestUrl,
} from "@t3tools/shared/changeRequestUrl";
import { readableFailure } from "@t3tools/shared/pullRequestFailure";
import {
  buildAskAboutPullRequestHandoff,
  buildExplainPullRequestHandoff,
  buildFixFindingsHandoff,
  PULL_REQUEST_ACTION_FAILURE_HINTS,
  PULL_REQUEST_ACTION_FAILURE_LABELS,
  PULL_REQUEST_ACTION_SUCCESS_LABELS,
  type FixFindingsHandoff,
} from "@t3tools/shared/pullRequestHandoff";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects, useThreadShell } from "../../state/entities";
import { gitEnvironment } from "../../state/git";
import { pullRequestEnvironment } from "../../state/pull-requests";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  getComposerDraftSnapshot,
  setComposerDraftContext,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { pullRequestActionConfirmation, type PullRequestMenuCommand } from "./pull-request-actions";
import { buildResolveConflictsHandoff, pullRequestHandoffDraft } from "./pull-request-handoff";
import { usePullRequestAdminMerge } from "./usePullRequestAdminMerge";

/** One line under the header saying how the last action went. Failures stay until replaced. */
export interface PullRequestActionStatus {
  readonly tone: "progress" | "success" | "failure";
  readonly title: string;
  readonly detail?: string;
}

/**
 * What each hand-off last wrote into each draft, kept outside React because the viewer that wrote
 * it is closed by the time the next one opens: only that exact sentence may be replaced.
 */
const lastHandoffPromptByDraft = new Map<string, string>();

/**
 * The detail pane's three-dot menu, run the way the desktop panel runs it: host actions through
 * the typed `runAction` command with nothing shown as done until the host says so, and hand-offs
 * written into a composer for the reader to send. Opened from a thread, a hand-off lands in that
 * thread's composer and returns there; opened from the list, it opens a new thread on the
 * project, checked out on the pull request first when the task needs the code.
 */
export function usePullRequestDetailActions(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail | null;
  readonly activity: PullRequestActivity | null;
  readonly originThreadId: ThreadId | null;
  readonly refreshFromHost: () => Promise<void>;
  readonly onSelectMergeMethod: (method: PullRequestMergeMethod) => void;
}) {
  const { environmentId, reference, detail } = input;
  const navigation = useNavigation();
  const projects = useProjects();
  const capabilities = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities,
  );
  const threadRef = input.originThreadId
    ? scopeThreadRef(environmentId, input.originThreadId)
    : null;
  const thread = useThreadShell(threadRef);
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const prepareThread = useAtomCommand(gitEnvironment.preparePullRequestThread, {
    reportFailure: false,
  });
  const adminMerge = usePullRequestAdminMerge(environmentId);
  const [pendingAction, setPendingAction] = useState<PullRequestAction | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [linkPending, setLinkPending] = useState(false);
  const [status, setStatus] = useState<PullRequestActionStatus | null>(null);
  // State alone lets a double tap through before the re-render that disables the row.
  const busy = useRef(false);

  const url = detail?.url ?? null;
  const parsed = url === null ? null : parseChangeRequestUrl(url);
  const linkMode = threadPullRequestLinkMode(capabilities);
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const linkedHere =
    thread !== null &&
    url !== null &&
    (linkMode === "multiple"
      ? parsed !== null &&
        visibleThreadPullRequests(thread.pullRequests ?? []).some((entry) =>
          threadPullRequestKeysEqual(entry, parsed),
        )
      : linkMode === "single" &&
        thread.linkedPullRequest != null &&
        matchesLinkedPullRequestUrl(thread.linkedPullRequest, url));
  const canLinkHere =
    thread !== null &&
    parsed !== null &&
    linkMode !== "unsupported" &&
    (linkMode === "multiple" ? findProjectOnChangeRequestHost : findProjectForChangeRequest)(
      environmentProjects,
      parsed,
    ) !== undefined;

  const changeLink = async (linked: boolean) => {
    if (threadRef === null || url === null || parsed === null || busy.current) return;
    const legacyProject = findProjectForChangeRequest(environmentProjects, parsed);
    const mutation = planThreadPullRequestMutation({
      capabilities,
      threadId: threadRef.threadId,
      reference: { ...parsed, url },
      legacyProjectId: legacyProject?.id ?? null,
      legacyRepository:
        sourceControlRepositorySelector(legacyProject?.repositoryIdentity) ?? undefined,
      linked: !linked,
    });
    if (mutation === null) {
      setStatus({
        tone: "failure",
        title: "This environment does not support linking this pull request.",
      });
      return;
    }
    busy.current = true;
    setLinkPending(true);
    try {
      const result = await (mutation.type === "thread.meta.update"
        ? updateMetadata({ environmentId, input: mutation.input })
        : mutation.type === "thread.pull-request.link"
          ? link({ environmentId, input: mutation.input })
          : unlink({ environmentId, input: mutation.input }));
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const failure = squashAtomCommandFailure(result);
        setStatus({
          tone: "failure",
          title: linked ? "Could not unlink the pull request" : "Could not link the pull request",
          detail: failure instanceof Error ? failure.message : String(failure),
        });
        return;
      }
      setStatus({
        tone: "success",
        title: linked ? "Unlinked from this thread" : "Linked to this thread",
      });
    } finally {
      busy.current = false;
      setLinkPending(false);
    }
  };

  const perform = async (action: PullRequestAction, mergeMethod?: PullRequestMergeMethod) => {
    if (busy.current) return;
    busy.current = true;
    setPendingAction(action);
    setStatus(null);
    try {
      const result = await runAction({
        environmentId,
        input: { ...reference, action, ...(mergeMethod ? { mergeMethod } : {}) },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        setStatus({
          tone: "failure",
          title: PULL_REQUEST_ACTION_FAILURE_LABELS[action],
          detail: readableFailure(
            squashAtomCommandFailure(result),
            PULL_REQUEST_ACTION_FAILURE_HINTS[action],
          ),
        });
        return;
      }
      setStatus({ tone: "success", title: PULL_REQUEST_ACTION_SUCCESS_LABELS[action] });
      // Every action changes what the host reports, and a merge or branch update moves the
      // diff, so the next read goes around the server cache.
      await input.refreshFromHost();
    } finally {
      busy.current = false;
      setPendingAction(null);
    }
  };

  const performAdminMerge = async (mergeMethod: PullRequestMergeMethod) => {
    if (busy.current || !detail) return;
    busy.current = true;
    setPendingAction("merge");
    setStatus({ tone: "progress", title: "Merging as admin..." });
    try {
      const result = await adminMerge.run(detail, mergeMethod);
      if (result.kind === "failed") {
        setStatus({ tone: "failure", title: "Could not merge as admin", detail: result.message });
        return;
      }
      setStatus({ tone: "success", title: "Merged as admin" });
      await input.refreshFromHost();
    } finally {
      busy.current = false;
      setPendingAction(null);
    }
  };

  /** Leaves the task in a composer and shows it there; nothing is sent. */
  const writeTask = (draftKey: string, task: FixFindingsHandoff) => {
    const draft = getComposerDraftSnapshot(draftKey);
    const next = pullRequestHandoffDraft(draft, task, lastHandoffPromptByDraft.get(draftKey));
    if (next === null) {
      setStatus({
        tone: "failure",
        title: "Too many context items",
        detail: "Remove some context from the draft and try again.",
      });
      return false;
    }
    lastHandoffPromptByDraft.set(draftKey, task.prompt);
    // Context first: setting the text drops any record the text does not reference.
    setComposerDraftContext(draftKey, next.context);
    setComposerDraftText(draftKey, next.text);
    return true;
  };

  const openNewThreadDraft = (
    task: FixFindingsHandoff,
    workspace?: { branch: string; worktreePath: string | null },
  ) => {
    if (!detail) return;
    const draftKey = createNewTaskDraft({ environmentId, projectId: detail.projectId });
    if (workspace) {
      updateComposerDraftSettings(draftKey, {
        workspaceSelection: {
          mode: workspace.worktreePath === null ? "local" : "worktree",
          branch: workspace.branch,
          worktreePath: workspace.worktreePath,
        },
      });
    }
    if (!writeTask(draftKey, task)) return;
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        draftId: draftKey,
        environmentId: String(environmentId),
        projectId: String(detail.projectId),
      },
    });
  };

  /** Into the originating thread's composer, then back to that thread to read it over. */
  const handOffToThread = (task: FixFindingsHandoff) => {
    if (threadRef === null || thread === null) return false;
    if (!writeTask(scopedThreadKey(threadRef.environmentId, threadRef.threadId), task)) return true;
    navigation.dispatch(
      StackActions.popTo("Thread", {
        environmentId: String(threadRef.environmentId),
        threadId: String(threadRef.threadId),
      }),
    );
    return true;
  };

  const handoffInput = detail && {
    number: detail.number,
    title: detail.title,
    url: detail.url,
    headBranch: detail.headBranch,
    baseBranch: detail.baseBranch,
    state: detail.state,
    isDraft: detail.isDraft,
  };

  const ask = (task: FixFindingsHandoff) => {
    if (busy.current || !handoffInput) return;
    if (!handOffToThread(task)) openNewThreadDraft(task);
  };

  const fixFindings = () => {
    if (busy.current || !detail || !handoffInput) return;
    return handOffWithCheckout(
      "findings",
      buildFixFindingsHandoff({
        ...handoffInput,
        reviewThreads: input.activity?.reviewThreads ?? [],
        comments: input.activity?.comments ?? [],
        checks: detail.checks,
        commentsTruncated: input.activity?.commentsTruncated ?? true,
      }),
    );
  };

  /** A task that needs the code: into this thread, or a new thread on a fresh checkout. */
  const handOffWithCheckout = async (kind: string, task: FixFindingsHandoff) => {
    if (busy.current || !detail) return;
    if (handOffToThread(task)) return;
    // Outside a thread the agent needs the code: check the pull request out into its own
    // worktree first, as the desktop does, so the new thread starts on the pull request.
    busy.current = true;
    setHandoff(kind);
    try {
      setStatus({ tone: "progress", title: "Preparing the pull request checkout..." });
      const prepared = await prepareThread({
        environmentId,
        input: { cwd: detail.workspaceRoot, reference: detail.url, mode: "worktree" },
      });
      if (prepared._tag === "Failure") {
        const failure = squashAtomCommandFailure(prepared);
        setStatus({
          tone: "failure",
          title: "Could not prepare the pull request checkout",
          ...(failure instanceof Error ? { detail: failure.message } : {}),
        });
        return;
      }
      setStatus(
        prepared.value.isOnPullRequestHead
          ? null
          : {
              tone: "failure",
              title: "Checked out, but not on the latest commits",
              detail:
                "Uncommitted work or local commits kept the checkout where it was, so the code there is older than the pull request.",
            },
      );
      if (!prepared.value.isOnPullRequestHead) return;
      openNewThreadDraft(task, {
        branch: prepared.value.branch,
        worktreePath: prepared.value.worktreePath,
      });
    } finally {
      busy.current = false;
      setHandoff(null);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await Clipboard.setStringAsync(value);
      setStatus({ tone: "success", title: `${label} copied` });
    } catch (error) {
      setStatus({
        tone: "failure",
        title: `Could not copy the ${label.toLowerCase()}`,
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  };

  const run = (command: PullRequestMenuCommand) => {
    if (!detail || !handoffInput) return;
    const execute = () => {
      switch (command.kind) {
        case "link":
          return void changeLink(command.linked);
        case "refresh":
          return void input.refreshFromHost();
        case "ask":
          return ask(buildAskAboutPullRequestHandoff(handoffInput));
        case "explain":
          return ask(buildExplainPullRequestHandoff(handoffInput));
        case "fix-findings":
          return void fixFindings();
        case "action":
          return void perform(command.action);
        case "merge":
          return void perform("merge", command.method);
        case "admin-merge":
          return void performAdminMerge(command.method);
        case "select-merge-method":
          return input.onSelectMergeMethod(command.method);
        case "enable-auto-merge":
          return void perform("enable-auto-merge", command.method);
        case "resolve-conflicts":
          return void handOffWithCheckout(
            "conflicts",
            buildResolveConflictsHandoff({
              number: detail.number,
              url: detail.url,
              headBranch: detail.headBranch,
              baseBranch: detail.baseBranch,
            }),
          );
        case "open-host":
          return void tryOpenExternalUrl(detail.url, "pull-request");
        case "copy-link":
          return void copy(detail.url, "PR link");
        case "copy-number":
          return void copy(`#${detail.number}`, "PR number");
      }
    };
    const confirmation = pullRequestActionConfirmation(command, detail.number);
    if (confirmation === null) return execute();
    showConfirmDialog({ ...confirmation, cancelText: "Cancel", onConfirm: execute });
  };

  return {
    run,
    status,
    dismissStatus: () => setStatus(null),
    pendingAction,
    canAdminMerge: adminMerge.canAdminMerge,
    handoffPending: handoff !== null,
    thread:
      threadRef === null || thread === null ? null : { linked: linkedHere, canLink: canLinkHere },
    linkPending,
  };
}
