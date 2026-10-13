import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { museAgentAvatarQuery } from "~/state/museAgentAvatar";
import { useEnvironmentQuery } from "~/state/query";

import { pickMuseAvatarVideo } from "./aiAgents";

/** The slice of the client profile the avatar needs; the URL fields only name the variants. */
export type MuseAgentAvatarProfile = {
  readonly avatarRevision?: string | undefined;
  readonly avatarImageUrl?: string | undefined;
  readonly avatarVideoUrls?: Readonly<Record<string, string>> | undefined;
};

const VARIANT_PATTERN = /^[a-z_]{1,64}$/;
const INSTANCE_PATTERN = /\/ai-agents\/muse\/([^/]+)\/avatar\//;

/** The instance is encoded in the descriptor path the server issued; the profile has no field for it. */
export function instanceFromDescriptor(url: string | undefined): string | null {
  const match = url ? INSTANCE_PATTERN.exec(url) : null;
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function pickVideoVariant(
  urls: MuseAgentAvatarProfile["avatarVideoUrls"],
  working = false,
): string | null {
  const picked = pickMuseAvatarVideo(urls, working);
  if (!urls || picked === null) return null;
  return Object.keys(urls).find((key) => urls[key] === picked) ?? null;
}

/**
 * Turns loaded bytes into an object URL that is revoked when the bytes change or the avatar
 * unmounts. A URL is only returned for the media it was made from, so a revoked one never renders.
 */
function useObjectUrl(media: { bytes: Uint8Array; contentType: string } | null): string | null {
  const [made, setMade] = useState<{ media: object; url: string } | null>(null);
  useEffect(() => {
    if (!media) return;
    const url = URL.createObjectURL(
      new Blob([media.bytes as Uint8Array<ArrayBuffer>], { type: media.contentType }),
    );
    setMade({ media, url });
    return () => URL.revokeObjectURL(url);
  }, [media]);
  return media && made?.media === media ? made.url : null;
}

/**
 * Authenticated avatar URLs for one environment. Bytes go through the selected connection's
 * loader, so remote, tunnel, and relay environments work. The clip loads only when `loadVideo`
 * is set, and both are keyed by profile revision so the profile poll does not refetch them.
 */
export function useMuseAgentAvatar(
  environmentId: EnvironmentId | null,
  profile: MuseAgentAvatarProfile | null | undefined,
  options?: { readonly loadVideo?: boolean },
): { readonly imageUrl: string | null; readonly videoUrl: string | null } {
  const revision = profile?.avatarRevision;
  const videoVariant = pickVideoVariant(profile?.avatarVideoUrls, options?.loadVideo === true);
  const providerInstanceId =
    instanceFromDescriptor(profile?.avatarImageUrl) ??
    instanceFromDescriptor(videoVariant ? profile?.avatarVideoUrls?.[videoVariant] : undefined);
  const target = (variant: string | null) =>
    environmentId && revision && providerInstanceId && variant && VARIANT_PATTERN.test(variant)
      ? museAgentAvatarQuery({
          environmentId,
          input: { providerInstanceId, variant, revision },
        })
      : null;

  const image = useEnvironmentQuery(profile?.avatarImageUrl ? target("image") : null).data;
  const video = useEnvironmentQuery(options?.loadVideo ? target(videoVariant) : null).data;
  const imageMedia = useMemo(() => (image?._tag === "Available" ? image : null), [image]);
  const videoMedia = useMemo(() => (video?._tag === "Available" ? video : null), [video]);
  return { imageUrl: useObjectUrl(imageMedia), videoUrl: useObjectUrl(videoMedia) };
}
