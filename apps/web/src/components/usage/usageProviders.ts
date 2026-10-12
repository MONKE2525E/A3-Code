import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { UsageProviderKind } from "@t3tools/contracts";

import { ProviderDriverKind } from "@t3tools/contracts";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart and table, so adding a provider
 * only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    driverKind: ProviderDriverKind.make("codex"),
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    driverKind: ProviderDriverKind.make("claudeAgent"),
  },
  grok: {
    label: "Grok Build",
    // Contrast-aware neutral between the Codex series and muted chart chrome.
    color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))",
    driverKind: ProviderDriverKind.make("grok"),
  },
  cursor: { label: "Cursor", color: "#8b8b8b", driverKind: ProviderDriverKind.make("cursor") },
  opencode: {
    label: "OpenCode",
    color: "#5b9bbd",
    driverKind: ProviderDriverKind.make("opencode"),
  },
  antigravity: {
    label: "Antigravity",
    color: "#8c7bd1",
    driverKind: ProviderDriverKind.make("antigravity"),
  },
  pi: {
    label: "Pi",
    color: "#4d9f8a",
    driverKind: ProviderDriverKind.make("pi"),
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

/** Providers with real activity, independent of the metric currently displayed. */
export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}

/**
 * Driver kinds that report subscription limits but have no cost/token usage
 * (so no `UsageProviderKind`), such as GrokBot. Hidden ones are kept so they
 * can be re-checked after their snapshot disappears.
 */
export function limitsOnlyDrivers(
  presentations: Iterable<Pick<EnvironmentPresentation, "serverConfig">>,
  hidden: readonly string[] = [],
): readonly string[] {
  const costDrivers = new Set<string>(
    PROVIDER_ORDER.map((p) => PROVIDER_PRESENTATION[p].driverKind),
  );
  const found = new Set<string>(hidden);
  for (const { serverConfig } of presentations) {
    if (serverConfig === null) continue;
    for (const provider of serverConfig.providers) {
      if (provider.usageLimits !== undefined) found.add(provider.driver);
    }
    for (const source of serverConfig.usageLimitSources ?? []) {
      for (const account of source.accounts) found.add(account.driver);
    }
  }
  return [...found].filter((driver) => !costDrivers.has(driver)).toSorted();
}
