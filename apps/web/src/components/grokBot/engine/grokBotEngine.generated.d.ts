import type { ForwardRefExoticComponent, RefAttributes } from "react";

export const DEFAULT_FILL: number;
export function bodyForShape(shape: string): string;
export function createAppearance(ink: string, spot?: string): unknown;
export function inkForColor(color: string): string;
export const BotRenderer: ForwardRefExoticComponent<
  RefAttributes<{
    poke: (kind: "spin" | "bounce" | "nod", options?: { turns?: number }) => void;
  }> & {
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
>;

export function inkForTheme(color: string, theme: "light" | "dark"): string;

/** A named motion clip from the engine, for example "Idle_B". */
export function recipeByName(name: string): {
  readonly name: string;
  readonly tracks: Record<string, unknown>;
  readonly [key: string]: unknown;
};
