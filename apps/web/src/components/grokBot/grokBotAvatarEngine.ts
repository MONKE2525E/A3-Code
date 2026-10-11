import { sha256 } from "@noble/hashes/sha2";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";

/**
 * The local avatar engine, installed per environment and served through the
 * authenticated environment HTTP API. Its module exports exactly these members.
 */
export interface GrokBotAvatarEngine {
  readonly BotRenderer: React.ForwardRefExoticComponent<
    React.RefAttributes<GrokBotRendererHandle> & GrokBotRendererProps
  >;
  readonly DEFAULT_FILL: number;
  readonly bodyForShape: (shape: string) => string;
  readonly createAppearance: (ink: string, spot?: string) => unknown;
  readonly inkForColor: (color: string) => string;
  readonly inkForTheme: (color: string, theme: "light" | "dark") => string;
  readonly recipeByName: (name: string) => unknown;
}

export interface GrokBotRendererHandle {
  readonly poke: (kind: "spin" | "bounce" | "nod", options?: { readonly turns?: number }) => void;
  /** Turns the eyes toward a normalized direction, or back to rest with null. */
  readonly gaze?: (gaze: readonly [number, number] | null) => void;
}

/**
 * The eyes reach full deflection at this fraction of the mark's width from its center. The
 * Grok Bot app divides by 2, which is 0.5 here; this smaller value saturates sooner so the
 * look reads at a glance.
 */
const HOVER_GAZE_SCALE = 0.35;

type Box = Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom" | "width" | "height">;

/**
 * The eye direction for a pointer over a hit area, or null when the pointer is outside it.
 * Eyes aim from the anchor (the mark) rather than the hit area, which may be a wider row.
 * Each axis is clamped to [-1, 1]; y points up, as in the app.
 */
export function hoverGazeAt(
  rect: Box,
  point: { readonly x: number; readonly y: number },
  anchor: Box = rect,
): readonly [number, number] | null {
  if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) {
    return null;
  }
  const unit = Math.max(anchor.width, 1) * HOVER_GAZE_SCALE;
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  return [
    clamp((point.x - (anchor.left + anchor.width / 2)) / unit),
    clamp((anchor.top + anchor.height / 2 - point.y) / unit),
  ];
}

interface GrokBotRendererProps {
  readonly appearance: unknown;
  readonly body: string;
  readonly fill?: number;
  readonly size: number | string;
  readonly id?: string;
  readonly seed?: string;
  readonly state?: string;
  readonly isPlaying?: boolean;
  readonly isEmphasized?: boolean;
  readonly isFollowingPointer?: boolean;
  readonly maxFrameRate?: number;
  readonly resolution?: number;
  readonly clip?: unknown;
}

interface GrokBotAvatarEngineModule {
  readonly createEngine: (
    react: typeof React,
    jsxRuntime: typeof JsxRuntime,
  ) => GrokBotAvatarEngine;
}

// Keyed by environment and digest so each connection loads its own verified copy once.
const loadedEngines = new Map<string, Promise<GrokBotAvatarEngine>>();

/**
 * Evaluates engine source as a module after its bytes match the digest the
 * environment declared. The blob URL only exists for the import, so the source
 * never becomes a page-level script or a durable URL.
 *
 * The digest is checked here rather than trusted from the metadata response,
 * because the source arrives in a separate request.
 */
export function loadGrokBotAvatarEngine(
  cacheKey: string,
  expectedSha256: string,
  source: string,
): Promise<GrokBotAvatarEngine> {
  const cached = loadedEngines.get(cacheKey);
  if (cached) return cached;
  const engine = importVerifiedEngineSource(expectedSha256, source);
  loadedEngines.set(cacheKey, engine);
  engine.catch(() => loadedEngines.delete(cacheKey));
  return engine;
}

async function importVerifiedEngineSource(
  expectedSha256: string,
  source: string,
): Promise<GrokBotAvatarEngine> {
  // Plain HTTP origins have no SubtleCrypto, so hash in JS rather than skipping the check.
  const digest = Array.from(sha256(new TextEncoder().encode(source)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== expectedSha256) throw new Error("Grok Bot avatar engine failed verification.");
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const module = (await import(/* @vite-ignore */ url)) as GrokBotAvatarEngineModule;
    return module.createEngine(React, JsxRuntime);
  } finally {
    URL.revokeObjectURL(url);
  }
}
