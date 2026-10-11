import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

const SandUsage = Schema.Struct({
  usagePercent: Schema.optionalKey(Schema.Number),
  nextResetTimestampUtc: Schema.optionalKey(Schema.String),
  usesPooledEnterpriseAllowance: Schema.optionalKey(Schema.Boolean),
});
const decodeSandUsage = Schema.decodeUnknownSync(SandUsage);

/** Mirrors the native weekly summary, which hides pooled enterprise allowances. */
export function grokBotUsageLimits(
  sandStatus: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  const sand = decodeSandUsage(sandStatus);
  if (sand.usesPooledEnterpriseAllowance || sand.usagePercent === undefined) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: sand.usesPooledEnterpriseAllowance
        ? "This account uses a pooled enterprise allowance."
        : "The native account did not report a weekly allowance.",
    });
  }
  if (!Number.isFinite(sand.usagePercent)) throw new Error("Invalid native usage percentage.");
  const resetMs = Date.parse(sand.nextResetTimestampUtc ?? "");
  return {
    checkedAt,
    windows: [
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(sand.usagePercent),
        ...(Number.isFinite(resetMs) && resetMs > 0
          ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetMs)) }
          : {}),
      },
    ],
  };
}
