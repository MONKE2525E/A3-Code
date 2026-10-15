import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { museAgentOpenThread } from "~/state/museAgent";
import { useAtomCommand } from "~/state/use-atom-command";
import { openCachedMuseThread } from "./openCachedMuseThread";

/** A restored URL must reattach native history even when no sidebar or search action ran. */
export function MuseAgentRouteConnection({
  environmentId,
  threadId,
  providerInstanceId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly connected: boolean;
}) {
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!connected || !canOpen) return;
    let current = true;
    setError(null);
    setPending(true);
    void openCachedMuseThread({
      hit: { environmentId, threadId },
      shells: [{ environmentId, id: threadId, providerInstanceId }],
      openThread: async (target) => {
        const result = await openThread(target);
        if (result._tag === "Success") return result.value;
        if (isAtomCommandInterrupted(result)) return null;
        throw squashAtomCommandFailure(result);
      },
      navigate: async () => {},
    })
      .catch((cause: unknown) => {
        if (current)
          setError(
            cause instanceof Error ? cause.message : "Could not reconnect this Muse conversation.",
          );
      })
      .finally(() => {
        if (current) setPending(false);
      });
    return () => {
      current = false;
    };
  }, [connected, canOpen, environmentId, threadId, providerInstanceId, openThread, retry]);
  if (!connected) return null;
  if (!canOpen)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Live Muse history needs permission to operate on this environment.
      </p>
    );
  if (pending)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Connecting Muse history…
      </p>
    );
  if (error === null) return null;
  return (
    <div className="flex items-center gap-2">
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
      <Button size="xs" variant="outline" onClick={() => setRetry((value) => value + 1)}>
        Retry Muse connection
      </Button>
    </div>
  );
}
