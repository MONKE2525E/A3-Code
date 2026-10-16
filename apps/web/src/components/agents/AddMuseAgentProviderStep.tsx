import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { SettingsRow } from "~/components/settings/settingsLayout";
import {
  museAgentSetup,
  museAgentSignIn,
  museAgentCloseSignIn,
  museAgentStatusQuery,
  refreshMuseAgent,
} from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";

/**
 * Sign-in runs in an environment-owned private browser and preserves its session.
 */
export function AddMuseAgentProviderStep({
  environmentId,
  environmentLabel,
  onConnected,
  reconnecting = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onConnected: (instanceId: ProviderInstanceId | undefined) => void;
  readonly reconnecting?: boolean;
}) {
  const status = useEnvironmentQuery(museAgentStatusQuery({ environmentId, input: {} }));
  const canSetup = useAtomValue(museAgentSetup.permissionAtom(environmentId));
  const canSignIn = useAtomValue(museAgentSignIn.permissionAtom(environmentId));
  const setup = useAtomCommand(museAgentSetup, { reportFailure: false });
  // Tracks which action is running so each button labels only its own work.
  const [pendingAction, setPendingAction] = useState<"open" | "verify" | null>(null);
  const pending = pendingAction !== null;
  const [error, setError] = useState<string | null>(null);

  const signIn = useAtomCommand(museAgentSignIn, { reportFailure: false, reportDefect: false });
  const closeSignIn = useAtomCommand(museAgentCloseSignIn, {
    reportFailure: false,
    reportDefect: false,
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [browser, setBrowser] = useState<{ threadId: string; tabId: string } | null>(null);
  const browserThreadId = browser?.threadId;
  useEffect(
    () => () => {
      if (browserThreadId)
        void closeSignIn({ environmentId, input: { threadId: browserThreadId } });
    },
    [browserThreadId, closeSignIn, environmentId],
  );
  const openSignIn = async () => {
    setPendingAction("open");
    setError(null);
    const result = await signIn({ environmentId, input: {} });
    setPendingAction(null);
    if (result._tag === "Success") {
      if (mounted.current) setBrowser(result.value);
      else void closeSignIn({ environmentId, input: { threadId: result.value.threadId } });
    } else if (!isAtomCommandInterrupted(result))
      setError("The Muse sign-in browser could not be opened.");
  };
  const checking = status.data === null && status.isPending && status.error === null;
  // `ready` stays false until setup verifies the account, so a signed-in Muse must be connectable.
  const data = status.data;
  const canConnect = status.error === null && !!data && data.installed && data.sessionPresent;
  const reconnect = canConnect && !!data.provider;

  const connect = async () => {
    setPendingAction("verify");
    setError(null);
    const result = await setup({ environmentId, input: {} });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Muse could not be connected.");
      return;
    }
    if (result.value.ready && result.value.provider) {
      setBrowser(null);
      onConnected(result.value.provider.instanceId);
      return;
    }
    // Account still unverified: show the server's actual reason, then refresh the status.
    const reason = result.value.message?.trim();
    if (reason) setError(reason);
    refreshMuseAgent(appAtomRegistry, environmentId);
  };

  // The server also reports installed=false when inspection fails, so only an inspected install
  // with no session counts as a verified miss.
  const recoveryDescription = checking
    ? "Checking the connection…"
    : status.error !== null
      ? "Could not load Muse status. Sign in again to restore the connection."
      : canConnect
        ? "Reconnect with the saved session. Sign in again if it has expired."
        : data?.installed && !data.sessionPresent
          ? "No saved Muse session on this environment. Sign in again to connect."
          : "Could not verify the Muse session. Sign in again to restore the connection.";

  const signInButton = (
    <Button
      size="sm"
      variant={reconnecting && canConnect ? "outline" : "default"}
      disabled={pending || !canSignIn}
      onClick={() => void openSignIn()}
    >
      {pendingAction === "open" ? "Opening…" : reconnecting ? "Sign in again" : "Sign in to Muse"}
    </Button>
  );

  return (
    <>
      {reconnecting ? (
        <SettingsRow
          title="Muse account"
          description={recoveryDescription}
          control={
            <>
              {canConnect ? (
                <Button size="sm" disabled={pending || !canSetup} onClick={() => void connect()}>
                  {pendingAction === "verify" ? "Reconnecting…" : "Reconnect"}
                </Button>
              ) : null}
              {signInButton}
            </>
          }
        >
          {error && !browser ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </SettingsRow>
      ) : (
        <div className="grid gap-3 pt-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">Muse</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Your personal Muse agent, chatting from {environmentLabel}. Sign in once to connect
              your account.
            </p>
          </div>
          {checking ? (
            <p role="status" className="text-xs text-muted-foreground">
              Checking the connection…
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Sign in to Muse in a private browser window. No companion app or API key is required.
          </p>
          {error && !browser ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {signInButton}
            {canConnect ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !canSetup}
                onClick={() => void connect()}
              >
                {reconnect ? "Reconnect" : "Use existing session"}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <Dialog
        open={browser !== null}
        onOpenChange={(open) => {
          if (!open) setBrowser(null);
        }}
      >
        <DialogPopup className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Sign in to Muse</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {browser ? (
              <div className="h-[60vh] min-h-80">
                <ServerBrowserSurface
                  environmentId={environmentId}
                  threadId={browser.threadId}
                  tabId={browser.tabId}
                  visible
                  showControlBar={false}
                  onPopup={(tabId) =>
                    setBrowser((current) => (current ? { ...current, tabId } : null))
                  }
                />
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBrowser(null)}>
              Close
            </Button>
            <Button disabled={pending || !canSetup} onClick={() => void connect()}>
              {pendingAction === "verify" ? "Verifying…" : "Finish sign-in"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
