import { RegistryContext } from "@effect/atom-react";
import { terminalOutputText } from "@t3tools/client-runtime/state/terminal";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type PullRequestDetail,
  type PullRequestMergeMethod,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { useContext } from "react";

import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ADMIN_MERGE_TERMINAL_ENV,
  ADMIN_MERGE_TERMINAL_THREAD_ID,
  adminMergeShellCommand,
  readAdminMergeOutput,
  type AdminMergeOutcome,
} from "./pull-request-admin-merge";

/** Long enough for a slow host round trip; a merge that has not answered by then is reported. */
const ADMIN_MERGE_TIMEOUT_MS = 90_000;

export type AdminMergeResult =
  | { readonly kind: "merged" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Runs `gh pr merge --admin` in a terminal of its own on the environment and reads the result
 * back. The terminal belongs to no thread, so it never shows up in a thread's terminal list, and
 * it is closed with its history deleted whatever happens. Available only to a session allowed to
 * operate terminals, which is the same trust as typing the command by hand.
 */
export function usePullRequestAdminMerge(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const open = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const write = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const close = useAtomCommand(terminalEnvironment.close, { reportFailure: false });

  const run = async (
    detail: Pick<PullRequestDetail, "repository" | "number" | "url" | "workspaceRoot">,
    method: PullRequestMergeMethod,
  ): Promise<AdminMergeResult> => {
    const command = adminMergeShellCommand({
      repository: detail.repository,
      number: detail.number,
      host: hostOf(detail.url),
      method,
    });
    if (command === null) {
      return {
        kind: "failed",
        message: "This repository name cannot be passed to the GitHub CLI.",
      };
    }
    const session = {
      threadId: ADMIN_MERGE_TERMINAL_THREAD_ID,
      terminalId: `merge-${detail.number}-${Date.now().toString(36)}`,
    };
    const opened = await open({
      environmentId,
      input: {
        ...session,
        cwd: detail.workspaceRoot,
        cols: 400,
        rows: 40,
        env: { ...ADMIN_MERGE_TERMINAL_ENV },
      },
    });
    if (opened._tag === "Failure") {
      return { kind: "failed", message: failureMessage(opened, "Could not open a terminal.") };
    }

    const observed = terminalEnvironment.observe({ environmentId, input: session });
    const unmount = registry.mount(observed);
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = new Promise<Exclude<AdminMergeOutcome, { kind: "running" }>>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              kind: "failed",
              exitCode: -1,
              message: "The merge did not report back in time. Refresh to see whether it landed.",
            }),
          ADMIN_MERGE_TIMEOUT_MS,
        );
        unsubscribe = registry.subscribe(
          observed,
          (result) => {
            if (AsyncResult.isFailure(result)) {
              const failure = Cause.squash(result.cause);
              resolve({
                kind: "failed",
                exitCode: -1,
                message:
                  failure instanceof Error
                    ? failure.message
                    : "The terminal closed before the merge finished.",
              });
              return;
            }
            if (!AsyncResult.isSuccess(result)) return;
            const read = readAdminMergeOutput(terminalOutputText(result.value.output));
            if (read.kind !== "running") return resolve(read);
            if (
              result.value.status === "exited" ||
              result.value.status === "error" ||
              (result.value.status === "closed" && result.value.version > 0)
            ) {
              resolve({
                kind: "failed",
                exitCode: -1,
                message: result.value.error ?? "The terminal closed before the merge finished.",
              });
            }
          },
          { immediate: true },
        );
      });
      const written = await write({ environmentId, input: { ...session, data: command } });
      if (written._tag === "Failure") {
        return {
          kind: "failed",
          message: failureMessage(written, "Could not run the GitHub CLI."),
        };
      }
      const result = await outcome;
      return result.kind === "merged" ? result : { kind: "failed", message: result.message };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      unmount();
      void close({ environmentId, input: { ...session, deleteHistory: true } });
    }
  };

  return { canAdminMerge: canOperateTerminal, run };
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message ? failure.message : fallback;
}
