import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "~/state/environments";
import { grokBotsPluginCompleteAuth } from "~/state/grokBots";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  clearPluginAuthReturn,
  finishPluginAuthReturn,
  pluginAuthStateId,
  readPluginAuthReturn,
} from "./grokBotPluginAuthReturn";
import { PLUGIN_AUTH_STORAGE_PREFIX } from "./GrokBotPluginAccounts";

const completionRequests = new Map<string, Promise<boolean>>();
const connectedMessage = "Connector connected. You can close this tab and return to the plugin.";
const failedMessage = "Authentication could not finish. Return to the plugin and try again.";

const decodeFlow = Schema.decodeUnknownOption(
  Schema.Struct({ environmentId: EnvironmentId, pluginId: Schema.String }),
);
function readCallback() {
  const url = new URL(window.location.href);
  const params =
    url.searchParams.get("grokBotOAuth") === "1" ? url.searchParams : readPluginAuthReturn();
  if (!params) return null;
  // The relayed state may carry a loopback port; the id this page stored and the server issued does not.
  const state = params.get("state");
  const stateId = state ? pluginAuthStateId(state) : null;
  const code = params.get("code");
  const denied = params.has("error");
  const result = params.get("t3AuthResult");
  try {
    const flow = stateId
      ? Option.getOrNull(
          decodeFlow(
            JSON.parse(localStorage.getItem(PLUGIN_AUTH_STORAGE_PREFIX + stateId) ?? "null"),
          ),
        )
      : null;
    return { stateId, code, denied, flow, result };
  } catch {
    return { stateId, code, denied, flow: null, result };
  }
}

/**
 * Deliver only the one-time code to the environment that started this flow. The flow is kept in
 * this origin's storage, so a return landing in another browser has none; that page is served by
 * the environment itself, so the code goes to its primary environment, which still checks state.
 */
export function GrokBotPluginAuthCallback() {
  const [callback] = useState(readCallback);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const storedFlow = callback?.flow ?? null;
  const flow =
    storedFlow ??
    (primaryEnvironmentId === null ? null : { environmentId: primaryEnvironmentId, pluginId: "" });
  const [message, setMessage] = useState(() =>
    callback?.result === "connected"
      ? connectedMessage
      : callback?.result === "failed"
        ? failedMessage
        : callback?.denied
          ? "Sign-in was canceled. Return to the plugin to try again."
          : callback && (!callback.stateId || !callback.code)
            ? "This sign-in link has expired. Return to the plugin to start again."
            : "Finishing connector authentication…",
  );
  const complete = useAtomCommand(grokBotsPluginCompleteAuth, { reportFailure: false });
  const started = useRef(false);
  const connected = useConnectedEnvironmentIds();
  useEffect(() => {
    if (callback && window.location.search)
      window.history.replaceState(window.history.state, "", "/settings/marketplace");
  }, [callback]);
  useEffect(() => {
    if (!callback || started.current) return;
    const { stateId, code, denied } = callback;
    // Without a stored flow the primary environment is still resolving; the code is not spent yet.
    if (!denied && stateId && code && (!flow || !connected.includes(flow.environmentId))) return;
    started.current = true;

    if (callback.result || denied || !stateId || !code || !flow) {
      if (stateId) localStorage.removeItem(PLUGIN_AUTH_STORAGE_PREFIX + stateId);
      return;
    }
    let request = completionRequests.get(stateId);
    if (!request) {
      request = complete({ environmentId: flow.environmentId, input: { stateId, code } })
        .then((result) => result._tag === "Success")
        .catch(() => false);
      completionRequests.set(stateId, request);
      if (completionRequests.size > 100) {
        const oldest = completionRequests.keys().next().value;
        if (oldest) completionRequests.delete(oldest);
      }
    }
    void request.then((success) => {
      finishPluginAuthReturn(success ? "connected" : "failed");
      if (success) localStorage.removeItem(PLUGIN_AUTH_STORAGE_PREFIX + stateId);
      setMessage(success ? connectedMessage : failedMessage);
    });
  }, [callback, complete, connected, flow]);
  if (!callback) return null;
  return (
    <section className="space-y-3 rounded-xl border p-4" aria-label="Connector authentication">
      <p role="status" className="text-sm">
        {message}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          clearPluginAuthReturn();
          window.location.assign("/settings/marketplace");
        }}
      >
        Return to marketplace
      </Button>
    </section>
  );
}
