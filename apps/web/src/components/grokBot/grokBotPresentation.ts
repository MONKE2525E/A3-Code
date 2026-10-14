import { EnvironmentId, type GrokBot } from "@t3tools/contracts";

import {
  GROK_BOT_AVATAR_KINDS,
  GROK_BOT_FALLBACK_COLORS,
  GROK_BOT_UNKNOWN_SHAPE_KINDS,
  type GrokBotAvatarColor,
  type GrokBotAvatarKind,
  GROK_BOT_AVATAR_COLORS,
} from "./grokBotAvatarShapes";

/** The main bot (starred in Grok Bot) leads; everyone else sorts by name. */
export function compareGrokBots(left: GrokBot, right: GrokBot): number {
  if (left.featured !== right.featured) return left.featured ? -1 : 1;
  return left.name.localeCompare(right.name);
}

/** Pinned bots become tiles above the list; hidden bots stay out of the roster. */
export function partitionGrokBotRoster(bots: readonly GrokBot[]): {
  readonly pinned: readonly GrokBot[];
  readonly rows: readonly GrokBot[];
  readonly hidden: readonly GrokBot[];
} {
  const visible = bots.filter((bot) => !bot.hidden);
  return {
    hidden: bots.filter((bot) => bot.hidden).toSorted(compareGrokBots),
    pinned: visible.filter((bot) => bot.pinned).toSorted(compareGrokBots),
    rows: visible.filter((bot) => !bot.pinned).toSorted(compareGrokBots),
  };
}

export function sortGrokBotsForEditor(bots: readonly GrokBot[]): readonly GrokBot[] {
  return bots.toSorted(compareGrokBots);
}

export function grokBotFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Grok Bot could not complete that request.";
}

/** A failed background roster read should not replace a recent successful list. */
export function isGrokBotRosterRecovering(input: {
  readonly failure: unknown;
  readonly hasData: boolean;
  readonly dataUpdatedAt: number;
  readonly nowMs: number;
}): boolean {
  return (
    input.hasData &&
    input.dataUpdatedAt > 0 &&
    input.nowMs >= input.dataUpdatedAt &&
    input.nowMs - input.dataUpdatedAt < 30_000 &&
    typeof input.failure === "object" &&
    input.failure !== null &&
    "_tag" in input.failure &&
    input.failure._tag === "GrokBotError" &&
    "reason" in input.failure &&
    input.failure.reason === "gateway_failed"
  );
}

export function grokBotSurfaceKey(environmentId: string, botId: string): string {
  return `${environmentId}:${botId}`;
}

/**
 * `provider=grok-bot` is the persistent intent to edit Grok Bots on Providers. Grok Bot has no
 * fixed instance id (it is account-bound), and the hash is cleared once a highlight is handled,
 * so neither can own the selection.
 */
export const GROK_BOT_PROVIDER_INTENT = "grok-bot";
const GROK_BOT_DRIVER_NAME = "grok-bot";

export type GrokBotSettingsSearch = {
  readonly botId?: GrokBot["id"];
  readonly provider?: typeof GROK_BOT_PROVIDER_INTENT;
};

export type GrokBotSettingsDestinationSearch = GrokBotSettingsSearch & {
  readonly machine?: EnvironmentId;
};

/** Settings scope uses `machine`; a bot destination must not keep a previous project checkout. */
export function grokBotSettingsDestinationSearch(input: {
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly botId?: string | null | undefined;
}): GrokBotSettingsDestinationSearch {
  const botId = input.botId?.trim();
  return {
    provider: GROK_BOT_PROVIDER_INTENT,
    ...(input.environmentId ? { machine: input.environmentId } : {}),
    ...(botId && botId.length > 0 ? { botId } : {}),
  };
}

export function retainGrokBotSettingsBotIdSearch<T extends GrokBotSettingsSearch>(
  previous: T,
  next: T,
): T {
  if (Object.hasOwn(next, "botId")) return next;
  return typeof previous.botId === "string" && previous.botId.trim().length > 0
    ? { ...next, botId: previous.botId }
    : next;
}

/**
 * Old `/settings/grok-bots` links land on Providers. A stale `instanceId` is dropped and the
 * persistent Grok Bot intent is written, keeping the machine, bot, and hash.
 */
export function grokBotLegacySettingsRedirect(input: {
  readonly previousSearch: Record<string, unknown>;
  readonly search: GrokBotSettingsSearch;
  readonly hash: string;
}): { readonly search: Record<string, unknown>; readonly hash: string } {
  // Either input can carry the raw `instanceId` (the effective search keeps unvalidated keys).
  const merged: Record<string, unknown> = { ...input.previousSearch, ...input.search };
  delete merged.instanceId;
  return {
    search: { ...merged, provider: GROK_BOT_PROVIDER_INTENT },
    hash: input.hash || "grok-bots-editor",
  };
}

export type GrokBotSettingsEnvironmentResolution =
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId }
  | { readonly kind: "disconnected"; readonly environmentId: EnvironmentId }
  | { readonly kind: "choose-environment" }
  | { readonly kind: "no-environment" };

export function resolveGrokBotSettingsEnvironment(input: {
  readonly scopeKind: "all" | "environment" | "project" | "checkout" | "unavailable";
  readonly scopeEnvironmentId?: string | null;
  readonly connectedEnvironmentIds: readonly string[];
}): GrokBotSettingsEnvironmentResolution {
  if (input.scopeKind === "environment") {
    const raw = input.scopeEnvironmentId?.trim() ?? "";
    if (raw.length === 0) return { kind: "choose-environment" };
    const environmentId = EnvironmentId.make(raw);
    return input.connectedEnvironmentIds.includes(environmentId)
      ? { kind: "environment", environmentId }
      : { kind: "disconnected", environmentId };
  }
  const [only, ...others] = input.connectedEnvironmentIds;
  if (only === undefined) return { kind: "no-environment" };
  // With a single environment there is nothing to choose.
  return others.length === 0
    ? { kind: "environment", environmentId: EnvironmentId.make(only) }
    : { kind: "choose-environment" };
}

export type GrokBotSelectedEnvironmentResolution =
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId }
  | { readonly kind: "disconnected"; readonly environmentId: EnvironmentId }
  | { readonly kind: "no-environment" };

/**
 * Chat and the sidebar keep an explicit destination, even when it is
 * disconnected, so settings can show the unavailable-scope notice.
 */
export function resolveGrokBotSelectedEnvironment(input: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly connectedEnvironmentIds: readonly string[];
}): GrokBotSelectedEnvironmentResolution {
  if (input.selectedEnvironmentId === null) return { kind: "no-environment" };
  return input.connectedEnvironmentIds.includes(input.selectedEnvironmentId)
    ? { kind: "environment", environmentId: input.selectedEnvironmentId }
    : { kind: "disconnected", environmentId: input.selectedEnvironmentId };
}

/**
 * A selected environment that is not connected yet but is still on its way (initial connect,
 * reconnect, or a catalog that has not loaded) is loading, not unavailable. Final phases
 * (offline, error, unsupported, a settled catalog without the environment) stay failures.
 */
export function isGrokBotEnvironmentConnecting(input: {
  readonly catalogReady: boolean;
  readonly phase: string | null;
}): boolean {
  if (input.phase === null) return !input.catalogReady;
  return input.phase === "connecting" || input.phase === "reconnecting";
}

/** `view=history` opens the read-only transcript from before bots were ordinary threads. */
export function validateGrokBotConversationSearch(raw: Record<string, unknown>): {
  readonly environmentId?: EnvironmentId;
  readonly view?: "history";
} {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim().length > 0
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(raw.view === "history" ? { view: "history" as const } : {}),
  };
}

export function validateGrokBotSettingsSearch(raw: Record<string, unknown>): GrokBotSettingsSearch {
  const botId = typeof raw.botId === "string" ? raw.botId.trim() : "";
  return {
    ...(raw.provider === GROK_BOT_PROVIDER_INTENT || botId.length > 0
      ? { provider: GROK_BOT_PROVIDER_INTENT }
      : {}),
    ...(botId.length > 0 ? { botId } : {}),
  };
}

/** A shape name Grok Bot draws is kept; any other name gets a shape chosen by bot id. */
export function resolveGrokBotAvatarKind(shape: string, botId: string): GrokBotAvatarKind {
  const known = GROK_BOT_AVATAR_KINDS.find((kind) => kind === shape);
  if (known) return known;
  const index = mixHash(fnv1a(botId)) % GROK_BOT_UNKNOWN_SHAPE_KINDS.length;
  return GROK_BOT_UNKNOWN_SHAPE_KINDS[index]!;
}

/** A color name Grok Bot knows is kept; any other name gets a non-black color chosen by bot id. */
export function resolveGrokBotAvatarColor(color: string, botId: string): GrokBotAvatarColor {
  if (Object.hasOwn(GROK_BOT_AVATAR_COLORS, color)) return color as GrokBotAvatarColor;
  const index = Math.floor(seededUnit(fnv1a(botId)) * GROK_BOT_FALLBACK_COLORS.length);
  return GROK_BOT_FALLBACK_COLORS[index]!;
}

/** FNV-1a over UTF-16 code units, the hash Grok Bot's fallback picks start from. */
function fnv1a(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mixHash(value: number): number {
  let hash = value | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 73244475);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** The first output of Grok Bot's seeded generator, in [0, 1). */
function seededUnit(seed: number): number {
  let state = (seed >>> 0) + 1831565813;
  state |= 0;
  let value = Math.imul(state ^ (state >>> 15), 1 | state);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

/**
 * Whether the Providers page is showing the Grok Bot provider. The header menu and the panel both
 * ask this so they cannot disagree. An explicit instance wins; without one, a bot link or a
 * Grok Bot settings-search target selects it, even over a stale local pick.
 */
export function isGrokBotProviderSelected(input: {
  readonly instanceId: string | undefined;
  /** Driver of the explicit instance, when it is configured. */
  readonly instanceDriver: string | undefined;
  readonly botId: string | undefined;
  /** The persistent `provider` query value. */
  readonly provider: string | undefined;
  readonly searchTargetId: string | null | undefined;
  readonly grokBotDriver: string;
}): boolean {
  if (input.instanceId !== undefined) return input.instanceDriver === input.grokBotDriver;
  return (
    input.provider === GROK_BOT_PROVIDER_INTENT ||
    input.botId !== undefined ||
    input.searchTargetId?.startsWith("grok-bots") === true
  );
}

/**
 * Search written when a provider is picked on Providers. A standard provider clears the Grok Bot
 * intent and its stale bot; the Grok Bot instance keeps both.
 */
export function providerSelectionSearch(
  previous: Record<string, unknown>,
  selection: { readonly instanceId: string; readonly isGrokBot: boolean },
): Record<string, unknown> {
  const { botId, provider: _provider, ...rest } = previous;
  return selection.isGrokBot
    ? {
        ...rest,
        ...(botId === undefined ? {} : { botId }),
        provider: GROK_BOT_PROVIDER_INTENT,
        instanceId: selection.instanceId,
      }
    : { ...rest, instanceId: selection.instanceId };
}

/**
 * A device change drops the old instance and bot but keeps the Grok Bot intent, so the new
 * environment resolves its own account-bound instance and first bot. The intent is whatever the
 * shared resolver selects now: an explicit Codex instance beats a stale `provider=grok-bot`, and
 * a selected Grok Bot instance keeps it even when the query lost `provider`.
 */
export function environmentChangeSearch(
  scope: Record<string, unknown>,
  previous: GrokBotSettingsSearch & {
    readonly instanceId?: string | undefined;
    /** Driver of `instanceId` in the environment being left. */
    readonly instanceDriver?: string | undefined;
  },
): Record<string, unknown> {
  return isGrokBotProviderSelected({
    instanceId: previous.instanceId,
    instanceDriver: previous.instanceDriver,
    botId: undefined,
    provider: previous.provider,
    searchTargetId: undefined,
    grokBotDriver: GROK_BOT_DRIVER_NAME,
  })
    ? { ...scope, provider: GROK_BOT_PROVIDER_INTENT }
    : scope;
}

/** Settings-search ids that live in the Grok Bot area of Providers. */
function isGrokBotSettingsSearchItem(id: string): boolean {
  return (
    id === "grok-bots" ||
    id === "grok-bots-bridge" ||
    id === "grok-bots-editor" ||
    id === "grok-bots-computer"
  );
}

/**
 * Search for a settings-search or palette result. Grok Bot results write the persistent intent and
 * drop an `instanceId` that would otherwise keep another provider selected; every other result
 * leaves the search to the retain middleware.
 */
export function settingsSearchResultSearch(
  itemId: string,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  if (!isGrokBotSettingsSearchItem(itemId)) return previous;
  const { instanceId: _stale, ...rest } = previous;
  return { ...rest, provider: GROK_BOT_PROVIDER_INTENT };
}
