import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { museAgentOpenThread } from "~/state/museAgent";
import { useAtomCommand } from "~/state/use-atom-command";
import { openCachedMuseThread } from "./openCachedMuseThread";

/** Full-pane wait while Muse's thread is created or its first history page arrives. */
export function MuseChatLoading({
  name,
  description,
}: {
  readonly name?: string | null;
  readonly description?: string;
}) {
  const title = name?.trim() ? `Opening ${name.trim()}` : "Opening Muse";
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <div className="flex items-center gap-2">
        <Spinner size="sm" tone="muted" />
        <h1 className="text-base font-medium">{title}</h1>
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">
        {description ?? "Loading conversation history."}
      </p>
    </div>
  );
}

/** A restored URL must reattach native history even when no sidebar or search action ran. */
export function MuseAgentRouteConnection({
  environmentId,
  threadId,
  providerInstanceId,
  connected,
  hasMessages,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly connected: boolean;
  readonly hasMessages: boolean;
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
  const pane = !hasMessages ? "absolute inset-0 z-10 flex bg-background" : null;
  if (!canOpen)
    return (
      <p
        role="status"
        className={
          pane
            ? `${pane} items-center justify-center p-6 text-center text-sm text-muted-foreground`
            : "px-3 py-2 text-xs text-muted-foreground"
        }
      >
        Live Muse history needs permission to operate on this environment.
      </p>
    );
  if (pending) {
    if (pane)
      return (
        <div className={pane}>
          <MuseChatLoading description="Loading conversation history." />
        </div>
      );
    return (
      <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
        Connecting Muse history…
      </p>
    );
  }
  if (error === null) return null;
  return (
    <div
      className={
        pane ? `${pane} items-center justify-center gap-2 p-6` : "flex items-center gap-2 px-3 py-2"
      }
    >
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
      <Button size="xs" variant="outline" onClick={() => setRetry((value) => value + 1)}>
        Retry Muse connection
      </Button>
    </div>
  );
}
