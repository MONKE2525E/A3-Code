import { useStableCallback } from "../../hooks/useStableCallback";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import {
  grokBotsPluginAuthenticate,
  grokBotsPluginCompleteAuth,
  grokBotsPluginConnectionsQuery,
  grokBotsOrchestratorConfigQuery,
} from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { parseManualCallback } from "./grokBotPluginAuthReturn";
import { resolveGrokBotOAuthRedirect } from "./grokBotSetupFlow";

export const PLUGIN_AUTH_STORAGE_PREFIX = "t3:grok-plugin-auth:";
const POLL_INTERVAL_MS = 2_000;
const POPUP_CLOSE_GRACE_MS = 10_000;
const SIGN_IN_WAIT_MS = 15 * 60_000;

const invalidAddressMessage = {
  unreadable: "That is not a full address. Copy the whole address from the sign-in tab.",
  otherSignIn: "That address is from a different sign-in. Copy it from the tab you just opened.",
  noCode: "That address has no sign-in code. Copy the full address from the sign-in tab.",
} as const;

type SignInFlow = {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly serverId: number;
  readonly accountKey: string;
  readonly stateId: string;
  readonly authorizationUrl: string;
  readonly popup: Window | null;
  /** The relay returns to this machine's listener, so the server finishes sign-in without the page. */
  readonly completesOnServer: boolean;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
};

/** Account connections belong to the selected environment's Grok Bot account. */
export function GrokBotPluginAccounts({
  environmentId,
  pluginId,
}: {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
}) {
  const query = useEnvironmentQuery(
    grokBotsPluginConnectionsQuery({ environmentId, input: { pluginId } }),
  );
  const allowed = useAtomValue(grokBotsPluginAuthenticate.permissionAtom(environmentId));
  const authenticate = useAtomCommand(grokBotsPluginAuthenticate, { reportFailure: false });
  const complete = useAtomCommand(grokBotsPluginCompleteAuth, { reportFailure: false });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const config = useEnvironmentQuery(grokBotsOrchestratorConfigQuery({ environmentId, input: {} }));
  const [pending, setPending] = useState<string | null>(null);
  const [flow, setFlow] = useState<SignInFlow | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeFlow = useRef<SignInFlow | null>(null);
  const latestQuery = useRef(query);
  useEffect(() => {
    latestQuery.current = query;
  }, [query]);
  const flowWatch = useRef<{
    flow: SignInFlow;
    connectionsUpdatedAt: number;
    closedAtMs: number | null;
    closeCheck: { startedAtMs: number; dataUpdatedAt: number } | null;
  } | null>(null);
  const refreshAccounts = query.refresh;
  useEffect(() => {
    const refreshCurrentFlow = () => {
      const watch = flowWatch.current;
      if (watch?.flow === activeFlow.current) {
        // A returning tab can close while its callback is still committing. Give that refresh time
        // to settle before treating a closed popup as an abandoned sign-in.
        watch.closedAtMs = null;
        watch.closeCheck = null;
      }
      refreshAccounts();
    };
    const refresh = (event: StorageEvent) => {
      if (!event.key?.startsWith(PLUGIN_AUTH_STORAGE_PREFIX) || event.newValue !== null) return;
      const current = activeFlow.current;
      if (current && event.key !== PLUGIN_AUTH_STORAGE_PREFIX + current.stateId) return;
      refreshCurrentFlow();
    };
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refreshCurrentFlow);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refreshCurrentFlow);
    };
  }, [refreshAccounts]);

  const endFlow = useStableCallback(
    (ended: SignInFlow, message?: { readonly notice?: string; readonly error?: string }) => {
      if (activeFlow.current !== ended) return;
      activeFlow.current = null;
      setFlow(null);
      setCallbackUrl("");
      setNotice(message?.notice ?? null);
      setError(message?.error ?? null);
      try {
        localStorage.removeItem(PLUGIN_AUTH_STORAGE_PREFIX + ended.stateId);
      } catch {
        /* Storage may be disabled. */
      }
    },
  );

  // Both loopback and HTTPS callbacks can finish elsewhere, including in another browser origin.
  useEffect(() => {
    if (!flow) return;
    if (flow.environmentId !== environmentId || flow.pluginId !== pluginId) {
      endFlow(flow);
      return;
    }
    const watch = {
      flow,
      // Authentication and a cached-status update can commit together. Neither completes this flow.
      connectionsUpdatedAt: latestQuery.current.dataUpdatedAt,
      closedAtMs: null,
      closeCheck: null,
    } as NonNullable<typeof flowWatch.current>;
    flowWatch.current = watch;
    const deadline = window.setTimeout(
      () =>
        endFlow(flow, { error: "Sign-in did not finish in time. Authenticate again to retry." }),
      Math.max(0, flow.expiresAtMs - Date.now()),
    );
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (flow.popup?.closed) {
        watch.closedAtMs ??= now;
      }
      if (latestQuery.current.isPending) return;
      if (watch.closedAtMs !== null && now - watch.closedAtMs >= POPUP_CLOSE_GRACE_MS) {
        watch.closeCheck ??= { startedAtMs: now, dataUpdatedAt: latestQuery.current.dataUpdatedAt };
      }
      // Verify a fresh result after the grace period, rather than failing before this refresh returns.
      refreshAccounts();
    }, POLL_INTERVAL_MS);
    refreshAccounts();
    return () => {
      if (flowWatch.current === watch) flowWatch.current = null;
      window.clearTimeout(deadline);
      window.clearInterval(timer);
    };
  }, [flow, endFlow, refreshAccounts, environmentId, pluginId]);

  useEffect(() => {
    const watch = flowWatch.current;
    if (
      !flow ||
      watch?.flow !== flow ||
      flow.environmentId !== environmentId ||
      flow.pluginId !== pluginId ||
      !query.data ||
      !query.isSuccess ||
      query.isPending ||
      query.dataUpdatedAt <= watch.connectionsUpdatedAt ||
      query.dataUpdatedAt < flow.startedAtMs
    )
      return;
    const account = query.data.servers
      .find((server) => server.id === flow.serverId)
      ?.accounts.find((candidate) => candidate.accountKey === flow.accountKey);
    if (account?.status === "connected") {
      endFlow(flow, { notice: "Connector connected." });
      return;
    }
    const closeCheck = watch.closeCheck;
    if (
      closeCheck &&
      query.dataUpdatedAt > closeCheck.dataUpdatedAt &&
      query.dataUpdatedAt >= closeCheck.startedAtMs
    ) {
      endFlow(flow, {
        error: "The sign-in tab closed before sign-in finished. Authenticate again to retry.",
      });
    }
  }, [
    flow,
    query.data,
    query.dataUpdatedAt,
    query.isPending,
    query.isSuccess,
    endFlow,
    environmentId,
    pluginId,
  ]);

  const run = useStableCallback(async (serverId: number, accountKey: string) => {
    if (pending !== null) return;
    // The sign-in returns to the environment's own web address. Electron's page origin and a client
    // paired to another host are not it.
    const redirectUri = resolveGrokBotOAuthRedirect(
      window.location.origin,
      httpBaseUrl,
      config.data?.setupStatus?.mcpUrl ?? null,
    );
    if (activeFlow.current) endFlow(activeFlow.current);
    setNotice(null);
    if (redirectUri === null) {
      setError("This environment has no web address to return to. Reconnect and try again.");
      return;
    }
    const key = `${serverId}:${accountKey}`;
    // Opened synchronously so the click still counts as a user gesture.
    const popup = window.open("about:blank", "_blank");
    setPending(key);
    setError(null);
    const result = await authenticate({
      environmentId,
      input: { serverId, accountKey, redirectUri },
    });
    setPending(null);
    if (result._tag !== "Success") {
      popup?.close();
      setError("Authentication could not start. Please try again.");
      return;
    }
    const response = result.value;
    if (response.authenticated) {
      popup?.close();
      refreshAccounts();
      setNotice("Connector connected.");
      return;
    }
    if (!response.authorizationUrl || !response.stateId) {
      popup?.close();
      setError("This connector did not provide an authentication link.");
      return;
    }
    try {
      localStorage.setItem(
        PLUGIN_AUTH_STORAGE_PREFIX + response.stateId,
        JSON.stringify({ environmentId, pluginId }),
      );
      if (popup) {
        popup.opener = null;
        popup.location.href = response.authorizationUrl;
      }
      const startedAtMs = Date.now();
      const nextFlow = {
        environmentId,
        pluginId,
        serverId,
        accountKey,
        stateId: response.stateId,
        authorizationUrl: response.authorizationUrl,
        popup,
        completesOnServer: response.loopbackPort !== null,
        startedAtMs,
        expiresAtMs: startedAtMs + SIGN_IN_WAIT_MS,
      };
      activeFlow.current = nextFlow;
      setFlow(nextFlow);
    } catch {
      popup?.close();
      setError("Allow browser storage to finish connector authentication.");
    }
  });

  const submitCallback = async (current: SignInFlow) => {
    // The address holds a one-time code, so it leaves the field on every outcome.
    const value = callbackUrl;
    setCallbackUrl("");
    setError(null);
    const parsed = parseManualCallback(value, current.stateId);
    if (parsed._tag === "invalid") {
      setError(invalidAddressMessage[parsed.reason]);
      return;
    }
    if (parsed._tag === "denied") {
      endFlow(current, {
        error: "Sign-in was declined on the provider's page. Authenticate again to retry.",
      });
      return;
    }
    setSubmitting(true);
    const result = await complete({
      environmentId,
      input: { stateId: current.stateId, code: parsed.code },
    });
    setSubmitting(false);
    if (result._tag === "Success") {
      endFlow(current, { notice: "Connector connected." });
      refreshAccounts();
      return;
    }
    endFlow(current, { error: "Authentication could not finish. Authenticate again to retry." });
  };

  return (
    <section className="space-y-2" aria-label="Accounts">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground">Accounts</h4>
        <Button size="sm" variant="ghost-muted" disabled={query.isPending} onClick={query.refresh}>
          Refresh
        </Button>
      </div>
      {query.data === null && !query.error ? <Spinner size="xs" /> : null}
      {query.error ? (
        <p className="text-sm text-muted-foreground">
          Could not load connector accounts.{" "}
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        </p>
      ) : null}
      {query.data?.servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This plugin has no account connectors to authenticate.
        </p>
      ) : null}
      {query.data?.servers.map((server) => (
        <div key={server.id} className="divide-y rounded-xl border bg-card/40">
          <p className="px-3 py-2 text-sm font-medium">{server.name}</p>
          {server.accounts.map((account) => {
            const key = `${server.id}:${account.accountKey}`;
            const authenticated = account.status === "connected";
            return (
              <div
                key={account.accountKey}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
              >
                <span className="text-sm">{account.accountKey}</span>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {authenticated
                      ? "Connected"
                      : account.status === "needsAuth"
                        ? "Needs auth"
                        : account.status === "initializing"
                          ? "Connecting"
                          : "Status unavailable"}
                  </span>
                  {!authenticated && server.supportsOAuth ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!allowed || pending !== null}
                      onClick={() => void run(server.id, account.accountKey)}
                    >
                      {pending === key ? <Spinner size="xs" /> : null}Authenticate
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {flow ? (
        <div className="space-y-2 rounded-xl border p-3">
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {flow.completesOnServer ? (
              <>
                <Spinner size="xs" />
                Finish signing in in the new tab. This updates when sign-in completes.
              </>
            ) : (
              "Finish signing in in the new tab. This updates when sign-in completes. If the return page does not load, copy its full address from the address bar and paste it below."
            )}{" "}
            <a
              className="underline"
              href={flow.authorizationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open sign-in
            </a>
          </p>
          {flow.completesOnServer ? null : (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCallback(flow);
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
                disabled={submitting}
                onChange={(event) => setCallbackUrl(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={callbackUrl.trim() === "" || submitting}>
                {submitting ? <Spinner size="xs" /> : null}Finish sign-in
              </Button>
            </form>
          )}
          <Button size="sm" variant="ghost-muted" onClick={() => endFlow(flow)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
