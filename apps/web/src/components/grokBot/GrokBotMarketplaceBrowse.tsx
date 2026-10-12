import { ArrowLeftIcon, CheckIcon, PlusIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import {
  grokBotsInstalledPluginsQuery,
  grokBotsMarketplacePluginsQuery,
  grokBotsMarketplaceQuery,
} from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";

import { CreatorAvatar, ListingAvatar, PluginLogo } from "./GrokBotMarketplaceAvatar";
import { MarketplaceBotDetail } from "./GrokBotMarketplaceBotDetail";
import { MarketplacePluginDetail } from "./GrokBotMarketplacePluginDetail";
import {
  groupListingsByCategory,
  groupPluginsByCategory,
  pluginCapabilitySummary,
  searchMarketplace,
  type MarketplaceListing,
  type MarketplacePlugin,
  type MarketplaceSection,
} from "./grokBotMarketplaceCatalog";
import { parseGrokBotTemplateLink } from "./grokBotTemplateLink";

/** Rows shown per section before "View all". */
const SECTION_PREVIEW = 4;

type View =
  | { readonly kind: "home" }
  | { readonly kind: "bot"; readonly listing: MarketplaceListing }
  | { readonly kind: "sharedBot"; readonly shareId: string }
  | { readonly kind: "plugin"; readonly plugin: MarketplacePlugin }
  | { readonly kind: "bots"; readonly section: MarketplaceSection<MarketplaceListing> }
  | { readonly kind: "plugins"; readonly section: MarketplaceSection<MarketplacePlugin> };

/** Browses the public Grok Bot marketplace: bot templates to import and the plugin catalog. */
export function GrokBotMarketplaceBrowse({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const [view, setView] = useState<View>({ kind: "home" });
  const installedQuery = useEnvironmentQuery(
    grokBotsInstalledPluginsQuery({ environmentId, input: {} }),
  );
  const installed = useMemo(
    () => new Set(installedQuery.data?.pluginIds ?? []),
    [installedQuery.data],
  );
  return (
    <MarketplaceViews
      environmentId={environmentId}
      installed={installed}
      onInstalledChanged={() => installedQuery.refresh()}
      view={view}
      setView={setView}
    />
  );
}

function MarketplaceViews({
  environmentId,
  installed,
  onInstalledChanged,
  view,
  setView,
}: {
  readonly environmentId: EnvironmentId;
  readonly installed: ReadonlySet<string>;
  readonly onInstalledChanged: () => void;
  readonly view: View;
  readonly setView: (view: View) => void;
}) {
  const home = () => setView({ kind: "home" });
  switch (view.kind) {
    case "bot":
      return (
        <MarketplaceBotDetail
          environmentId={environmentId}
          shareId={view.listing.shareId}
          listing={view.listing}
          onBack={home}
        />
      );
    case "sharedBot":
      return (
        <MarketplaceBotDetail environmentId={environmentId} shareId={view.shareId} onBack={home} />
      );
    case "plugin":
      return (
        <MarketplacePluginDetail
          environmentId={environmentId}
          plugin={view.plugin}
          installed={installed.has(view.plugin.id)}
          onChanged={onInstalledChanged}
          onBack={home}
        />
      );
    case "bots":
      return (
        <SectionPage title={view.section.title} onBack={home}>
          <BotRows
            environmentId={environmentId}
            listings={view.section.items}
            onOpen={(listing) => setView({ kind: "bot", listing })}
          />
        </SectionPage>
      );
    case "plugins":
      return (
        <SectionPage title={view.section.title} onBack={home}>
          <PluginRows
            installed={installed}
            plugins={view.section.items}
            onOpen={(plugin) => setView({ kind: "plugin", plugin })}
          />
        </SectionPage>
      );
    case "home":
      return (
        <MarketplaceHome environmentId={environmentId} installed={installed} setView={setView} />
      );
  }
}

function MarketplaceHome({
  environmentId,
  installed,
  setView,
}: {
  readonly environmentId: EnvironmentId;
  readonly installed: ReadonlySet<string>;
  readonly setView: (view: View) => void;
}) {
  const bots = useEnvironmentQuery(grokBotsMarketplaceQuery({ environmentId, input: {} }));
  const catalog = useEnvironmentQuery(
    grokBotsMarketplacePluginsQuery({ environmentId, input: {} }),
  );
  const [search, setSearch] = useState("");
  const botData = bots.data;
  const plugins = catalog.data?.plugins;
  const searching = search.trim() !== "";

  // Featured listings are sent separately and may be missing from the main list.
  const allListings = useMemo(
    () =>
      botData === null
        ? []
        : [
            ...new Map(
              [...botData.featured, ...botData.listings].map(
                (listing) => [listing.shareId, listing] as const,
              ),
            ).values(),
          ],
    [botData],
  );
  const botSections = useMemo(
    () => (botData === null ? [] : groupListingsByCategory(allListings, botData.categories)),
    [allListings, botData],
  );
  const pluginSections = useMemo(
    () => (plugins === undefined ? [] : groupPluginsByCategory(plugins)),
    [plugins],
  );
  const results = useMemo(
    () =>
      searching && botData !== null ? searchMarketplace(search, allListings, plugins ?? []) : null,
    [searching, search, botData, allListings, plugins],
  );

  const openBot = (listing: MarketplaceListing) => setView({ kind: "bot", listing });
  const openPlugin = (plugin: MarketplacePlugin) => setView({ kind: "plugin", plugin });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
        <div className="relative col-span-3 min-w-0 sm:col-span-1">
          <Input
            placeholder="Search plugins and Bots"
            aria-label="Search the marketplace"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="col-start-2">
          <ImportFromLinkPopover onPreview={(shareId) => setView({ kind: "sharedBot", shareId })} />
        </div>
        <Button
          size="touch-sm"
          variant="ghost-muted"
          onClick={() => {
            bots.refresh();
            catalog.refresh();
          }}
        >
          <RefreshIcon refreshing={bots.isPending || catalog.isPending} />
          Refresh
        </Button>
      </div>

      {bots.error ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">{bots.error}</span>
          <Button size="sm" variant="outline" onClick={() => bots.refresh()}>
            Retry
          </Button>
        </div>
      ) : botData === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="xs" />
          Loading the marketplace
        </div>
      ) : results !== null ? (
        <SearchResults
          installed={installed}
          environmentId={environmentId}
          results={results}
          onOpenBot={openBot}
          onOpenPlugin={openPlugin}
        />
      ) : (
        <>
          {botData.featured.length > 0 ? (
            <Section title="Featured Bots">
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {botData.featured.map((listing) => (
                  <FeaturedBotCard
                    key={listing.shareId}
                    environmentId={environmentId}
                    listing={listing}
                    onOpen={openBot}
                  />
                ))}
              </div>
            </Section>
          ) : null}

          {botSections.map((section) => (
            <Section
              key={`bots:${section.key}`}
              title={section.title}
              onViewAll={
                section.items.length > SECTION_PREVIEW
                  ? () => setView({ kind: "bots", section })
                  : undefined
              }
            >
              <BotRows
                environmentId={environmentId}
                listings={section.items.slice(0, SECTION_PREVIEW)}
                onOpen={openBot}
              />
            </Section>
          ))}

          {catalog.error ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                Plugins could not be loaded. {catalog.error}
              </span>
              <Button size="sm" variant="outline" onClick={() => catalog.refresh()}>
                Retry
              </Button>
            </div>
          ) : plugins === undefined ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="xs" />
              Loading plugins
            </div>
          ) : (
            pluginSections.map((section) => (
              <Section
                key={`plugins:${section.key}`}
                title={section.title}
                onViewAll={
                  section.items.length > SECTION_PREVIEW
                    ? () => setView({ kind: "plugins", section })
                    : undefined
                }
              >
                <PluginRows
                  installed={installed}
                  plugins={section.items.slice(0, SECTION_PREVIEW)}
                  onOpen={openPlugin}
                />
              </Section>
            ))
          )}
        </>
      )}
    </div>
  );
}

/** Opens a share-link field without crowding the marketplace search on phones. */
function ImportFromLinkPopover({ onPreview }: { readonly onPreview: (shareId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setLinkError(null);
      }}
    >
      <PopoverTrigger
        render={
          <Button size="icon-touch-sm" variant="outline" aria-label="Import from a share link" />
        }
      >
        <PlusIcon />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="md" padding="compact">
        <form
          className="space-y-2 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            const shareId = parseGrokBotTemplateLink(shareLink);
            if (shareId === null) {
              setLinkError("Enter a Grok Bot share link, such as https://x.ai/bot/…");
              return;
            }
            setLinkError(null);
            setOpen(false);
            onPreview(shareId);
          }}
        >
          <label
            htmlFor="grok-bot-share-link"
            className="text-xs font-medium text-muted-foreground"
          >
            Import from a share link
          </label>
          <Input
            id="grok-bot-share-link"
            placeholder="https://x.ai/bot/…"
            value={shareLink}
            onChange={(event) => {
              setShareLink(event.target.value);
              setLinkError(null);
            }}
            aria-invalid={linkError !== null}
            aria-describedby={linkError ? "grok-bot-share-link-error" : undefined}
          />
          {linkError ? (
            <p id="grok-bot-share-link-error" role="alert" className="text-sm text-destructive">
              {linkError}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="touch-sm" variant="outline" disabled={!shareLink.trim()}>
              Preview Bot
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function SearchResults({
  environmentId,
  installed,
  results,
  onOpenBot,
  onOpenPlugin,
}: {
  readonly environmentId: EnvironmentId;
  readonly installed: ReadonlySet<string>;
  readonly results: { readonly bots: MarketplaceListing[]; readonly plugins: MarketplacePlugin[] };
  readonly onOpenBot: (listing: MarketplaceListing) => void;
  readonly onOpenPlugin: (plugin: MarketplacePlugin) => void;
}) {
  if (results.bots.length === 0 && results.plugins.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing matches.</p>;
  }
  return (
    <div className="space-y-6">
      {results.plugins.length > 0 ? (
        <Section title="Plugins">
          <PluginRows installed={installed} plugins={results.plugins} onOpen={onOpenPlugin} />
        </Section>
      ) : null}
      {results.bots.length > 0 ? (
        <Section title="Bots">
          <BotRows environmentId={environmentId} listings={results.bots} onOpen={onOpenBot} />
        </Section>
      ) : null}
    </div>
  );
}

function Section({
  title,
  onViewAll,
  children,
}: {
  readonly title: string;
  readonly onViewAll?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        {onViewAll ? (
          <Button size="xs" variant="ghost-muted" onClick={onViewAll}>
            View all
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function SectionPage({
  title,
  onBack,
  children,
}: {
  readonly title: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <Button size="sm" variant="ghost-muted" onClick={onBack}>
        <ArrowLeftIcon />
        Marketplace
      </Button>
      <h3 className="text-base font-medium text-foreground">{title}</h3>
      {children}
    </div>
  );
}

const CARD_CLASS =
  "min-w-0 rounded-xl border bg-card text-left transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none";

function FeaturedBotCard({
  environmentId,
  listing,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly listing: MarketplaceListing;
  readonly onOpen: (listing: MarketplaceListing) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(listing)}
      className={`${CARD_CLASS} flex flex-col items-center gap-2 px-2 py-3 text-center sm:gap-3 sm:px-3 sm:py-5`}
    >
      <ListingAvatar environmentId={environmentId} listing={listing} size="card" />
      <span className="w-full min-w-0 text-sm leading-5">
        {listing.creatorName ? (
          <span className="block truncate text-muted-foreground">{listing.creatorName}&apos;s</span>
        ) : null}
        <span className="line-clamp-2 wrap-anywhere font-medium text-foreground sm:block sm:truncate">
          {listing.name}
        </span>
      </span>
    </button>
  );
}

function BotRows({
  environmentId,
  listings,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly listings: readonly MarketplaceListing[];
  readonly onOpen: (listing: MarketplaceListing) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {listings.map((listing) => (
        <button
          key={listing.shareId}
          type="button"
          onClick={() => onOpen(listing)}
          className={`${CARD_CLASS} flex items-center gap-3 p-3`}
        >
          <ListingAvatar environmentId={environmentId} listing={listing} size="row" />
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">{listing.name}</span>
              {listing.creatorName ? (
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <CreatorAvatar
                    environmentId={environmentId}
                    name={listing.creatorName}
                    photoUrl={listing.creatorPhotoUrl}
                  />
                  <span className="truncate">by {listing.creatorName}</span>
                </span>
              ) : null}
            </span>
            {listing.description ? (
              <span className="line-clamp-1 text-xs leading-5 text-muted-foreground">
                {listing.description}
              </span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}

function PluginRows({
  installed,
  plugins,
  onOpen,
}: {
  readonly installed: ReadonlySet<string>;
  readonly plugins: readonly MarketplacePlugin[];
  readonly onOpen: (plugin: MarketplacePlugin) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {plugins.map((plugin) => (
        <button
          key={plugin.id}
          type="button"
          onClick={() => onOpen(plugin)}
          className={`${CARD_CLASS} flex items-center gap-3 p-3`}
        >
          <PluginLogo plugin={plugin} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">
              {plugin.displayName}
            </span>
            <span className="line-clamp-1 text-xs leading-5 text-muted-foreground">
              {plugin.description || pluginCapabilitySummary(plugin)}
            </span>
          </span>
          {installed.has(plugin.id) ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3.5" />
              Installed
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
