import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { grokBotsPluginAuthenticate, grokBotsPluginCompleteAuth } from "~/state/grokBots";
import { useAtomCommand } from "~/state/use-atom-command";
import { PLUGIN_AUTH_STORAGE_PREFIX } from "./GrokBotPluginAccounts";
import { parseManualCallback } from "./grokBotPluginAuthReturn";
import { resolveGrokBotOAuthRedirect } from "./grokBotSetupFlow";

type Flow = {
  readonly stateId: string;
  readonly authorizationUrl: string;
  /** The server's loopback listener finishes sign-in; otherwise the user pastes the return address. */
  readonly completesOnServer: boolean;
};

/** One human approval for the connector the setup bot created. Never auto-approves. */
export function GrokBotSetupAuthorize({
  environmentId,
  serverId,
  refresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverId: number;
  readonly refresh: () => void;
}) {
  const allowed = useAtomValue(grokBotsPluginAuthenticate.permissionAtom(environmentId));
  const authenticate = useAtomCommand(grokBotsPluginAuthenticate, { reportFailure: false });
  const complete = useAtomCommand(grokBotsPluginCompleteAuth, { reportFailure: false });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const redirectUri = resolveGrokBotOAuthRedirect(window.location.origin, httpBaseUrl);
    if (redirectUri === null) {
      setError("This environment has no web address to return to. Reconnect and try again.");
      return;
    }
    // Opened synchronously so the click still counts as a user gesture.
    const popup = window.open("about:blank", "_blank");
    setBusy(true);
    setError(null);
    const result = await authenticate({
      environmentId,
      input: { serverId, accountKey: "default", redirectUri },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      popup?.close();
      setError("Authorization could not start. Please try again.");
      return;
    }
    const { authenticated, authorizationUrl, stateId, loopbackPort } = result.value;
    if (authenticated) {
      popup?.close();
      refresh();
      return;
    }
    if (!authorizationUrl || !stateId) {
      popup?.close();
      setError("The connector did not provide an authorization link.");
      return;
    }
    try {
      localStorage.setItem(
        PLUGIN_AUTH_STORAGE_PREFIX + stateId,
        JSON.stringify({ environmentId, pluginId: "" }),
      );
    } catch {
      /* The pasted-address path still works without storage. */
    }
    if (popup) {
      popup.opener = null;
      popup.location.href = authorizationUrl;
    }
    setFlow({ stateId, authorizationUrl, completesOnServer: loopbackPort !== null });
  };

  const finish = async (current: Flow) => {
    // The address holds a one-time code, so it leaves the field on every outcome.
    const value = callbackUrl;
    setCallbackUrl("");
    const parsed = parseManualCallback(value, current.stateId);
    if (parsed._tag !== "code") {
      setError(
        parsed._tag === "denied"
          ? "Authorization was declined. Try again."
          : "That address is not from this sign-in. Copy the full address from the sign-in tab.",
      );
      return;
    }
    setBusy(true);
    const result = await complete({
      environmentId,
      input: { stateId: current.stateId, code: parsed.code },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setFlow(null);
      setError(null);
      refresh();
      return;
    }
    setFlow(null);
    setError("Authorization could not finish. Try again.");
  };

  /** Abandons the local flow so Authorize returns; the connector itself is untouched. */
  const startOver = (current: Flow) => {
    try {
      localStorage.removeItem(PLUGIN_AUTH_STORAGE_PREFIX + current.stateId);
    } catch {
      /* Nothing stored, nothing to clear. */
    }
    setFlow(null);
    setCallbackUrl("");
    setError(null);
  };

  return (
    <div className="grid gap-2">
      {flow ? (
        <>
          <p className="flex flex-wrap items-center gap-2 text-xs leading-5 text-muted-foreground">
            {flow.completesOnServer ? (
              <>
                <Spinner size="xs" />
                Approve in the new tab. This updates when it completes.
              </>
            ) : (
              "Approve in the new tab. The page it lands on may not load. Copy its full address and paste it below."
            )}{" "}
            <a
              className="text-foreground underline underline-offset-2"
              href={flow.authorizationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open authorization page
            </a>
            <Button
              size="xs"
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => startOver(flow)}
            >
              Start over
            </Button>
          </p>
          {flow.completesOnServer ? null : (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void finish(flow);
              }}
            >
              <Input
                className="min-w-0 flex-1"
                size="sm"
                aria-label="Address from the sign-in tab"
                placeholder="Paste the full address"
                autoComplete="off"
                spellCheck={false}
                value={callbackUrl}
                disabled={busy}
                onChange={(event) => setCallbackUrl(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={callbackUrl.trim() === "" || busy}>
                Finish
              </Button>
            </form>
          )}
        </>
      ) : (
        <div>
          <Button size="sm" type="button" disabled={!allowed || busy} onClick={() => void start()}>
            {busy ? <Spinner size="xs" /> : null}
            Authorize T3 connection
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
