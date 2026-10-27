import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

export const MuseAgentSubscription = Schema.Struct({
  tier: Schema.Struct({ name: Schema.String }),
  usage: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        state: Schema.String,
        percentUsed: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        resetsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
  topupBalance: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  topupTotal: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  topupRowValueLabel: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type MuseAgentSubscription = typeof MuseAgentSubscription.Type;

export function museAgentUsageLimits(
  subscription: MuseAgentSubscription,
  checkedAt: string,
): ServerProviderUsageLimits {
  const windows: ServerProviderUsageWindow[] = [];
  const usage = subscription.usage;
  if (
    usage?.state === "METERED" &&
    typeof usage.percentUsed === "number" &&
    Number.isFinite(usage.percentUsed)
  ) {
    const reset = usage.resetsAt;
    const resetsAt =
      typeof reset === "number" && Number.isFinite(reset) && reset > 0 && reset < 8640000000000
        ? DateTime.formatIso(DateTime.makeUnsafe(reset * 1000))
        : undefined;
    windows.push({
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: Math.max(0, Math.min(100, usage.percentUsed)),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const balance = subscription.topupBalance,
    total = subscription.topupTotal;
  if (
    typeof balance === "number" &&
    typeof total === "number" &&
    Number.isFinite(balance) &&
    Number.isFinite(total) &&
    total > 0
  ) {
    windows.push({
      id: "additional",
      kind: "other",
      label: "Additional tokens",
      usedPercent: Math.round((100 * (total - Math.max(0, Math.min(balance, total)))) / total),
    });
  }
  return windows.length
    ? { checkedAt, windows }
    : makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Muse did not report an allowance.",
      });
}
