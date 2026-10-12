import type {
  GrokBotMessage,
  GrokBotParticipant,
  GrokBotVoiceCallMarker,
} from "@t3tools/contracts";

type ConversationMessage = Pick<typeof GrokBotMessage.Type, "id" | "sender" | "text">;
type ReactionList = NonNullable<typeof GrokBotMessage.Type.reactions>;
export type GrokBotPeer = typeof GrokBotParticipant.Type;

/** One message, or consecutive messages with the same peer in the same direction under one header. */
export type GrokBotTimelineItem =
  | { readonly kind: "message"; readonly message: typeof GrokBotMessage.Type }
  | {
      readonly kind: "peer";
      /** `from`: the peer wrote these. `to`: this bot wrote them to the peer. */
      readonly direction: "from" | "to";
      readonly peer: GrokBotPeer;
      readonly messages: readonly (typeof GrokBotMessage.Type)[];
    };

/** A message the user sent, plus the user messages that existed before it was sent. */
export interface GrokBotSentMessage {
  readonly text: string;
  readonly baselineUserIds: ReadonlySet<string>;
}

export function grokBotUserMessageIds(
  messages: readonly ConversationMessage[],
): ReadonlySet<string> {
  return new Set(
    messages.filter((message) => message.sender.kind === "user").map((message) => message.id),
  );
}

/** Delivered once the polled transcript shows a user message with the same text that was not there before. */
export function isGrokBotSendDelivered(
  messages: readonly ConversationMessage[],
  sent: GrokBotSentMessage,
): boolean {
  const text = sent.text.trim();
  return messages.some(
    (message) =>
      message.sender.kind === "user" &&
      !sent.baselineUserIds.has(message.id) &&
      message.text.trim() === text,
  );
}

export function grokBotErrorReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  if (!("_tag" in error) || error._tag !== "GrokBotError") return null;
  return "reason" in error && typeof error.reason === "string" ? error.reason : null;
}

function peerKey(peer: GrokBotPeer): string {
  return peer.kind === "bot" ? `bot:${peer.id}` : `unknown:${peer.label}`;
}

/**
 * Bot-to-bot messages are not the human's, so they leave the user's side. A message this bot
 * sent to a peer is grouped as `to`; a message a peer sent is grouped as `from`.
 */
function peerOf(
  message: typeof GrokBotMessage.Type,
  selfId: string,
): { readonly direction: "from" | "to"; readonly peer: GrokBotPeer } | null {
  if (message.addressee !== undefined) return { direction: "to", peer: message.addressee };
  if (message.sender.kind === "user") return null;
  if (message.sender.kind === "bot" && message.sender.id === selfId) return null;
  return { direction: "from", peer: message.sender };
}

/** Bot-to-bot messages per peer across the whole conversation, in the order each peer first appears. */
export function groupGrokBotPeerCounts(
  messages: readonly (typeof GrokBotMessage.Type)[],
  selfId: string,
): readonly { readonly key: string; readonly peer: GrokBotPeer; readonly count: number }[] {
  const counts = new Map<string, { peer: GrokBotPeer; count: number }>();
  for (const message of messages) {
    const found = peerOf(message, selfId);
    if (found === null) continue;
    const key = peerKey(found.peer);
    const entry = counts.get(key);
    if (entry === undefined) counts.set(key, { peer: found.peer, count: 1 });
    else entry.count += 1;
  }
  return [...counts].map(([key, { peer, count }]) => ({ key, peer, count }));
}

export function groupGrokBotTimeline(
  messages: readonly (typeof GrokBotMessage.Type)[],
  selfId: string,
): readonly GrokBotTimelineItem[] {
  const items: GrokBotTimelineItem[] = [];
  for (const message of messages) {
    const peer = peerOf(message, selfId);
    if (peer === null) {
      items.push({ kind: "message", message });
      continue;
    }
    const last = items.at(-1);
    if (
      last?.kind === "peer" &&
      last.direction === peer.direction &&
      peerKey(last.peer) === peerKey(peer.peer)
    ) {
      items[items.length - 1] = { ...last, messages: [...last.messages, message] };
      continue;
    }
    items.push({ kind: "peer", ...peer, messages: [message] });
  }
  return items;
}

/** `m:ss`, or `h:mm:ss` from an hour up, the same clock native shows on its call card. */
export function formatGrokBotVoiceCallDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

export function grokBotVoiceCallLabel(marker: GrokBotVoiceCallMarker): string {
  return marker.ending === "failed" ? "Voice chat failed" : "Voice chat";
}

export function groupGrokBotReactions(
  reactions: ReactionList | undefined,
): readonly { readonly emoji: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const reaction of reactions ?? []) {
    counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
  }
  return [...counts].map(([emoji, count]) => ({ emoji, count }));
}

/**
 * A settled message settles the wait only when it arrived after the send began.
 * The last message from before the send is an old reply, however settled it is.
 */
export function isGrokBotReplyAfterSend(input: {
  readonly afterMessageId: string | undefined;
  readonly lastMessageId: string | undefined;
  readonly lastMessageSettled: boolean;
}): boolean {
  return (
    input.lastMessageSettled &&
    input.lastMessageId !== undefined &&
    input.lastMessageId !== input.afterMessageId
  );
}
