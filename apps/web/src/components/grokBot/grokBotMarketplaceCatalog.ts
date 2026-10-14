import type { GrokBotMarketplaceListing, GrokBotMarketplacePlugin } from "@t3tools/contracts";

export type MarketplaceListing = typeof GrokBotMarketplaceListing.Type;
export type MarketplacePlugin = typeof GrokBotMarketplacePlugin.Type;

export interface MarketplaceSection<T> {
  readonly key: string;
  readonly title: string;
  readonly items: readonly T[];
}

/** Titles for the catalog's curated plugin category keys. */
const PLUGIN_CATEGORY_TITLES: Readonly<Record<string, string>> = {
  FEATURED: "Featured Plugins",
  INFRASTRUCTURE: "Infrastructure",
  DATA_ANALYTICS: "Data & Analytics",
  PRODUCTIVITY: "Productivity",
  PAYMENTS: "Payments",
  AGENT_ORCHESTRATION: "Agent Orchestration",
  CANVAS: "Canvas",
  INBOX_AND_COLLABORATION: "Inbox & Collaboration",
  SCHEDULING: "Scheduling",
  DOCUMENTS_AND_FILES: "Documents & Files",
  SALES: "Sales",
  CUSTOMER_SUPPORT: "Customer Support",
  FINANCE_AND_LEGAL: "Finance & Legal",
  RESEARCH: "Research",
  DESIGN: "Design",
  LOGIN_AND_CREDENTIAL_MANAGEMENT: "Login and Credential Management",
};
const OTHER_PLUGINS_KEY = "OTHER";

function titleCase(key: string): string {
  return key
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function pluginCategoryTitle(key: string): string {
  return key === OTHER_PLUGINS_KEY
    ? "More Plugins"
    : (PLUGIN_CATEGORY_TITLES[key] ?? titleCase(key));
}

/** Most popular first; plugins the catalog has not ranked follow, alphabetically. */
function sortPlugins(plugins: readonly MarketplacePlugin[]): MarketplacePlugin[] {
  return plugins.toSorted(
    (a, b) =>
      (a.popularityRank ?? Number.MAX_SAFE_INTEGER) -
        (b.popularityRank ?? Number.MAX_SAFE_INTEGER) || a.displayName.localeCompare(b.displayName),
  );
}

/** Each plugin lands in one section: Featured when it is, otherwise its first category. Featured leads. */
export function groupPluginsByCategory(
  plugins: readonly MarketplacePlugin[],
): MarketplaceSection<MarketplacePlugin>[] {
  const sections = new Map<string, MarketplacePlugin[]>();
  for (const plugin of sortPlugins(plugins)) {
    const key = plugin.categoryKeys.includes("FEATURED")
      ? "FEATURED"
      : (plugin.categoryKeys[0] ?? OTHER_PLUGINS_KEY);
    const bucket = sections.get(key);
    if (bucket === undefined) sections.set(key, [plugin]);
    else bucket.push(plugin);
  }
  const rank = (key: string) => (key === "FEATURED" ? 0 : key === OTHER_PLUGINS_KEY ? 2 : 1);
  return [...sections]
    .map(([key, items]) => ({ key, title: pluginCategoryTitle(key), items }))
    .toSorted((a, b) => rank(a.key) - rank(b.key) || a.title.localeCompare(b.title));
}

/** Bot templates grouped by their primary category, in the marketplace's own category order. */
export function groupListingsByCategory(
  listings: readonly MarketplaceListing[],
  categoryOrder: readonly string[],
): MarketplaceSection<MarketplaceListing>[] {
  const buckets = new Map<string, MarketplaceListing[]>();
  for (const listing of listings) {
    const key = listing.category || listing.categories[0] || "More Bots";
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [listing]);
    else bucket.push(listing);
  }
  const position = (key: string) => {
    const index = categoryOrder.indexOf(key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...buckets]
    .map(([key, items]) => ({ key, title: key, items }))
    .toSorted((a, b) => position(a.key) - position(b.key));
}

export function searchMarketplace(
  query: string,
  listings: readonly MarketplaceListing[],
  plugins: readonly MarketplacePlugin[],
): { readonly bots: MarketplaceListing[]; readonly plugins: MarketplacePlugin[] } {
  const needle = query.trim().toLowerCase();
  const matches = (...fields: readonly string[]) =>
    fields.some((field) => field.toLowerCase().includes(needle));
  return {
    bots: listings.filter((listing) =>
      matches(listing.name, listing.description, listing.creatorName),
    ),
    plugins: sortPlugins(plugins).filter((plugin) =>
      matches(
        plugin.displayName,
        plugin.name,
        plugin.description,
        plugin.publisherName,
        ...plugin.tags,
      ),
    ),
  };
}

export function pluginCapabilitySummary(plugin: MarketplacePlugin): string {
  const parts = [
    plugin.connectorCount > 0
      ? `${plugin.connectorCount} ${plugin.connectorCount === 1 ? "connector" : "connectors"}`
      : null,
    plugin.skills.length > 0
      ? `${plugin.skills.length} ${plugin.skills.length === 1 ? "skill" : "skills"}`
      : null,
    plugin.commandCount > 0
      ? `${plugin.commandCount} ${plugin.commandCount === 1 ? "command" : "commands"}`
      : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(", ") : "Plugin";
}
