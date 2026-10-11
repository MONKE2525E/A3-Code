import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon, ArrowUpRightIcon, BoxIcon, CheckIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import {
  grokBotsInstallMarketplacePlugin,
  grokBotsUninstallMarketplacePlugin,
} from "~/state/grokBots";
import { useAtomCommand } from "~/state/use-atom-command";

import { PluginLogo } from "./GrokBotMarketplaceAvatar";
import { GrokBotPluginAccounts } from "./GrokBotPluginAccounts";
import {
  pluginCapabilitySummary,
  pluginCategoryTitle,
  type MarketplacePlugin,
} from "./grokBotMarketplaceCatalog";
import { grokBotFailureMessage } from "./grokBotPresentation";

/** One catalog plugin, with install and uninstall for the signed-in Grok Bot account. */
export function MarketplacePluginDetail({
  environmentId,
  plugin,
  installed,
  onChanged,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: MarketplacePlugin;
  readonly installed: boolean;
  /** Called after any install or uninstall attempt, since a slow call can succeed after it reports failure. */
  readonly onChanged: () => void;
  readonly onBack: () => void;
}) {
  const category = plugin.categoryKeys[0];
  return (
    <div className="space-y-5">
      <Button size="sm" variant="ghost-muted" onClick={onBack}>
        <ArrowLeftIcon />
        Marketplace
      </Button>

      <header className="flex min-w-0 flex-wrap items-center gap-4">
        <PluginLogo plugin={plugin} pixels={56} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-medium text-foreground">{plugin.displayName}</h3>
          {plugin.repositoryUrl ? (
            <a
              href={plugin.repositoryUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground"
            >
              View Source
              <ArrowUpRightIcon className="size-3.5" />
            </a>
          ) : null}
        </div>
        {installed ? (
          <InstalledState environmentId={environmentId} plugin={plugin} onChanged={onChanged} />
        ) : null}
      </header>

      {plugin.description ? (
        <p className="text-sm leading-6 text-foreground">{plugin.description}</p>
      ) : null}

      {installed ? null : (
        <InstallForm environmentId={environmentId} plugin={plugin} onChanged={onChanged} />
      )}

      {installed && plugin.connectorCount > 0 ? (
        <GrokBotPluginAccounts environmentId={environmentId} pluginId={plugin.id} />
      ) : null}

      {plugin.skills.length > 0 ? (
        <section className="space-y-2" aria-label="Skills">
          <h4 className="text-xs font-medium text-muted-foreground">
            Skills <span className="ml-1">{plugin.skills.length}</span>
          </h4>
          <ul className="divide-y rounded-xl border bg-card/40">
            {plugin.skills.map((skill, index) => (
              <li key={`${skill.name}-${index}`} className="flex items-start gap-3 px-3 py-2.5">
                <BoxIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{skill.name}</span>
                  {skill.description ? (
                    <span className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {skill.description}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2" aria-label="Information">
        <h4 className="text-xs font-medium text-muted-foreground">Information</h4>
        <dl className="divide-y rounded-xl border bg-card/40 text-sm">
          <InfoRow label="Capabilities" value={pluginCapabilitySummary(plugin)} />
          {plugin.publisherName ? <InfoRow label="Developer" value={plugin.publisherName} /> : null}
          {category ? <InfoRow label="Category" value={pluginCategoryTitle(category)} /> : null}
          {plugin.websiteUrl ? (
            <InfoRow
              label="Website"
              value={
                <a
                  href={plugin.websiteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground"
                >
                  {websiteLabel(plugin.websiteUrl)}
                </a>
              }
            />
          ) : null}
        </dl>
      </section>
    </div>
  );
}

/** Install asks for the plugin's own settings first. Sign-in for its connectors happens in the Grok Bot app. */
function InstallForm({
  environmentId,
  plugin,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: MarketplacePlugin;
  readonly onChanged: () => void;
}) {
  const allowed = useAtomValue(grokBotsInstallMarketplacePlugin.permissionAtom(environmentId));
  const install = useAtomCommand(grokBotsInstallMarketplacePlugin, { reportFailure: false });
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = plugin.variables.some(
    (variable) => variable.required && (values[variable.key] ?? "").trim() === "",
  );

  const run = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const filled = Object.fromEntries(
      plugin.variables.flatMap((variable) => {
        const value = (values[variable.key] ?? "").trim();
        return value === "" ? [] : [[variable.key, value] as const];
      }),
    );
    const result = await install({
      environmentId,
      input: {
        pluginId: plugin.id,
        ...(Object.keys(filled).length > 0 ? { variables: filled } : {}),
      },
    });
    setPending(false);
    onChanged();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(grokBotFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <section className="space-y-3 rounded-xl border bg-card/40 p-3" aria-label="Install">
      {plugin.needsAppSetup ? (
        <p className="text-sm text-muted-foreground">
          This plugin asks for settings T3 Code cannot collect. Install it in the Grok Bot app.
        </p>
      ) : (
        <>
          {plugin.variables.map((variable) => (
            <label key={variable.key} className="block space-y-1">
              <span className="text-sm font-medium">
                {variable.label}
                {variable.required ? null : (
                  <span className="ml-1 font-normal text-muted-foreground">Optional</span>
                )}
              </span>
              {variable.description ? (
                <span className="block text-xs text-muted-foreground">{variable.description}</span>
              ) : null}
              <Input
                type={variable.secret ? "password" : "text"}
                autoComplete="off"
                value={values[variable.key] ?? ""}
                onChange={(event) =>
                  setValues((previous) => ({ ...previous, [variable.key]: event.target.value }))
                }
              />
            </label>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!allowed || pending || missing} onClick={() => void run()}>
              {pending ? <Spinner size="xs" /> : null}
              Install
            </Button>
            {allowed ? null : (
              <span className="text-xs text-muted-foreground">Needs settings write access</span>
            )}
          </div>
        </>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}

function InstalledState({
  environmentId,
  plugin,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: MarketplacePlugin;
  readonly onChanged: () => void;
}) {
  const allowed = useAtomValue(grokBotsUninstallMarketplacePlugin.permissionAtom(environmentId));
  const uninstall = useAtomCommand(grokBotsUninstallMarketplacePlugin, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await uninstall({ environmentId, input: { pluginId: plugin.id } });
    setPending(false);
    onChanged();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(grokBotFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <CheckIcon className="size-4" />
          Installed
        </span>
        <Button variant="outline" disabled={!allowed || pending} onClick={() => void run()}>
          {pending ? <Spinner size="xs" /> : null}
          Uninstall
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function InfoRow({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <dt>{label}</dt>
      <dd className="min-w-0 truncate text-muted-foreground">{value}</dd>
    </div>
  );
}

function websiteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
