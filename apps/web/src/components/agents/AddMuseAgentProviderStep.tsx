import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { museAgentSetup, museAgentStatusQuery, refreshMuseAgent } from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { resolveMuseAgentNotice } from "./aiAgents";

/**
 * Native Muse is account-bound and auto-detected, so the wizard has no fields: it shows what was
 * found and offers the one next action. Needs only Muse installed and signed in on the server.
 */
export function AddMuseAgentProviderStep({
  environmentId,
  environmentLabel,
  onConnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onConnected: (instanceId: ProviderInstanceId | undefined) => void;
}) {
  const status = useEnvironmentQuery(museAgentStatusQuery({ environmentId, input: {} }));
  const canSetup = useAtomValue(museAgentSetup.permissionAtom(environmentId));
  const setup = useAtomCommand(museAgentSetup, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notice = resolveMuseAgentNotice({
    status: status.data,
    error: status.error,
  });
  const checking = status.data === null && status.isPending && status.error === null;
  // `ready` stays false until setup verifies the account, so a signed-in Muse must be connectable.
  const data = status.data;
  const canConnect = status.error === null && !!data && data.installed && data.sessionPresent;
  const reconnect = canConnect && !!data.provider;

  const connect = async () => {
    setPending(true);
    setError(null);
    const result = await setup({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Muse could not be connected.");
      return;
    }
    if (result.value.ready && result.value.provider) {
      onConnected(result.value.provider.instanceId);
      return;
    }
    // Account still unverified: show the server's actual reason, then refresh the status.
    const reason = result.value.message?.trim();
    if (reason) setError(reason);
    refreshMuseAgent(appAtomRegistry, environmentId);
  };

  return (
    <div className="grid gap-3 pt-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">Muse</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your personal Muse agent, chatting from {environmentLabel}. It is found automatically from
          the Muse app on that machine.
        </p>
      </div>
      {checking ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" /> Looking for Muse…
        </div>
      ) : canConnect ? (
        <div className="grid gap-1 text-xs text-muted-foreground">
          <p>
            {reconnect
              ? "Muse needs to reconnect before you can chat with it."
              : "Muse is installed and signed in. Add it to verify the account and start chatting."}
          </p>
          {notice.kind !== "ready" && notice.message ? <p role="status">{notice.message}</p> : null}
        </div>
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          {notice.message}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canConnect ? (
          <Button size="sm" disabled={pending || !canSetup} onClick={() => void connect()}>
            {pending ? "Verifying account..." : reconnect ? "Reconnect Muse" : "Add Muse"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => refreshMuseAgent(appAtomRegistry, environmentId)}
          >
            <RefreshIcon /> {notice.kind === "error" ? "Retry" : "Check again"}
          </Button>
        )}
      </div>
    </div>
  );
}
