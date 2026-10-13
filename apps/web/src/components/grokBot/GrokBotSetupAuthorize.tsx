import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import {
  grokBotsOrchestratorConfigQuery,
  grokBotsPluginAuthenticate,
  grokBotsPluginCompleteAuth,
  grokBotsPluginConnectionsQuery,
} from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { PLUGIN_AUTH_STORAGE_PREFIX } from "./GrokBotPluginAccounts";
import { parseManualCallback } from "./grokBotPluginAuthReturn";
import { resolveGrokBotOAuthRedirect } from "./grokBotSetupFlow";

const EMPTY_CONNECTION = Atom.make(AsyncResult.initial<never, never>(false));

type Flow = {
  readonly stateId: string;
  readonly authorizationUrl: string;
  /** The server's loopback listener finishes sign-in; otherwise the user pastes the return address. */
  readonly completesOnServer: boolean;
  readonly expiresAtMs: number;
};
function clearStoredFlow(stateId: string) {
  try {
    localStorage.removeItem(PLUGIN_AUTH_STORAGE_PREFIX + stateId);
  } catch {
    // Sign-in also works when the browser does not permit local storage.
  }
}

/**
 * One human approval for a bot's MCP connector, from the setup panel or a bot-sent connector card.
 * Never auto-approves. `refresh` runs once the connector is known to be authorized.
 */
export function GrokBotSetupAuthorize({
  environmentId,
  serverId,
  refresh,
  label = "Authorize T3 connection",
  pluginId = "",
  watchesCompletion = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverId: number;
  readonly refresh: () => void;
  /** The button's text; a card names the connector it connects. */
  readonly label?: string;
  /** The plugin that owns the connector, when the caller knows it. */
  readonly pluginId?: string;
  /**
   * Whether the caller notices on its own when sign-in finishes on the server. Without that, the
   * waiting text must not promise an update.
   */
  readonly watchesCompletion?: boolean;
}) {
  const allowed = useAtomValue(grokBotsPluginAuthenticate.permissionAtom(environmentId));
  const authenticate = useAtomCommand(grokBotsPluginAuthenticate, { reportFailure: false });
  const complete = useAtomCommand(grokBotsPluginCompleteAuth, { reportFailure: false });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  // Setup status carries this environment's confirmed published MCP endpoint, even over LAN.
  const config = useEnvironmentQuery(grokBotsOrchestratorConfigQuery({ environmentId, input: {} }));
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (flow === null) return;
    const timeout = window.setTimeout(
      () => {
        clearStoredFlow(flow.stateId);
        setFlow(null);
        setCallbackUrl("");
        setError("Sign-in timed out. Start authorization again.");
      },
      Math.max(0, flow.expiresAtMs - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [flow]);
  const connectionAtom =
    flow !== null
      ? grokBotsPluginConnectionsQuery({ environmentId, input: { pluginId, serverId } })
      : EMPTY_CONNECTION;
  const connection = useAtomValue(connectionAtom);
  const refreshConnection = useAtomRefresh(connectionAtom);
  useEffect(() => {
    if (flow === null || connection.waiting) return;
    if (
      Option.getOrNull(AsyncResult.value(connection))?.servers.some(
        (server) =>
          server.id === serverId &&
          server.accounts.some(
            (account) => account.accountKey === "default" && account.authenticated,
          ),
      )
    ) {
      clearStoredFlow(flow.stateId);
      setFlow(null);
      refresh();
      return;
    }
    // Depend on the settled result, including failures that retain the previous success.
    const timer = window.setTimeout(refreshConnection, 5_000);
    return () => window.clearTimeout(timer);
  }, [flow, connection, refreshConnection, serverId, refresh]);

  const start = async () => {
    const redirectUri = resolveGrokBotOAuthRedirect(
      window.location.origin,
      httpBaseUrl,
      config.data?.setupStatus?.mcpUrl ?? null,
    );
    if (redirectUri === null) {
      setError(
        "This environment needs an HTTPS web address to return to. Enable T3 Connect or reconnect and try again.",
      );
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
        JSON.stringify({ environmentId, pluginId }),
      );
    } catch {
      /* The pasted-address path still works without storage. */
    }
    if (popup) {
      popup.opener = null;
      popup.location.href = authorizationUrl;
    }
    setFlow({
      stateId,
      authorizationUrl,
      completesOnServer: loopbackPort !== null,
      expiresAtMs: Date.now() + 15 * 60_000,
    });
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
    clearStoredFlow(current.stateId);
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
    clearStoredFlow(current.stateId);
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
              watchesCompletion ? (
                <>
                  <Spinner size="xs" />
                  Approve in the new tab. This updates when it completes.
                </>
              ) : (
                "Approve in the new tab. It finishes on its own once you approve."
              )
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
            {label}
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
