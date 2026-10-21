import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ThreadId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  museAgentFeatureReadQuery,
  museAgentHistoryPageCommand,
  museAgentStatusQuery,
} from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Header entry that imports one page of older Muse messages into this thread. Distinct from the
 * chat's own "Load earlier turns", which only widens the window over what T3 already holds.
 * Nothing loads on its own: the cursor-less read only reports whether more exists, and each
 * click imports exactly one page.
 */
export function MuseAgentHistoryPagination({
  environmentId,
  threadId,
  providerInstanceId: threadProviderInstanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId | undefined;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const status = useEnvironmentQuery(
    canRead ? museAgentStatusQuery({ environmentId, input: {} }) : null,
  ).data;
  const providerInstanceId =
    status?.ready && status.provider?.instanceId === threadProviderInstanceId
      ? (threadProviderInstanceId ?? null)
      : null;
  const inspect = useEnvironmentQuery(
    canRead && providerInstanceId !== null
      ? museAgentFeatureReadQuery({
          environmentId,
          input: { operation: "history_page", providerInstanceId, threadId },
        })
      : null,
  );
  const loadPage = useAtomCommand(museAgentHistoryPageCommand, { reportFailure: false });
  // Importing writes to the thread, so it needs operate; the cursor value does not affect the scope.
  const canImport = useAtomValue(
    museAgentHistoryPageCommand.permissionAtom(
      environmentId,
      providerInstanceId === null
        ? undefined
        : { operation: "history_page", providerInstanceId, threadId, beforeSeq: 0 },
    ),
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // A failed import belongs to the thread it was started on.
  const target = `${environmentId}:${threadId}:${providerInstanceId}`;
  const [failureTarget, setFailureTarget] = useState(target);
  if (failureTarget !== target) {
    setFailureTarget(target);
    setFailed(false);
  }

  if (!canRead || providerInstanceId === null) return null;
  const page = inspect.data?.operation === "history_page" ? inspect.data.data : null;
  // The server answers only for a canonical, unarchived Muse thread; anything else shows nothing.
  if (page === null && inspect.error === null && !inspect.isPending) return null;

  const cursor = page?.hasMore ? page.nextBeforeSeq : null;
  const exhausted = page !== null && cursor === null;
  const inspecting = page === null && inspect.error === null;
  const inspectFailed = page === null && inspect.error !== null;
  const busy = loading || inspecting;

  const label = loading
    ? "Loading earlier Muse history…"
    : inspecting
      ? "Checking earlier Muse history…"
      : inspectFailed || failed
        ? "Retry earlier Muse history"
        : exhausted
          ? "No earlier Muse history"
          : !canImport
            ? "Loading earlier Muse history requires operate access"
            : "Load earlier Muse history";
  // Read-only clients may inspect whether more exists, but never import it.
  const blocked = !canImport && !inspectFailed && !exhausted;

  const onClick = async () => {
    if (busy || exhausted || blocked) return;
    if (inspectFailed) {
      inspect.refresh();
      return;
    }
    if (cursor === null) return;
    setLoading(true);
    setFailed(false);
    const result = await loadPage({
      environmentId,
      input: { operation: "history_page", providerInstanceId, threadId, beforeSeq: cursor },
    });
    setLoading(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setFailed(true);
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not load earlier Muse history",
        description: failure instanceof Error ? failure.message : "Try again in a moment.",
      });
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="touch-sm"
            aria-label={label}
            aria-disabled={busy || exhausted || blocked}
            className="shrink-0 [-webkit-app-region:no-drag]"
            onClick={() => void onClick()}
          />
        }
      >
        {busy ? <Spinner className="size-4" /> : <HistoryIcon className="size-4" />}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
