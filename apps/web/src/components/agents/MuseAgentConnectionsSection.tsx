import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type MuseAgentConnector,
  type NativeAgentFeatureReadInput,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState, type ReactNode } from "react";
import { Input } from "~/components/ui/input";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { museAgentFeatureReadQuery, museAgentFeatureUpdate } from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { describeMuseConnector } from "./museAgentFeatures.logic";

type ReadInput = typeof NativeAgentFeatureReadInput.Type;
type Target = {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
};
type Panel =
  | { readonly kind: "connect"; readonly connector: MuseAgentConnector }
  | { readonly kind: "disconnect"; readonly connector: MuseAgentConnector }
  | { readonly kind: "accounts"; readonly connector: MuseAgentConnector };

const UNCERTAIN_WRITE =
  "Muse may not have finished this change. Refresh to check before trying again.";

/** Only a plain https link is ever offered to the user; anything else is dropped. */
function safeHttpsUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** A user-clicked link, so the browser never sees a popup opened from async code. */
function ContinueLink({ href }: { readonly href: string }) {
  return (
    <Button render={<a href={href} target="_blank" rel="noopener noreferrer" />}>
      Continue in browser
    </Button>
  );
}

function useConnectionRead(environmentId: EnvironmentId, input: ReadInput | null) {
  return useEnvironmentQuery(
    input === null ? null : museAgentFeatureReadQuery({ environmentId, input }),
  );
}

function Loading({ label }: { readonly label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Spinner className="size-4" /> Loading {label}…
    </div>
  );
}

function ReadError({
  label,
  error,
  refresh,
}: {
  readonly label: string;
  readonly error: string;
  readonly refresh: () => void;
}) {
  return (
    <div role="alert" className="grid gap-2 py-4 text-sm">
      <p className="text-foreground">Muse {label} could not be loaded.</p>
      <p className="text-xs text-muted-foreground">{error}</p>
      <Button size="sm" variant="outline" className="w-fit" onClick={refresh}>
        Try again
      </Button>
    </div>
  );
}

function useConnectionWrite(target: Target) {
  const update = useAtomCommand(museAgentFeatureUpdate, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    input:
      | { operation: "connector_disconnect"; connectorId: string }
      | { operation: "connector_unlink"; connectorId: string; accountId: string }
      | { operation: "connector_link"; connectorId: string },
  ) => {
    setPending(true);
    setError(null);
    // One attempt only. A failed write may still have landed, so it is never retried here.
    const result = await update({
      environmentId: target.environmentId,
      input: { ...input, providerInstanceId: target.providerInstanceId },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error && failure.message
            ? `${failure.message} ${UNCERTAIN_WRITE}`
            : UNCERTAIN_WRITE,
        );
      }
      return null;
    }
    return result.value;
  };
  return { run, pending, error, clearError: () => setError(null) };
}

function ConnectDialog({
  target,
  connector,
  onClose,
}: {
  readonly target: Target;
  readonly connector: MuseAgentConnector;
  readonly onClose: () => void;
}) {
  const view = useConnectionRead(target.environmentId, {
    operation: "connector_info",
    providerInstanceId: target.providerInstanceId,
    connectorId: connector.id,
  });
  const action = view.data?.operation === "connector_info" ? view.data.data.action : null;
  let body: ReactNode;
  let link: string | null = null;
  if (action === null) {
    body =
      view.error === null ? (
        <Loading label="connection details" />
      ) : (
        <ReadError label="connection details" error={view.error} refresh={view.refresh} />
      );
  } else if (action.type === "oauth") {
    link = safeHttpsUrl(action.authorizationUrl);
    body = link ? (
      <p className="text-sm text-muted-foreground">
        Continue to sign in to {connector.name}. It opens in a new tab. Come back here and refresh
        once you have finished; the connection only shows as connected after Muse reports it.
      </p>
    ) : (
      <p role="alert" className="text-sm text-destructive">
        Muse returned a sign-in link that is not a secure https address, so it was not opened.
      </p>
    );
  } else if (action.type === "none") {
    body = (
      <p className="text-sm text-muted-foreground">
        Muse offers no connection step for {connector.name} from here.
      </p>
    );
  } else if (action.type === "api_key" || action.type === "consent_only") {
    body = (
      <ConnectorCredentialForm
        target={target}
        connector={connector}
        authType={action.type}
        onConnected={onClose}
      />
    );
  } else {
    body = (
      <p className="text-sm text-muted-foreground">
        {connector.name} needs a step that cannot be done from T3 Code. Finish connecting in the
        Muse app, then refresh this list.
      </p>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Connect {connector.name}</DialogTitle>
        </DialogHeader>
        <DialogPanel>{body}</DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {link ? <ContinueLink href={link} /> : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ConnectorCredentialForm({
  target,
  connector,
  authType,
  onConnected,
}: {
  readonly target: Target;
  readonly connector: MuseAgentConnector;
  readonly authType: "api_key" | "consent_only";
  readonly onConnected: () => void;
}) {
  const secret = useRef<HTMLInputElement>(null);
  const canWrite = useAtomValue(
    museAgentFeatureUpdate.permissionAtom(target.environmentId, { operation: "connector_auth" }),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = useAtomCommand(museAgentFeatureUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  return (
    <form
      className="grid gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending || !canWrite) return;
        setPending(true);
        setError(null);
        const key = secret.current?.value;
        if (secret.current) secret.current.value = "";
        const result = await update({
          environmentId: target.environmentId,
          input: {
            operation: "connector_auth",
            providerInstanceId: target.providerInstanceId,
            connectorId: connector.id,
            authType,
            ...(key === undefined ? {} : { key }),
          },
        });
        setPending(false);
        if (result._tag === "Success") onConnected();
        else if (!isAtomCommandInterrupted(result))
          setError(
            "Muse could not confirm this connection. Refresh its status before trying again.",
          );
      }}
    >
      {authType === "api_key" ? (
        <>
          <label htmlFor={`muse-key-${connector.id}`} className="text-sm font-medium">
            API key
          </label>
          <Input
            id={`muse-key-${connector.id}`}
            ref={secret}
            type="password"
            autoComplete="off"
            required
            maxLength={65536}
          />
          <p className="text-xs text-muted-foreground">
            Sent directly to Muse's credential service. It is never added to chat or model context.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Allow Muse to connect to {connector.name}?</p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={!canWrite || pending || error !== null}>
        {pending ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}

function DisconnectDialog({
  target,
  connector,
  onClose,
  onChanged,
}: {
  readonly target: Target;
  readonly connector: MuseAgentConnector;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const write = useConnectionWrite(target);
  return (
    <AlertDialog open onOpenChange={(open) => (open || write.pending ? null : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {connector.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Muse will lose access to {connector.name}. You can connect it again later.
          </AlertDialogDescription>
          {write.error ? (
            <p role="alert" className="text-sm text-destructive">
              {write.error}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />} disabled={write.pending}>
            Keep connected
          </AlertDialogClose>
          {write.error ? (
            <Button variant="outline" onClick={onChanged}>
              Refresh list
            </Button>
          ) : null}
          <Button
            variant="destructive"
            disabled={write.pending || write.error !== null}
            onClick={() =>
              void write
                .run({ operation: "connector_disconnect", connectorId: connector.id })
                .then((value) => {
                  if (value === null) return;
                  onChanged();
                  onClose();
                })
            }
          >
            {write.pending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function AccountsDialog({
  target,
  connector,
  canWrite,
  onClose,
}: {
  readonly target: Target;
  readonly connector: MuseAgentConnector;
  readonly canWrite: boolean;
  readonly onClose: () => void;
}) {
  const view = useConnectionRead(target.environmentId, {
    operation: "connector_accounts",
    providerInstanceId: target.providerInstanceId,
    connectorId: connector.id,
  });
  const write = useConnectionWrite(target);
  const accounts = view.data?.operation === "connector_accounts" ? view.data.data : null;
  const [unlinking, setUnlinking] = useState<{ id: string; name: string } | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);

  const addAccount = async () => {
    setLinkUrl(null);
    setLinkNotice(null);
    const value = await write.run({ operation: "connector_link", connectorId: connector.id });
    if (value === null) return;
    const url = safeHttpsUrl(value.authorizationUrl);
    if (url) setLinkUrl(url);
    else if (value.authorizationUrl) {
      setLinkNotice(
        "Muse returned a link that is not a secure https address, so it was not shown.",
      );
    } else {
      setLinkNotice("Finish adding the account in the Muse app, then refresh.");
    }
    view.refresh();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{connector.name} accounts</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            {accounts === null ? (
              view.error === null ? (
                <Loading label="accounts" />
              ) : (
                <ReadError label="accounts" error={view.error} refresh={view.refresh} />
              )
            ) : !accounts.supported ? (
              <p className="text-sm text-muted-foreground">
                Muse does not list separate accounts for {connector.name}.
              </p>
            ) : accounts.accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No linked accounts.</p>
            ) : (
              <ul className="grid gap-2">
                {accounts.accounts.map((account) => {
                  const name = account.displayName?.trim() || "Unnamed account";
                  return (
                    <li
                      key={account.accountId}
                      className="flex min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-2.5"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{name}</span>
                        {account.isDefault ? <Badge variant="outline">Default</Badge> : null}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost-destructive"
                        disabled={!canWrite || write.pending}
                        aria-label={`Unlink ${name}`}
                        onClick={() => {
                          write.clearError();
                          setUnlinking({ id: account.accountId, name });
                        }}
                      >
                        Unlink
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {write.error && unlinking === null ? (
              <p role="alert" className="text-xs text-destructive">
                {write.error}
              </p>
            ) : null}
            {linkNotice ? <p className="text-xs text-muted-foreground">{linkNotice}</p> : null}
            {linkUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <ContinueLink href={linkUrl} />
                <span className="text-xs text-muted-foreground">
                  Finish in the new tab, then refresh.
                </span>
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={view.refresh}>
            Refresh
          </Button>
          {accounts?.supported ? (
            <Button disabled={!canWrite || write.pending} onClick={() => void addAccount()}>
              {write.pending && unlinking === null ? "Starting…" : "Add account"}
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
      <AlertDialog
        open={unlinking !== null}
        onOpenChange={(open) => (open || write.pending ? null : setUnlinking(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink this account?</AlertDialogTitle>
            <AlertDialogDescription>
              “{unlinking?.name}” will be removed from {connector.name} in Muse.
            </AlertDialogDescription>
            {write.error ? (
              <p role="alert" className="text-sm text-destructive">
                {write.error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={write.pending}>
              Keep account
            </AlertDialogClose>
            {write.error ? (
              <Button variant="outline" onClick={view.refresh}>
                Refresh accounts
              </Button>
            ) : null}
            <Button
              variant="destructive"
              disabled={write.pending || write.error !== null}
              onClick={() => {
                if (!unlinking) return;
                void write
                  .run({
                    operation: "connector_unlink",
                    connectorId: connector.id,
                    accountId: unlinking.id,
                  })
                  .then((value) => {
                    if (value === null) return;
                    view.refresh();
                    setUnlinking(null);
                  });
              }}
            >
              {write.pending ? "Unlinking…" : "Unlink"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Dialog>
  );
}

/**
 * Connection management for Muse. Secret forms bypass chat; connection state comes from Muse.
 */
export function MuseAgentConnectionsSection({
  environmentId,
  providerInstanceId,
  canWrite,
}: Target & { readonly canWrite: boolean }) {
  const target = { environmentId, providerInstanceId };
  const view = useConnectionRead(environmentId, { operation: "connectors", providerInstanceId });
  const connectors = view.data?.operation === "connectors" ? view.data.data : null;
  const [panel, setPanel] = useState<Panel | null>(null);
  const close = () => setPanel(null);

  if (connectors === null) {
    return view.error === null ? (
      <Loading label="connections" />
    ) : (
      <ReadError label="connections" error={view.error} refresh={view.refresh} />
    );
  }
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Connect, disconnect, and manage linked accounts. Some providers finish sign-in in a
          browser.
        </p>
        <Button size="xs" variant="ghost" onClick={view.refresh}>
          Refresh
        </Button>
      </div>
      {view.error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          Could not refresh connections; showing the last result.
        </p>
      ) : null}
      {connectors.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">Muse reports no connections.</p>
      ) : (
        <ul className="grid gap-2">
          {connectors.map((connector) => {
            const state = describeMuseConnector(connector);
            return (
              <li
                key={connector.id}
                className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2.5"
              >
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">
                    {connector.name}
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {connector.description}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Badge
                    variant={
                      state.tone === "success"
                        ? "success"
                        : state.tone === "warning"
                          ? "warning"
                          : "outline"
                    }
                  >
                    {state.label}
                  </Badge>
                  {connector.state === "connected" ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        aria-label={`Accounts for ${connector.name}`}
                        onClick={() => setPanel({ kind: "accounts", connector })}
                      >
                        Accounts
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost-destructive"
                        disabled={!canWrite}
                        aria-label={`Disconnect ${connector.name}`}
                        onClick={() => setPanel({ kind: "disconnect", connector })}
                      >
                        Disconnect
                      </Button>
                    </>
                  ) : connector.state === "disconnected" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canWrite}
                      aria-label={`Connect ${connector.name}`}
                      onClick={() => setPanel({ kind: "connect", connector })}
                    >
                      Connect
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {panel?.kind === "connect" ? (
        <ConnectDialog target={target} connector={panel.connector} onClose={close} />
      ) : null}
      {panel?.kind === "disconnect" ? (
        <DisconnectDialog
          target={target}
          connector={panel.connector}
          onClose={close}
          onChanged={view.refresh}
        />
      ) : null}
      {panel?.kind === "accounts" ? (
        <AccountsDialog
          target={target}
          connector={panel.connector}
          canWrite={canWrite}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
