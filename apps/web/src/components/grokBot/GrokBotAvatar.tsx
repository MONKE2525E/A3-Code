import type { EnvironmentId, GrokBot } from "@t3tools/contracts";
import { StarIcon } from "lucide-react";
import {
  type ComponentRef,
  type CSSProperties,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { grokBotAvatarEngineQuery } from "~/state/grokBots";

import {
  type GrokBotAvatarEngine,
  hoverGazeAt,
  loadGrokBotAvatarEngine,
} from "./grokBotAvatarEngine";
import {
  type GrokBotAvatarActivity,
  resolveGrokBotVoiceCallActivity,
} from "./grokBotVoiceCallActivity";
import { GrokBotVoiceCallContext } from "./useGrokBotVoiceCall";
import { GROK_BOT_AVATAR_COLORS } from "./grokBotAvatarShapes";
import type { GrokBotStatusDot } from "./grokBotStatusDots";
import { resolveGrokBotAvatarColor, resolveGrokBotAvatarKind } from "./grokBotPresentation";
import { useSelectedGrokBotEnvironmentId } from "./useGrokBotEnvironment";

const SIZE_PX = { xs: 16, sm: 22, md: 28, lg: 36, xl: 72 } as const;
/** The Grok Bot app renders its marks at this resolution. */
const MARK_RESOLUTION = 192;
/** A parked catalog pose: pitch and yaw aim the face up-right, with no sideways body roll. */
const UPRIGHT_POSE = {
  name: "upright",
  duration: 1,
  tracks: { rotation: [{ t: 0, v: [-12, 20, 0] }] },
};
/** Successive clicks on a bot cycle through these pokes. */
const CLICK_POKES = ["spin", "bounce", "nod"] as const;
/**
 * Turn-in-progress states play the same idle clips a bot shows on hover, so they animate
 * exactly like a resting bot.
 */
const IDLE_LOOKING_STATES: ReadonlySet<GrokBotAvatarActivity> = new Set<GrokBotAvatarActivity>([
  "loading",
  "sending",
  "thinking",
  "streaming",
  "working",
  "reading",
  "searching",
  "writing",
  "coding",
  "running",
]);
/** Sweeping across a row of bots should not flicker their eyes, so gaze engages after a short dwell. */
const GAZE_ENTER_MS = 150;
/** A bot keeps looking for a moment after the pointer leaves, so crossing a gap does not reset it. */
const GAZE_LEAVE_MS = 250;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type GrokBotAvatarProps = {
  readonly bot: Pick<GrokBot, "id" | "name" | "avatarShape" | "avatarColor">;
  readonly size?: keyof typeof SIZE_PX;
  /** Overrides the size token with an exact CSS box, in pixels. */
  readonly fillPx?: number;
  readonly featured?: boolean;
  readonly state?: GrokBotAvatarActivity | undefined;
  /** Sidebar status in the bottom-right corner; absent when the surface does not show one. */
  readonly statusDot?: GrokBotStatusDot | null;
  /** Each change spins the bot once. */
  readonly spinSignal?: number;
  /** Each change spins the bot twice and bounces, as when its look is edited. */
  readonly appearanceSignal?: number;
  readonly emphasized?: boolean;
  /** Off by default, as in the Grok Bot app; only surfaces that opt in follow the pointer. */
  readonly followsPointer?: boolean;
  /**
   * A wider element that owns the hover, such as a sidebar tab. Needs `followsPointer`; the
   * whole element gazes at the mark. Without one, the mark itself is the hover target.
   */
  readonly gazeHost?: HTMLElement | null;
  /** Keep catalog marks upright while their face looks up and to the right, until they have a state. */
  readonly restingPose?: "upright";
  readonly className?: string;
  /** The environment whose avatar engine draws the bot; defaults to the selected Grok Bot environment. */
  readonly environmentId?: EnvironmentId;
};

/**
 * A Grok Bot face. The local engine that draws it is installed per environment
 * and loaded at runtime; until it is available, a neutral app-drawn disc stands
 * in, with no motion. Like the app, a bot rests until it has an activity, then animates
 * continuously for that state. Motion stops while the bot is offscreen, the document is
 * hidden, or reduced motion is on. While the pointer is over a following bot, its body
 * holds still so the eyes can track the cursor.
 * Like the app, a bot that enters "happy" or whose look changes spins and bounces once.
 */
export function GrokBotAvatar(props: GrokBotAvatarProps) {
  const selectedEnvironmentId = useSelectedGrokBotEnvironmentId();
  const environmentId = props.environmentId ?? selectedEnvironmentId;
  // Catalogs and other standalone surfaces can render outside the call provider.
  const voiceCall = useContext(GrokBotVoiceCallContext);
  const state = resolveGrokBotVoiceCallActivity({
    call: voiceCall?.call ?? null,
    environmentId,
    botId: props.bot.id,
    activity: props.state,
  });
  const engine = useGrokBotAvatarEngine(environmentId);
  return engine === null ? (
    <GrokBotAvatarFallback {...props} />
  ) : (
    <GrokBotEngineAvatar engine={engine} {...props} state={state} />
  );
}

/** The engine lives per environment, so the avatar follows the selected Grok Bot environment. */
function useGrokBotAvatarEngine(environmentId: EnvironmentId | null): GrokBotAvatarEngine | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : grokBotAvatarEngineQuery({ environmentId, input: {} }),
  );
  const available = query.data?._tag === "Available" ? query.data : null;
  const source = available?.source ?? null;
  const sha256 = available?.sha256 ?? null;
  const cacheKey =
    environmentId !== null && available !== null ? `${environmentId}:${available.sha256}` : null;
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly engine: GrokBotAvatarEngine;
  } | null>(null);

  useEffect(() => {
    if (cacheKey === null || source === null || sha256 === null) return;
    let cancelled = false;
    loadGrokBotAvatarEngine(cacheKey, sha256, source).then(
      (engine) => {
        if (!cancelled) setLoaded({ key: cacheKey, engine });
      },
      () => {
        // A rejected module leaves the neutral fallback in place; the next read retries.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cacheKey, sha256, source]);

  return loaded !== null && loaded.key === cacheKey ? loaded.engine : null;
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/** Reports whether the element is on screen; without IntersectionObserver it is assumed visible. */
function useIsInView(element: HTMLElement | null): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setInView(entry?.isIntersecting ?? true),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return inView;
}

function GrokBotEngineAvatar({
  engine,
  bot,
  size = "md",
  fillPx,
  featured = false,
  state,
  statusDot = null,
  spinSignal = 0,
  appearanceSignal = 0,
  emphasized = false,
  followsPointer = false,
  gazeHost = null,
  restingPose,
  className,
}: GrokBotAvatarProps & { readonly engine: GrokBotAvatarEngine }) {
  const pixels = fillPx ?? SIZE_PX[size];
  const kind = resolveGrokBotAvatarKind(bot.avatarShape, bot.id);
  const color = resolveGrokBotAvatarColor(bot.avatarColor, bot.id);
  const { BotRenderer } = engine;
  // Eyes are cut out of the body, so they show whatever is behind the avatar.
  const appearance = useMemo(() => engine.createAppearance("var(--grok-bot-ink)"), [engine]);
  // The Grok Bot app seeds each mark from its agent's source id, so the same bot moves the same way everywhere.
  const markSeed = `sand-agent-mark-source-${bot.id}`;
  // Each mounted engine owns its SVG ids: the same bot can be drawn at several sizes at once.
  const markId = `sand-agent-mark-${useId().replaceAll(":", "")}`;
  const [frame, setFrame] = useState<HTMLSpanElement | null>(null);
  const renderer = useRef<ComponentRef<typeof BotRenderer>>(null);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const documentVisible = useDocumentVisible();
  const inView = useIsInView(frame);
  const paused = reducedMotion || !documentVisible || !inView;

  const lastSpin = useRef(spinSignal);
  useEffect(() => {
    if (spinSignal === lastSpin.current) return;
    lastSpin.current = spinSignal;
    if (!reducedMotion) renderer.current?.poke("spin");
  }, [spinSignal, reducedMotion]);

  // Like the app, a bot spins and bounces once when its look changes and once each time it
  // enters "happy", including on mount. A look change that also makes it happy plays once.
  const lastAppearance = useRef(appearanceSignal);
  const happyPlayed = useRef(false);
  useEffect(() => {
    const appearanceChanged = appearanceSignal !== lastAppearance.current;
    lastAppearance.current = appearanceSignal;
    const enteredHappy = state === "happy" && !happyPlayed.current;
    happyPlayed.current = state === "happy";
    if (!appearanceChanged && !enteredHappy) return;
    if (reducedMotion) return;
    renderer.current?.poke("spin", { turns: 2 });
    renderer.current?.poke("bounce");
  }, [appearanceSignal, state, reducedMotion]);

  // Eyes track the pointer only while it is over this bot's own host or mark, and rest once it
  // leaves. The listeners live on that element, so no bot follows the pointer across the page.
  // The engine aims eyes only while it follows the pointer, so that flag is on only during hover.
  // Engagement waits out a short dwell on enter and leave so a fast sweep does not flicker.
  const gazeTarget = gazeHost ?? frame;
  const gazeEnabled = followsPointer && !paused;
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    if (frame === null || gazeTarget === null || !gazeEnabled) return;
    let engaged = false;
    let point: { readonly x: number; readonly y: number } | null = null;
    let enterTimer: ReturnType<typeof setTimeout> | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    // Returns whether the pointer is over the target, so the caller knows the gaze was applied.
    const aim = (): boolean => {
      if (point === null) return false;
      const gaze = hoverGazeAt(
        gazeTarget.getBoundingClientRect(),
        point,
        frame.getBoundingClientRect(),
      );
      if (gaze === null) return false;
      renderer.current?.gaze?.(gaze);
      return true;
    };
    const engage = () => {
      engaged = true;
      setHovering(true);
      aim();
    };
    const rest = () => {
      engaged = false;
      setHovering(false);
      renderer.current?.gaze?.(null);
    };
    const onPointerEnter = (event: PointerEvent) => {
      point = { x: event.clientX, y: event.clientY };
      clearTimeout(leaveTimer);
      if (engaged) {
        aim();
        return;
      }
      clearTimeout(enterTimer);
      enterTimer = setTimeout(engage, GAZE_ENTER_MS);
    };
    const onPointerMove = (event: PointerEvent) => {
      point = { x: event.clientX, y: event.clientY };
      if (!engaged) return;
      // The engine's window listener aims the eyes from raw moves too, and would override this
      // gaze. Stopping the move here keeps the wrapper's scale in charge while the gaze is engaged.
      if (aim()) event.stopPropagation();
    };
    const onPointerLeave = () => {
      clearTimeout(enterTimer);
      if (!engaged) return;
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(rest, GAZE_LEAVE_MS);
    };
    gazeTarget.addEventListener("pointerenter", onPointerEnter);
    gazeTarget.addEventListener("pointermove", onPointerMove, { passive: true });
    gazeTarget.addEventListener("pointerleave", onPointerLeave);
    return () => {
      gazeTarget.removeEventListener("pointerenter", onPointerEnter);
      gazeTarget.removeEventListener("pointermove", onPointerMove);
      gazeTarget.removeEventListener("pointerleave", onPointerLeave);
      clearTimeout(enterTimer);
      clearTimeout(leaveTimer);
      setHovering(false);
      renderer.current?.gaze?.(null);
    };
  }, [frame, gazeTarget, gazeEnabled]);
  const gazing = gazeEnabled && hovering;
  // Turn-in-progress states reuse the idle clip set, so the engine sees "idle" for them.
  const engineState = state !== undefined && IDLE_LOOKING_STATES.has(state) ? "idle" : state;
  const upright = restingPose === "upright" && state === undefined;

  const clicks = useRef(0);

  return (
    <span
      ref={setFrame}
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 [&_svg:not([class*='size-'])]:size-full!",
        className,
      )}
      onClick={() => {
        const handle = renderer.current;
        if (upright || reducedMotion || handle === null) return;
        // As in the app, the cycle advances only when a poke reaches the renderer.
        handle.poke(CLICK_POKES[clicks.current % CLICK_POKES.length]!);
        clicks.current += 1;
      }}
      style={
        {
          width: pixels,
          height: pixels,
          "--grok-bot-ink": engine.inkForColor(color),
        } as CSSProperties
      }
    >
      <BotRenderer
        key={upright ? "upright" : "animated"}
        ref={renderer}
        appearance={appearance}
        body={engine.bodyForShape(kind)}
        fill={engine.DEFAULT_FILL}
        id={markId}
        seed={markSeed}
        size={pixels}
        resolution={MARK_RESOLUTION}
        {...(upright ? { clip: UPRIGHT_POSE } : { state: engineState ?? "idle" })}
        isPlaying={!upright && !paused && !gazing && state !== undefined}
        isEmphasized={emphasized}
        isFollowingPointer={gazing}
        maxFrameRate={30}
      />
      {featured ? <FeaturedBadge pixels={pixels} /> : null}
      {statusDot ? <StatusDot status={statusDot} pixels={pixels} featured={featured} /> : null}
    </span>
  );
}

/** Stands in until the local engine loads or when the environment does not install one. */
function GrokBotAvatarFallback({
  bot,
  size = "md",
  fillPx,
  featured = false,
  statusDot = null,
  className,
}: GrokBotAvatarProps) {
  const pixels = fillPx ?? SIZE_PX[size];
  const color = resolveGrokBotAvatarColor(bot.avatarColor, bot.id);
  return (
    <span
      aria-hidden
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: pixels, height: pixels }}
    >
      <span
        className="block size-full rounded-full"
        style={{ backgroundColor: GROK_BOT_AVATAR_COLORS[color] }}
      />
      {featured ? <FeaturedBadge pixels={pixels} /> : null}
      {statusDot ? <StatusDot status={statusDot} pixels={pixels} featured={featured} /> : null}
    </span>
  );
}

function FeaturedBadge({ pixels }: { readonly pixels: number }) {
  return (
    <span
      className={cn(
        "absolute -right-0.5 -bottom-0.5 flex items-center justify-center rounded-full bg-warning text-white shadow-sm",
        pixels < 36 ? "size-3.5" : "size-4",
      )}
    >
      <StarIcon className="size-2 fill-current" />
    </span>
  );
}

/**
 * Sits in the bottom-right corner like the featured star. A featured bot keeps the corner
 * for the star, so the dot moves in beside it instead of covering it.
 */
function StatusDot({
  status,
  pixels,
  featured,
}: {
  readonly status: GrokBotStatusDot;
  readonly pixels: number;
  readonly featured: boolean;
}) {
  const large = pixels >= 36;
  return (
    <span
      data-grok-bot-status-dot={status}
      className={cn(
        "absolute -bottom-0.5 rounded-full ring-2 ring-sidebar",
        status === "active" ? "bg-success" : "bg-info",
        large ? "size-2.5" : "size-2",
        featured ? (large ? "right-4" : "right-3.5") : "-right-0.5",
      )}
    />
  );
}
