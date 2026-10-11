import { describe, expect, it } from "vite-plus/test";

import {
  groupListingsByCategory,
  groupPluginsByCategory,
  searchMarketplace,
  type MarketplaceListing,
  type MarketplacePlugin,
} from "./grokBotMarketplaceCatalog";

const plugin = (id: string, overrides: Partial<MarketplacePlugin> = {}): MarketplacePlugin => ({
  id,
  name: id,
  displayName: id,
  description: "",
  logoUrl: null,
  primaryColor: null,
  tags: [],
  categoryKeys: [],
  publisherName: "",
  websiteUrl: null,
  repositoryUrl: null,
  connectorCount: 1,
  commandCount: 0,
  skills: [],
  popularityRank: null,
  variables: [],
  needsAppSetup: false,
  ...overrides,
});

const listing = (shareId: string, category: string): MarketplaceListing => ({
  slug: shareId,
  name: shareId,
  description: "",
  imageUrl: null,
  category,
  categories: [category],
  shareId,
  creatorName: "",
  creatorPhotoUrl: null,
});

describe("groupPluginsByCategory", () => {
  it("leads with Featured, sorts the rest by title, and puts unranked plugins last in a section", () => {
    const sections = groupPluginsByCategory([
      plugin("a", { categoryKeys: ["SALES"] }),
      plugin("b", { categoryKeys: ["PRODUCTIVITY", "FEATURED"], popularityRank: 2 }),
      plugin("c", { categoryKeys: ["PRODUCTIVITY"], popularityRank: 1 }),
      plugin("d", { categoryKeys: ["PRODUCTIVITY"] }),
      plugin("e"),
    ]);
    expect(sections.map((section) => section.title)).toEqual([
      "Featured Plugins",
      "Productivity",
      "Sales",
      "More Plugins",
    ]);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["b"]);
    expect(sections[1]?.items.map((item) => item.id)).toEqual(["c", "d"]);
  });
});

describe("groupListingsByCategory", () => {
  it("follows the marketplace's category order", () => {
    const sections = groupListingsByCategory(
      [listing("x", "Sales"), listing("y", "From Grok Bot Team")],
      ["From Grok Bot Team", "Sales"],
    );
    expect(sections.map((section) => section.title)).toEqual(["From Grok Bot Team", "Sales"]);
  });
});

describe("searchMarketplace", () => {
  it("matches bots and plugins case-insensitively", () => {
    const result = searchMarketplace(
      "CLERK",
      [listing("clerk bot", "Sales"), listing("other", "Sales")],
      [plugin("clerk", { displayName: "Clerk" }), plugin("gmail")],
    );
    expect(result.bots.map((bot) => bot.shareId)).toEqual(["clerk bot"]);
    expect(result.plugins.map((item) => item.id)).toEqual(["clerk"]);
  });
});
