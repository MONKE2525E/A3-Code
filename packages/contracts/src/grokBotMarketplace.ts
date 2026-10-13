import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Public Grok Bot marketplace. Browsing is read-only: T3 lists templates and previews their
 * recipe. Importing creates one bot on the account; plugins from the recipe are never installed.
 */
export const GrokBotMarketplaceShareId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const GrokBotMarketplaceListing = Schema.Struct({
  slug: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  name: Schema.String,
  description: Schema.String,
  imageUrl: Schema.NullOr(Schema.String),
  category: Schema.String,
  categories: Schema.Array(Schema.String),
  shareId: GrokBotMarketplaceShareId,
  creatorName: Schema.String,
  creatorPhotoUrl: Schema.NullOr(Schema.String),
  /** The listing's own avatar look when it has no image, so clients can draw a bot instead of an initial. */
  avatarShape: Schema.optionalKey(Schema.String),
  avatarColor: Schema.optionalKey(Schema.String),
});

export const GrokBotMarketplaceListingsInput = Schema.Struct({});

export const GrokBotMarketplaceListingsResult = Schema.Struct({
  featured: Schema.Array(GrokBotMarketplaceListing),
  /** Every public listing across all pages. Search and category filtering happen in the client. */
  listings: Schema.Array(GrokBotMarketplaceListing),
  /** Category names in the marketplace's own display order. */
  categories: Schema.Array(Schema.String),
});

/** One catalog plugin (connector and skill bundle). Browsing, plus install and uninstall on the account. Plugins in a template recipe are never installed by an import. */
export const GrokBotMarketplacePlugin = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  logoUrl: Schema.NullOr(Schema.String),
  primaryColor: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  /** The marketplace's curated category keys, such as `PRODUCTIVITY` or `FEATURED`. */
  categoryKeys: Schema.Array(Schema.String),
  publisherName: Schema.String,
  websiteUrl: Schema.NullOr(Schema.String),
  repositoryUrl: Schema.NullOr(Schema.String),
  connectorCount: Schema.Int,
  commandCount: Schema.Int,
  skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
  popularityRank: Schema.NullOr(Schema.Int),
  /** Values the plugin asks for at install time, such as an API key. */
  variables: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      label: Schema.String,
      description: Schema.String,
      required: Schema.Boolean,
      secret: Schema.Boolean,
    }),
  ),
  /** The plugin asks for values T3 cannot collect (choices, structured values), so it is installed in the Grok Bot app. */
  needsAppSetup: Schema.Boolean,
});

export const GrokBotMarketplacePluginsInput = Schema.Struct({});

export const GrokBotMarketplacePluginsResult = Schema.Struct({
  plugins: Schema.Array(GrokBotMarketplacePlugin),
});

export const GrokBotMarketplaceInstalledPluginsInput = Schema.Struct({});

/** Plugins installed on the account, kept apart from the large catalog so an install can refresh it cheaply. */
export const GrokBotMarketplaceInstalledPluginsResult = Schema.Struct({
  pluginIds: Schema.Array(Schema.String),
});

export const GrokBotMarketplacePluginInstallInput = Schema.Struct({
  pluginId: Schema.String.check(Schema.isMaxLength(32)),
  /** Values for the plugin's install-time variables, keyed by variable. */
  variables: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(8192))),
  ),
});

export const GrokBotMarketplacePluginUninstallInput = Schema.Struct({
  pluginId: Schema.String.check(Schema.isMaxLength(32)),
});

/** Installation and connector authentication are separate operations. */
export const GrokBotMarketplacePluginChangeResult = Schema.Struct({ pluginId: Schema.String });

export const GrokBotPluginConnectionsInput = Schema.Struct({
  pluginId: Schema.String,
  serverId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export const GrokBotPluginConnectionsResult = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      supportsOAuth: Schema.Boolean,
      accounts: Schema.Array(
        Schema.Struct({
          accountKey: Schema.String,
          authenticated: Schema.Boolean,
          status: Schema.Literals(["connected", "needsAuth", "initializing", "error"]),
        }),
      ),
    }),
  ),
});
export const GrokBotPluginAuthenticateInput = Schema.Struct({
  serverId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  accountKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  redirectUri: Schema.String.check(Schema.isMaxLength(2048)),
});
export const GrokBotPluginAuthenticateResult = Schema.Struct({
  authorizationUrl: Schema.NullOr(Schema.String),
  stateId: Schema.NullOr(Schema.String),
  authenticated: Schema.Boolean,
  /** Set when sign-in returns to a loopback listener on the server's own machine; null otherwise (finish by pasting the callback URL). */
  loopbackPort: Schema.NullOr(Schema.Int),
});
export const GrokBotPluginCompleteAuthInput = Schema.Struct({
  stateId: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
});
export const GrokBotPluginCompleteAuthResult = Schema.Struct({ accountKey: Schema.String });

export const GrokBotMarketplaceTemplateInput = Schema.Struct({
  shareId: GrokBotMarketplaceShareId,
});

/** The template's recipe as the Grok Bot app exports it. Bodies stay as text; nothing is executed. */
export const GrokBotMarketplaceTemplate = Schema.Struct({
  shareId: GrokBotMarketplaceShareId,
  creatorDisplayName: Schema.String,
  /** The template version the preview was read at. Import passes it back so a republished template is never imported unseen. */
  expectedActiveVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  profile: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    avatarShape: Schema.optionalKey(Schema.String),
    avatarColor: Schema.optionalKey(Schema.String),
  }),
  memories: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      createdAt: Schema.optionalKey(Schema.String),
      content: Schema.String,
    }),
  ),
  skills: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.String, content: Schema.String }),
  ),
  routines: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      slug: Schema.String,
      description: Schema.String,
      content: Schema.String,
    }),
  ),
  plugins: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
      pluginId: Schema.String,
    }),
  ),
});

export const GrokBotMarketplaceImportInput = Schema.Struct({
  shareId: GrokBotMarketplaceShareId,
  /** Minted by the client so a retried import targets the same bot instead of creating a second one. */
  agentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  expectedActiveVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

/** What the account reports after creating the bot, so the client can say what setup remains. */
export const GrokBotMarketplaceImportResult = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  setupHandledByServer: Schema.Boolean,
  conversationalSetupEnabled: Schema.Boolean,
});

export class GrokBotMarketplaceError extends Schema.TaggedError<GrokBotMarketplaceError>()(
  "GrokBotMarketplaceError",
  {
    reason: Schema.Literals([
      "provider_not_ready",
      "account_changed",
      "unavailable",
      "import_failed",
      "plugin_change_failed",
      "plugin_auth_failed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider_not_ready":
        return "Sign in to Grok Bot to browse the marketplace.";
      case "account_changed":
        return "The selected Grok Bot account changed. Reload the marketplace and try again.";
      case "unavailable":
        return "The Grok Bot marketplace is unavailable right now. Try again shortly.";
      case "import_failed":
        return "The template could not be imported. Reload it and try again.";
      case "plugin_change_failed":
        return "The plugin could not be changed. Check its details and try again.";
      case "plugin_auth_failed":
        return "Connector authentication could not finish. Return to the plugin and try again.";
    }
  }
}
