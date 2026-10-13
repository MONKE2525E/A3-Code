import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { resolveMuseAvatarPlayback } from "./aiAgents";

const SIZE_PX = { sm: 22, md: 28, lg: 36, xl: 72, "2xl": 112 } as const;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type MuseAgentAvatarProps = {
  readonly name: string;
  /** Still image, also the poster while a video is parked. */
  readonly imageUrl?: string | null | undefined;
  /** Optional looping clip; played only while the agent is active and visible. */
  readonly videoUrl?: string | null | undefined;
  readonly active?: boolean;
  readonly size?: keyof typeof SIZE_PX;
  readonly className?: string;
};

/**
 * A Muse agent's face: the user's image or video, falling back to an initial. Video is parked
 * when idle, offscreen, in a hidden document, or under reduced motion.
 */
export function MuseAgentAvatar(props: MuseAgentAvatarProps) {
  const { name, imageUrl, videoUrl, active = false, size = "lg", className } = props;
  const px = SIZE_PX[size];
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  // Failures are remembered by URL, so a new URL from a profile edit gets a fresh attempt.
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const [failedVideoUrl, setFailedVideoUrl] = useState<string | null>(null);
  const playableVideoUrl = videoUrl && videoUrl !== failedVideoUrl ? videoUrl : null;
  const imageFailed = imageUrl != null && imageUrl === failedImageUrl;

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    const syncVisible = () => setDocumentVisible(document.visibilityState === "visible");
    syncVisible();
    document.addEventListener("visibilitychange", syncVisible);
    return () => {
      media.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", syncVisible);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const playback = resolveMuseAvatarPlayback({
    hasVideo: playableVideoUrl !== null,
    active,
    reducedMotion,
    onScreen,
    documentVisible,
  });

  useEffect(() => {
    // A new URL remounts the element (keyed), so the clip must be re-synced to the playback state.
    const video = videoRef.current;
    if (!video || playableVideoUrl === null) return;
    if (playback === "playing") {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
      video.currentTime = 0;
    }
  }, [playback, playableVideoUrl]);

  const initial = name.trim().charAt(0).toUpperCase() || "M";
  return (
    <span
      ref={rootRef}
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-sidebar-control-surface text-xs font-semibold text-secondary-label",
        className,
      )}
      style={{ width: px, height: px }}
    >
      {playableVideoUrl ? (
        <video
          key={playableVideoUrl}
          ref={videoRef}
          className="size-full object-cover"
          src={playableVideoUrl}
          poster={imageUrl ?? undefined}
          muted
          loop
          playsInline
          preload="metadata"
          onError={() => setFailedVideoUrl(playableVideoUrl)}
        />
      ) : imageUrl && !imageFailed ? (
        <img
          className="size-full object-cover"
          src={imageUrl}
          alt=""
          draggable={false}
          onError={() => setFailedImageUrl(imageUrl)}
        />
      ) : (
        initial
      )}
    </span>
  );
}
