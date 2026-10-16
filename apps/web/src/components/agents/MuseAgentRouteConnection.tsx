import { useAtomValue } from "@effect/atom-react";
import { isRpcClientError } from "@t3tools/client-runtime/rpc";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { museAgentOpenThread } from "~/state/museAgent";
import { useAtomCommand } from "~/state/use-atom-command";
import { openCachedMuseThread } from "./openCachedMuseThread";

const MUSE_OPEN_RETRY_MESSAGE = "Could not reconnect this Muse conversation.";
const MUSE_CONNECTING_SEND_REASON = "Connecting Muse history…";
const MUSE_PERMISSION_SEND_REASON =
  "Live Muse history needs permission to operate on this environment.";
const MUSE_RETRY_SEND_REASON = "Retry Muse connection to send";
const MUSE_INTERRUPT_MESSAGE = "Muse connection was interrupted. Retry to reconnect.";

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

type MuseAgentAttachSendGate = {
  readonly sendAllowed: boolean;
  readonly sendBlockedReason: string | null;
};

/**
 * Send is allowed only after a verified native attach. First paint is blocked
 * because `attached` starts false. Ordinary ChatView threads never mount this.
 */
function museAgentAttachSendGate(input: {
  readonly connected: boolean;
  readonly canOpen: boolean;
  readonly attached: boolean;
  readonly error: string | null;
}): MuseAgentAttachSendGate {
  if (!input.connected) {
    return { sendAllowed: false, sendBlockedReason: MUSE_CONNECTING_SEND_REASON };
  }
  if (!input.canOpen) {
    return { sendAllowed: false, sendBlockedReason: MUSE_PERMISSION_SEND_REASON };
  }
  if (input.attached) {
    return { sendAllowed: true, sendBlockedReason: null };
  }
  if (input.error !== null) {
    return { sendAllowed: false, sendBlockedReason: MUSE_RETRY_SEND_REASON };
  }
  return { sendAllowed: false, sendBlockedReason: MUSE_CONNECTING_SEND_REASON };
}

/**
 * Until the route reports an attach result, a Muse composer stays blocked.
 * Ordinary threads never pass a Muse reason through.
 */
export function resolveMuseAgentComposerSendBlockedReason(
  isMuseAgentThread: boolean,
  reported: string | null | undefined,
): string | null {
  if (!isMuseAgentThread) return null;
  return reported === undefined ? MUSE_CONNECTING_SEND_REASON : reported;
}

/** env:thread:provider:connection — the attach identity a turn must still match. */
export function museAgentAttachScopeIdentity(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly connected: boolean;
}): string {
  return `${input.environmentId}:${input.threadId}:${input.providerInstanceId}:${input.connected ? "connected" : "offline"}`;
}

/**
 * Authoritative turn-dispatch gate. Submit-time attach is not enough: prep
 * (uploads, settings) can span disconnect/reconnect. An unrelated thread's
 * later attach must not authorize this turn.
 */
export function museAgentTurnDispatchBlockedReason(input: {
  readonly isMuseDispatch: boolean;
  readonly dispatchScope: string;
  readonly currentAttachScope: string;
  readonly currentBlockedReason: string | null;
  readonly isNewThreadBootstrap?: boolean;
}): string | null {
  if (!input.isMuseDispatch) return null;
  if (input.isNewThreadBootstrap === true) return null;
  if (input.currentAttachScope !== input.dispatchScope) {
    return MUSE_CONNECTING_SEND_REASON;
  }
  return input.currentBlockedReason;
}

/**
 * Read the live attach immediately before the actual dispatch. Callers keep
 * drafts when this returns `{ ok: false }` — the dispatch callback never runs.
 */
export async function guardMuseAgentTurnDispatch<T>(
  readGate: () => {
    readonly isMuseDispatch: boolean;
    readonly dispatchScope: string;
    readonly currentAttachScope: string;
    readonly currentBlockedReason: string | null;
    readonly isNewThreadBootstrap?: boolean;
  },
  dispatch: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const blocked = museAgentTurnDispatchBlockedReason(readGate());
  if (blocked != null) return { ok: false, reason: blocked };
  return { ok: true, value: await dispatch() };
}

/** After an open attempt, transport and unknown-method RPC stay retryable without leaking the cause. */
function describeMuseAgentOpenFailure(cause: unknown): string {
  if (
    isRpcClientError(cause) ||
    (typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      cause._tag === "EnvironmentRpcUnavailableError")
  ) {
    return MUSE_OPEN_RETRY_MESSAGE;
  }
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return MUSE_OPEN_RETRY_MESSAGE;
}

/** A restored URL must reattach native history even when no sidebar or search action ran. */
export function MuseAgentRouteConnection({
  environmentId,
  threadId,
  providerInstanceId,
  connected,
  hasMessages,
  onSendBlockedReasonChange,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly connected: boolean;
  readonly hasMessages: boolean;
  readonly onSendBlockedReasonChange?: (reason: string | null) => void;
  readonly children?: (gate: MuseAgentAttachSendGate) => ReactNode;
}) {
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const scopeKey = `${environmentId}:${threadId}:${providerInstanceId}:${connected}:${canOpen}:${retry}`;
  const [scope, setScope] = useState(scopeKey);
  if (scope !== scopeKey) {
    setScope(scopeKey);
    setAttached(false);
    setError(null);
  }
  useEffect(() => {
    if (!connected || !canOpen) return;
    let current = true;
    void openCachedMuseThread({
      hit: { environmentId, threadId },
      shells: [{ environmentId, id: threadId, providerInstanceId }],
      openThread: async (target) => {
        const result = await openThread(target);
        if (result._tag === "Success") return result.value;
        if (isAtomCommandInterrupted(result)) {
          throw new Error(MUSE_INTERRUPT_MESSAGE);
        }
        throw squashAtomCommandFailure(result);
      },
      navigate: async () => {},
    })
      .then(() => {
        if (current) setAttached(true);
      })
      .catch((cause: unknown) => {
        if (current) setError(describeMuseAgentOpenFailure(cause));
      });
    return () => {
      current = false;
    };
  }, [connected, canOpen, environmentId, threadId, providerInstanceId, openThread, retry]);
  const gate = museAgentAttachSendGate({ connected, canOpen, attached, error });
  useLayoutEffect(() => {
    onSendBlockedReasonChange?.(gate.sendBlockedReason);
  }, [gate.sendBlockedReason, onSendBlockedReasonChange]);
  const pane = !hasMessages ? "absolute inset-0 z-10 flex bg-background" : null;
  let status: ReactNode = null;
  if (connected) {
    if (!canOpen) {
      status = (
        <p
          role="status"
          className={
            pane
              ? `${pane} items-center justify-center p-6 text-center text-sm text-muted-foreground`
              : "px-3 py-2 text-xs text-muted-foreground"
          }
        >
          {MUSE_PERMISSION_SEND_REASON}
        </p>
      );
    } else if (error !== null) {
      status = (
        <div
          className={
            pane
              ? `${pane} items-center justify-center gap-2 p-6`
              : "flex items-center gap-2 px-3 py-2"
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
    } else if (!attached) {
      status = pane ? (
        <div className={pane}>
          <MuseChatLoading description="Loading conversation history." />
        </div>
      ) : (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {MUSE_CONNECTING_SEND_REASON}
        </p>
      );
    }
  }
  return (
    <>
      {status}
      {children?.(gate)}
    </>
  );
}
