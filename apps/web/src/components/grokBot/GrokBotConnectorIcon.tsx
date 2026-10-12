import { PlugIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

/**
 * A connector's catalog logo, or the plug glyph when the catalog has none or the image fails
 * to load. A failed URL stays failed until the catalog hands over a different one.
 */
export function GrokBotConnectorIcon({
  logoUrl,
  className = "size-4",
}: {
  readonly logoUrl: string | null;
  readonly className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (logoUrl === null || logoUrl === failedUrl) {
    return (
      <PlugIcon aria-hidden="true" className={cn("shrink-0 text-secondary-label", className)} />
    );
  }
  return (
    <img
      src={logoUrl}
      alt=""
      loading="lazy"
      decoding="async"
      // Hosts that block hotlinking key on the referrer.
      referrerPolicy="no-referrer"
      className={cn("shrink-0 rounded-xs object-cover", className)}
      onError={() => setFailedUrl(logoUrl)}
    />
  );
}
