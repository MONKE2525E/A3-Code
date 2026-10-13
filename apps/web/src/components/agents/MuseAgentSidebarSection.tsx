import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { useSidebar } from "~/components/ui/sidebar";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  museAgentOpenThread,
  museAgentProfileQuery,
  museAgentSetup,
  museAgentStatusQuery,
  refreshMuseAgent,
} from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { environmentThreadShells } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { findCachedMuseAgentThread, resolveMuseAgentSidebarState } from "./aiAgents";
import { MuseAgentSetupNotice, MuseAgentSidebarRow } from "./MuseAgentSidebarRow";
import { useMuseAgentAvatar } from "./useMuseAgentAvatar";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Native Muse inside the AI Agents section. Detection is automatic: nothing renders until Muse
 * is installed, then it guides sign-in or one-click enable, then shows the personal agent row.
 */
export function MuseAgentSidebarSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const status = useEnvironmentQuery(museAgentStatusQuery({ environmentId, input: {} }));
  const state = resolveMuseAgentSidebarState({ status: status.data, error: status.error });
  // Failures render inline: a toast-only report is easy to miss and says nothing in the sidebar.
  const setup = useAtomCommand(museAgentSetup, { reportFailure: false });
  const canSetup = useAtomValue(museAgentSetup.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const runSetup = async () => {
    setPending(true);
    setSetupError(null);
    const result = await setup({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setSetupError(sanitizeSetupError(squashAtomCommandFailure(result)));
    }
  };

  if (state.kind === "hidden") return null;
  if (state.kind === "setup") {
    return (
      <MuseAgentSetupNotice
        notice={state.notice}
        onAction={() => refreshMuseAgent(appAtomRegistry, environmentId)}
      />
    );
  }
  if (state.kind === "enable") {
    const reconnect = state.mode === "reconnect";
    return (
      <div className="flex flex-col gap-2 px-2 py-2">
        <p className="text-xs leading-4.5 text-sidebar-muted-foreground">
          {reconnect
            ? "Muse needs to reconnect before you can chat with it here."
            : "Muse is signed in on this machine. Connect it to verify the account and chat with it here."}
        </p>
        {state.detail ? (
          <p className="text-xs leading-4.5 text-sidebar-muted-foreground">{state.detail}</p>
        ) : null}
        {setupError ? (
          <p role="alert" className="text-xs leading-4.5 text-destructive">
            {setupError}
          </p>
        ) : null}
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={!canSetup || pending}
            onClick={() => void runSetup()}
          >
            {pending
              ? "Verifying account…"
              : setupError
                ? "Try again"
                : reconnect
                  ? "Reconnect Muse"
                  : "Add Muse"}
          </Button>
        </div>
      </div>
    );
  }
  return <MuseAgentRosterRow environmentId={environmentId} instanceId={state.instanceId} />;
}

function MuseAgentRosterRow({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const profile = useEnvironmentQuery(museAgentProfileQuery({ environmentId, input: {} }));
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const routeThreadId = useParams({ strict: false, select: (params) => params.threadId ?? null });
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => params.environmentId ?? null,
  });
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));

  const selected = useMemo(() => {
    if (routeThreadId === null || routeEnvironmentId !== environmentId) return false;
    const thread = threads.find((entry) => entry.id === routeThreadId);
    return (
      thread !== undefined &&
      thread.id.startsWith("muse-agent:") &&
      thread.providerInstanceId === instanceId
    );
  }, [environmentId, instanceId, routeEnvironmentId, routeThreadId, threads]);

  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const open = useCallback(async () => {
    if (opening) return;
    if (isMobile) setOpenMobile(false);
    // Always use the guarded open: the server validates the account, unarchives and reattaches
    // history (idempotent), and the cached thread is never a bypass.
    setOpening(true);
    setOpenError(null);
    const result = await openThread({
      environmentId,
      input: { providerInstanceId: ProviderInstanceId.make(instanceId) },
    });
    setOpening(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        setOpenError(
          shortError(squashAtomCommandFailure(result), "Could not open Muse. Try again."),
        );
      }
      return;
    }
    const threadId = result.value.threadId;
    setOpenError(null);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  }, [environmentId, instanceId, isMobile, navigate, opening, openThread, setOpenMobile]);

  // Working comes from the canonical thread's run, never from the selected route.
  const working = useMemo(() => {
    const shell = findCachedMuseAgentThread(threads, instanceId);
    return shell !== null && shell.status !== "idle" && ACTIVE_RUN_STATUSES.has(shell.status);
  }, [instanceId, threads]);

  const data = profile.data;
  const avatar = useMuseAgentAvatar(environmentId, data, { loadVideo: working });
  return (
    <MuseAgentSidebarRow
      name={data?.name?.trim() || "Muse"}
      imageUrl={avatar.imageUrl}
      videoUrl={avatar.videoUrl}
      active={working}
      selected={selected}
      disabled={!canOpen}
      pending={opening}
      error={openError}
      onOpen={() => void open()}
    />
  );
}

/** One short line for the sidebar: no stack, path, or token-looking text from the failure. */
function shortError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const line = error.message.split("\n")[0]?.trim() ?? "";
  if (line.length === 0 || line.length > 160 || /[/\\]|\b[\w-]{32,}\b/.test(line)) return fallback;
  return line;
}

function sanitizeSetupError(error: unknown): string {
  return shortError(
    error,
    "Muse could not be connected. Check that Muse is signed in, then try again.",
  );
}
