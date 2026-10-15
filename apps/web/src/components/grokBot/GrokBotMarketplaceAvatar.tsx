import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { loadMarketplaceIcon } from "./marketplaceIconCache";

import { cn } from "~/lib/utils";

import { GrokBotAvatar } from "./GrokBotAvatar";
import type { MarketplaceListing, MarketplacePlugin } from "./grokBotMarketplaceCatalog";

const LISTING_PIXELS = { row: 44, card: 72, hero: 96 } as const;
const CREATOR_BADGE_PIXELS = { row: 0, card: 28, hero: 36 } as const;

/**
 * The bot a listing publishes: its own image when it has one, otherwise the bot drawn from the
 * listing's look (an unknown look resolves from the share id, so it is stable per listing).
 * Larger sizes carry the creator's photo as a badge, as the Grok Bot app does.
 */
export function ListingAvatar({
  environmentId,
  listing,
  size = "row",
}: {
  readonly environmentId: EnvironmentId;
  readonly listing: MarketplaceListing;
  readonly size?: keyof typeof LISTING_PIXELS;
}) {
  const pixels = LISTING_PIXELS[size];
  const badge = CREATOR_BADGE_PIXELS[size];
  return (
    <span className="relative inline-flex shrink-0" style={{ width: pixels, height: pixels }}>
      <RemoteImage
        url={listing.imageUrl}
        pixels={pixels}
        className="rounded-2xl"
        fallback={
          <GrokBotAvatar
            environmentId={environmentId}
            bot={{
              id: listing.shareId,
              name: listing.name,
              avatarShape: listing.avatarShape ?? "",
              avatarColor: listing.avatarColor ?? "",
            }}
            fillPx={pixels}
            restingPose="upright"
          />
        }
      />
      {badge > 0 ? (
        <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-card">
          <CreatorAvatar
            environmentId={environmentId}
            name={listing.creatorName}
            photoUrl={listing.creatorPhotoUrl}
            pixels={badge}
          />
        </span>
      ) : null}
    </span>
  );
}

/** The creator's profile photo, or a small bot drawn from their name. */
export function CreatorAvatar({
  environmentId,
  name,
  photoUrl,
  pixels = 16,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly photoUrl: string | null;
  readonly pixels?: number;
}) {
  return (
    <RemoteImage
      url={photoUrl}
      pixels={pixels}
      className="rounded-full"
      fallback={
        <GrokBotAvatar
          environmentId={environmentId}
          bot={{ id: `creator:${name}`, name, avatarShape: "", avatarColor: "" }}
          fillPx={pixels}
        />
      }
    />
  );
}

/** A plugin's logo, or a tile in its brand color (or one chosen from its name) with its initial. */
export function PluginLogo({
  plugin,
  pixels = 44,
}: {
  readonly plugin: MarketplacePlugin;
  readonly pixels?: number;
}) {
  const color = pluginTileColor(plugin);
  return (
    <RemoteImage
      url={plugin.logoUrl}
      pixels={pixels}
      className="rounded-xl bg-muted/60 ring-1 ring-border/60 ring-inset"
      fallbackClipped
      fallback={
        <span
          aria-hidden
          className="flex size-full items-center justify-center font-semibold text-white"
          style={{
            backgroundImage: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 62%, black))`,
            fontSize: Math.round(pixels * 0.42),
          }}
        >
          {plugin.displayName.trim().charAt(0).toUpperCase() || "?"}
        </span>
      }
    />
  );
}

function pluginTileColor(plugin: MarketplacePlugin): string {
  if (plugin.primaryColor !== null && /^#[0-9a-f]{3,8}$/i.test(plugin.primaryColor)) {
    return plugin.primaryColor;
  }
  let hash = 0;
  for (const char of plugin.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 45%)`;
}

function RemoteImage({
  url,
  pixels,
  className,
  fallback,
  fallbackClipped = false,
}: {
  readonly url: string | null;
  readonly pixels: number;
  readonly className: string;
  readonly fallback: ReactNode;
  /** Whether the fallback is a filled tile that takes the same rounded clip as an image. */
  readonly fallbackClipped?: boolean;
}) {
  // A failed load is remembered per URL, so a refreshed listing with a new URL tries again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [cached, setCached] = useState<{ source: string; blobUrl: string } | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const source = cached?.source === url ? cached.blobUrl : url;
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let blobUrl: string | undefined;
    void loadMarketplaceIcon(url).then((blob) => {
      if (cancelled || !blob) return;
      blobUrl = URL.createObjectURL(blob);
      setCached({ source: url, blobUrl });
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
  const showImage = url !== null && url !== failedUrl;
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0",
        (showImage || fallbackClipped) && cn("overflow-hidden", className),
      )}
      style={{ width: pixels, height: pixels }}
    >
      {loadedUrl !== source || !showImage ? fallback : null}
      {showImage ? (
        <img
          src={source ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          // Hosts that block hotlinking key on the referrer.
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
