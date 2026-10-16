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
import { CheckIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { museAgentFeatureReadQuery, museAgentFeatureUpdate } from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { loadMarketplaceIcon } from "../grokBot/marketplaceIconCache";

import { describeMuseConnector } from "./museAgentFeatures.logic";

type ReadInput = typeof NativeAgentFeatureReadInput.Type;
type Target = {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
};

/** Environment and Muse instance the native connect flow talks to. */
export type MuseAgentConnectorAuthTarget = Target;

export type MuseAgentConnectorAuthDialogProps = Target & {
  readonly connector: MuseAgentConnector;
  readonly onClose: () => void;
  /** Re-read connection state after sign-in. Never starts OAuth, never disconnects. */
  readonly onRecheck: () => void;
};
type Panel =
  | { readonly kind: "connect"; readonly connector: MuseAgentConnector }
  | { readonly kind: "disconnect"; readonly connector: MuseAgentConnector }
  | { readonly kind: "accounts"; readonly connector: MuseAgentConnector };

type BrowseCategory = "connected" | "available" | "attention" | "coming_soon";

const UNCERTAIN_WRITE =
  "Muse may not have finished this change. Refresh to check before trying again.";
const SECTION_PREVIEW = 4;
const CARD_CLASS =
  "min-w-0 rounded-xl border bg-card flex items-center gap-3 p-3 transition-colors hover:bg-accent/50";
const CATEGORY_ORDER: readonly BrowseCategory[] = [
  "connected",
  "available",
  "attention",
  "coming_soon",
];
const CATEGORY_TITLE: Record<BrowseCategory, string> = {
  connected: "Connected",
  available: "Available",
  attention: "Needs attention",
  coming_soon: "Coming soon",
};
const CATEGORY_FILTER_LABEL: Record<"all" | BrowseCategory, string> = {
  all: "All",
  ...CATEGORY_TITLE,
};
/** Simple Icons slugs that differ from Muse connector ids. Unlisted catalog ids use a sanitized id. */
const CONNECTOR_ICON_SLUGS: Readonly<Record<string, string>> = {
  google_calendar: "googlecalendar",
  google_drive: "googledrive",
  google_docs: "googledocs",
  google_mail: "gmail",
  gmail: "gmail",
  gohighlevel: "gohighlevel",
  highlevel: "gohighlevel",
  meta_business: "meta",
  microsoft_teams: "microsoftteams",
  ms_teams: "microsoftteams",
  office365: "microsoftoffice",
  onedrive: "microsoftonedrive",
  outlook: "microsoftoutlook",
  twitter: "x",
};

function browseCategory(connector: MuseAgentConnector): BrowseCategory {
  switch (connector.state) {
    case "connected":
      return "connected";
    case "coming_soon":
      return "coming_soon";
    case "unknown":
      return "attention";
    case "disconnected":
      return "available";
  }
}

function connectorMatches(connector: MuseAgentConnector, needle: string): boolean {
  if (needle === "") return true;
  return [connector.name, connector.description, connector.id].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

function connectorIconUrl(connector: MuseAgentConnector): string | null {
  if (connector.isCustom) return null;
  const mapped = CONNECTOR_ICON_SLUGS[connector.id];
  const slug = mapped ?? connector.id.trim().toLowerCase().replaceAll(/[_-]+/g, "");
  if (!/^[a-z][a-z0-9]{1,31}$/.test(slug)) return null;
  return `https://cdn.simpleicons.org/${slug}`;
}

function connectorTileColor(connector: MuseAgentConnector): string {
  let hash = 0;
  for (const char of connector.id || connector.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 45%)`;
}

function connectorInitial(connector: MuseAgentConnector): string {
  return (connector.name.trim() || connector.id.trim()).charAt(0).toUpperCase() || "?";
}

/** Catalog logo through the shared marketplace cache, with a letter tile that is never blank. */
function ConnectorLogo({
  connector,
  pixels = 44,
}: {
  readonly connector: MuseAgentConnector;
  readonly pixels?: number;
}) {
  const url = connectorIconUrl(connector);
  const color = connectorTileColor(connector);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [cached, setCached] = useState<{ source: string; blobUrl: string | null } | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const source = cached?.source === url ? (cached.blobUrl ?? url) : null;
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let blobUrl: string | undefined;
    void loadMarketplaceIcon(url).then((blob) => {
      if (cancelled) return;
      if (blob) blobUrl = URL.createObjectURL(blob);
      setCached({ source: url, blobUrl: blobUrl ?? null });
      setFailedUrl(null);
    });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url]);
  useEffect(() => {
    if (!url || loadedUrl === source) return;
    const timer = window.setTimeout(() => setFailedUrl(url), 10000);
    return () => window.clearTimeout(timer);
  }, [url, source, loadedUrl]);
  const showImage = source !== null && url !== failedUrl;
  return (
    <span
      className="relative inline-flex shrink-0 overflow-hidden rounded-xl bg-muted/60 ring-1 ring-border/60 ring-inset"
      style={{ width: pixels, height: pixels }}
    >
      {loadedUrl !== source || !showImage ? (
        <span
          aria-hidden
          className="flex size-full items-center justify-center font-semibold text-white"
          style={{
            backgroundImage: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 62%, black))`,
            fontSize: Math.round(pixels * 0.42),
          }}
        >
          {connectorInitial(connector)}
        </span>
      ) : null}
      {showImage ? (
        <img
          src={source ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={cn(
            "absolute inset-0 size-full object-cover",
            loadedUrl !== source && "opacity-0",
          )}
          onLoad={() => setLoadedUrl(source)}
          onError={() => setFailedUrl(url)}
        />
      ) : null}
    </span>
  );
}

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
      <p className="text-foreground">{connectErrorCopy(label, error)}</p>
      <p className="text-xs text-muted-foreground">{error}</p>
      <Button size="sm" variant="outline" className="w-fit" onClick={refresh}>
        Try again
      </Button>
    </div>
  );
}

function connectErrorCopy(label: string, error: string): string {
  const text = error.toLowerCase();
  if (text.includes("authenticated muse connection is unavailable"))
    return "Muse is not reachable right now. Retry when the connection is back.";
  if (
    text.includes("unavailable in the verified native protocol") ||
    text.includes("this muse feature is unavailable")
  )
    return `Muse cannot start this ${label} from T3 Code. Finish it in the Muse app, then refresh.`;
  if (text.includes("account or cloud workspace changed"))
    return "The Muse account changed. Reconnect Muse, then try this connection again.";
  if (text.includes("unsupported feature response"))
    return "Muse returned a sign-in T3 Code cannot use. Get a new sign-in link, or finish in the Muse app.";
  return `Muse ${label} could not be loaded.`;
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

/**
 * Native connector authorization: user-clicked https OAuth, API key, or a Muse-app-only path.
 * Closes once `connector.state` is `connected`. Does not complete OAuth itself.
 */
export function MuseAgentConnectorAuthDialog({
  environmentId,
  providerInstanceId,
  connector,
  onClose,
  onRecheck,
}: MuseAgentConnectorAuthDialogProps) {
  return (
    <ConnectDialog
      target={{ environmentId, providerInstanceId }}
      connector={connector}
      onClose={onClose}
      onRecheck={onRecheck}
    />
  );
}

function ConnectDialog({
  target,
  connector,
  onClose,
  onRecheck,
}: {
  readonly target: Target;
  readonly connector: MuseAgentConnector;
  readonly onClose: () => void;
  readonly onRecheck: () => void;
}) {
  const view = useConnectionRead(target.environmentId, {
    operation: "connector_info",
    providerInstanceId: target.providerInstanceId,
    connectorId: connector.id,
  });
  const action = view.data?.operation === "connector_info" ? view.data.data.action : null;
  useEffect(() => {
    if (connector.state === "connected") onClose();
  }, [connector.state, onClose]);
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
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Continue to sign in to {connector.name}. It opens in a new tab. When you finish, check the
          connection here; Muse only marks it connected after it reports the result.
        </p>
        <p className="text-xs text-muted-foreground">
          If the sign-in page says the link expired or is invalid, get a new one and continue again.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost-muted" onClick={view.refresh}>
            New sign-in link
          </Button>
          <Button size="sm" variant="outline" onClick={onRecheck}>
            Check connection
          </Button>
        </div>
      </div>
    ) : (
      <div className="grid gap-3">
        <p role="alert" className="text-sm text-destructive">
          Muse returned a sign-in link that is not a secure https address, so it was not opened.
        </p>
        <Button size="sm" variant="outline" className="w-fit" onClick={view.refresh}>
          Get a new sign-in link
        </Button>
      </div>
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
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {connector.name} uses a Muse-only sign-in. Open the Muse app to connect it, then check the
          connection here.
        </p>
        <Button size="sm" variant="outline" className="w-fit" onClick={onRecheck}>
          Check connection
        </Button>
      </div>
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

function ConnectorRow({
  connector,
  canWrite,
  onConnect,
  onAccounts,
  onDisconnect,
}: {
  readonly connector: MuseAgentConnector;
  readonly canWrite: boolean;
  readonly onConnect: () => void;
  readonly onAccounts: () => void;
  readonly onDisconnect: () => void;
}) {
  const state = describeMuseConnector(connector);
  return (
    <li className={CARD_CLASS}>
      <ConnectorLogo connector={connector} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">{connector.name}</span>
        {connector.description ? (
          <span className="line-clamp-1 text-xs leading-5 text-muted-foreground">
            {connector.description}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {connector.state === "connected" ? (
          <>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3.5" />
              Connected
            </span>
            <Button
              size="sm"
              variant="ghost-muted"
              aria-label={`Accounts for ${connector.name}`}
              onClick={onAccounts}
            >
              Accounts
            </Button>
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={!canWrite}
              aria-label={`Disconnect ${connector.name}`}
              onClick={onDisconnect}
            >
              Disconnect
            </Button>
          </>
        ) : connector.state === "coming_soon" ? (
          <span className="text-xs text-muted-foreground">{state.label}</span>
        ) : connector.state === "unknown" ? (
          <>
            <Badge variant="warning">{state.label}</Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite}
              aria-label={`Connect ${connector.name}`}
              onClick={onConnect}
            >
              Connect
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite}
            aria-label={`Connect ${connector.name}`}
            onClick={onConnect}
          >
            Connect
          </Button>
        )}
      </div>
    </li>
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
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | BrowseCategory>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<BrowseCategory>>(() => new Set());
  const close = () => setPanel(null);
  const liveConnector =
    panel === null
      ? null
      : (connectors?.find((connector) => connector.id === panel.connector.id) ?? panel.connector);

  const needle = search.trim().toLowerCase();
  const presentCategories = useMemo(() => {
    const present = new Set<BrowseCategory>();
    for (const connector of connectors ?? []) present.add(browseCategory(connector));
    return CATEGORY_ORDER.filter((key) => present.has(key));
  }, [connectors]);
  const selectedCategory: "all" | BrowseCategory =
    category === "all" || presentCategories.includes(category) ? category : "all";
  if (connectors !== null && category !== selectedCategory) setCategory(selectedCategory);
  const sections = useMemo(() => {
    if (connectors === null) return [];
    const buckets = new Map<BrowseCategory, MuseAgentConnector[]>();
    for (const connector of connectors) {
      if (!connectorMatches(connector, needle)) continue;
      if (selectedCategory !== "all" && browseCategory(connector) !== selectedCategory) continue;
      const key = browseCategory(connector);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(connector);
      else buckets.set(key, [connector]);
    }
    return CATEGORY_ORDER.flatMap((key) => {
      const items = buckets.get(key);
      if (!items?.length) return [];
      return [
        {
          key,
          title: CATEGORY_TITLE[key],
          items: items.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        },
      ];
    });
  }, [connectors, needle, selectedCategory]);
  const searching = needle !== "";

  if (connectors === null) {
    return view.error === null ? (
      <Loading label="connections" />
    ) : (
      <ReadError label="connections" error={view.error} refresh={view.refresh} />
    );
  }
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <Input
          placeholder="Search connections"
          aria-label="Search connections"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button size="touch-sm" variant="ghost-muted" onClick={view.refresh}>
          <RefreshIcon refreshing={view.isPending} />
          Refresh
        </Button>
      </div>
      {presentCategories.length > 1 ? (
        <div role="group" aria-label="Connection category" className="flex flex-wrap gap-1">
          {(["all", ...presentCategories] satisfies ReadonlyArray<"all" | BrowseCategory>).map(
            (key) => (
              <Button
                key={key}
                size="sm"
                variant={selectedCategory === key ? "secondary" : "ghost"}
                aria-pressed={selectedCategory === key}
                onClick={() => setCategory(key)}
              >
                {CATEGORY_FILTER_LABEL[key]}
              </Button>
            ),
          )}
        </div>
      ) : null}
      {view.error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          Could not refresh connections; showing the last result.
        </p>
      ) : null}
      {connectors.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">Muse reports no connections.</p>
      ) : sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches.</p>
      ) : (
        sections.map((section) => {
          const preview = searching || selectedCategory !== "all" || expanded.has(section.key);
          const shown = preview ? section.items : section.items.slice(0, SECTION_PREVIEW);
          return (
            <section key={section.key} className="space-y-2" aria-label={section.title}>
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-medium text-foreground">{section.title}</h4>
                {!preview && section.items.length > SECTION_PREVIEW ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => setExpanded((current) => new Set([...current, section.key]))}
                  >
                    View all
                  </Button>
                ) : null}
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {shown.map((connector) => (
                  <ConnectorRow
                    key={connector.id}
                    connector={connector}
                    canWrite={canWrite}
                    onConnect={() => setPanel({ kind: "connect", connector })}
                    onAccounts={() => setPanel({ kind: "accounts", connector })}
                    onDisconnect={() => setPanel({ kind: "disconnect", connector })}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
      {panel?.kind === "connect" && liveConnector ? (
        <MuseAgentConnectorAuthDialog
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          connector={liveConnector}
          onClose={close}
          onRecheck={view.refresh}
        />
      ) : null}
      {panel?.kind === "disconnect" && liveConnector ? (
        <DisconnectDialog
          target={target}
          connector={liveConnector}
          onClose={close}
          onChanged={view.refresh}
        />
      ) : null}
      {panel?.kind === "accounts" && liveConnector ? (
        <AccountsDialog
          target={target}
          connector={liveConnector}
          canWrite={canWrite}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
