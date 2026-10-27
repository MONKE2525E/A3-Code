const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

export interface MuseUsageObservation {
  readonly at: number;
  readonly weeklyUsed: number;
  readonly reset: number;
  readonly weeklyAllowance: number;
  readonly bonusBalance: number;
  readonly bonusTotal: number;
  readonly bonusTokenScale: number;
  readonly bonusKnown?: boolean;
}

export function estimateMuseUsage(previous: MuseUsageObservation, current: MuseUsageObservation) {
  if (current.at <= previous.at) return [];
  const buckets = new Map<number, number>();
  const spread = (start: number, end: number, amount: number) => {
    const earliest = end - 90 * 24 * HOUR_MS;
    if (start < earliest) {
      amount *= (end - earliest) / (end - start);
      start = earliest;
    }
    const total = Math.max(0, Math.round(amount));
    if (start >= end || total === 0) return;
    let allocated = 0;
    for (let cursor = start; cursor < end;) {
      const bucket = Math.floor(cursor / HOUR_MS) * HOUR_MS;
      const next = Math.min(end, bucket + HOUR_MS);
      const cumulative = Math.round((total * (next - start)) / (end - start));
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + cumulative - allocated);
      allocated = cumulative;
      cursor = next;
    }
  };
  if (previous.weeklyAllowance === current.weeklyAllowance) {
    if (previous.reset === current.reset && current.weeklyUsed >= previous.weeklyUsed) {
      spread(
        previous.at,
        current.at,
        ((current.weeklyUsed - previous.weeklyUsed) * current.weeklyAllowance) / 100,
      );
    } else if (current.reset > previous.reset && current.reset - WEEK_MS <= current.at) {
      spread(
        Math.max(previous.at, current.reset - WEEK_MS),
        current.at,
        (current.weeklyUsed * current.weeklyAllowance) / 100,
      );
    }
  }
  if (
    previous.bonusKnown !== false &&
    current.bonusKnown !== false &&
    current.bonusTotal >= previous.bonusTotal &&
    current.bonusTokenScale > 0
  ) {
    const added = current.bonusTotal - previous.bonusTotal;
    spread(
      previous.at,
      current.at,
      (previous.bonusBalance + added - current.bonusBalance) * current.bonusTokenScale,
    );
  }
  return [...buckets]
    .filter(([, tokens]) => tokens > 0)
    .sort(([a], [b]) => a - b)
    .map(([start, tokens]) => ({ start, tokens }));
}
