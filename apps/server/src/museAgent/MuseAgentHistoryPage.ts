import { museHistoryFrame } from "../orchestration-v2/Adapters/MuseAgentAdapterV2Projection.ts";

/** Native history uses an exclusive canonical-sequence cursor, unlike stream deltas. */
export function museAgentHistoryPage(
  page: { readonly events: readonly unknown[]; readonly hasMore: boolean },
  sessionId: string,
  beforeSeq?: number,
) {
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0))
    throw new Error("Invalid Muse history cursor.");
  if (page.events.length > 80) throw new Error("Muse history page exceeds the native page limit.");
  const frames = page.events.map((row) => museHistoryFrame(row, sessionId));
  let oldest: number | null = null;
  for (const frame of frames) {
    const seq = frame?.meta?.seq;
    if (
      !frame ||
      typeof frame.payload !== "object" ||
      frame.payload === null ||
      !("session_id" in frame.payload) ||
      frame.payload.session_id !== sessionId ||
      seq === undefined ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      seq >= 999_999 ||
      (beforeSeq !== undefined && seq >= beforeSeq)
    )
      throw new Error("Muse returned an invalid or unsupported history page.");
    oldest = oldest === null ? seq : Math.min(oldest, seq);
  }
  if (page.hasMore && (oldest === null || oldest === 0))
    throw new Error("Muse history pagination made no progress.");
  return {
    frames: frames
      .filter((frame) => frame !== null)
      .sort((a, b) => (a.meta?.seq ?? 0) - (b.meta?.seq ?? 0)),
    nextBeforeSeq: oldest,
    hasMore: page.hasMore,
  };
}
