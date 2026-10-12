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

// Client-owned pin for Grok Bot 0.68.1, reproduced with
// scripts/install-grok-bot-avatar-engine.ts from index.eager-platform-AatQIEPx.js.
// Bundle SHA-256: fe8439822c8085411a1cbae5fb38964fde8234c22f6a7f79c28b3ffe5ec059d9
// grok-bot_0.68.1_amd64.deb SHA-256:
// b2be8106d2b3eae07d983d5f1ca77b657accde666dc440db2a409421ecff3359
// Only this derived module is trusted; new versions require a reviewed client update.
const TRUSTED_ENGINE_SHA256 = "76f131c44107bcd25a196ddf5f765cf021ec12d757557591afcf58247c8d07ea";

// Keyed by environment and digest so each connection loads its own verified copy once.
const loadedEngines = new Map<string, Promise<GrokBotAvatarEngine>>();

/**
 * Imports only the client-pinned renderer. Environment metadata and source are
 * both untrusted: matching a server-supplied digest alone cannot authorize code
 * running in the client's realm. Unknown builds reject into the existing avatar
 * fallback. The accepted renderer keeps its native animation and host React.
 */
export async function loadGrokBotAvatarEngine(
  cacheKey: string,
  expectedSha256: string,
  source: string,
): Promise<GrokBotAvatarEngine> {
  if (expectedSha256 !== TRUSTED_ENGINE_SHA256)
    throw new Error("Grok Bot avatar engine is not a trusted build.");
  // Plain HTTP origins have no SubtleCrypto, so hash in JS rather than skipping the check.
  const digest = Array.from(sha256(new TextEncoder().encode(source)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== TRUSTED_ENGINE_SHA256)
    throw new Error("Grok Bot avatar engine failed verification.");
  const cached = loadedEngines.get(cacheKey);
  if (cached) return cached;
  const engine = importVerifiedEngineSource(source);
  loadedEngines.set(cacheKey, engine);
  engine.catch(() => loadedEngines.delete(cacheKey));
  return engine;
}

async function importVerifiedEngineSource(source: string): Promise<GrokBotAvatarEngine> {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const module = (await import(/* @vite-ignore */ url)) as GrokBotAvatarEngineModule;
    return module.createEngine(React, JsxRuntime);
  } finally {
    URL.revokeObjectURL(url);
  }
}
