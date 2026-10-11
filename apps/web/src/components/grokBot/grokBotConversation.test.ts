import { describe, expect, it } from "vite-plus/test";

import type { GrokBotMessage } from "@t3tools/contracts";

import {
  formatGrokBotVoiceCallDuration,
  grokBotErrorReason,
  grokBotUserMessageIds,
  grokBotVoiceCallLabel,
  groupGrokBotPeerCounts,
  groupGrokBotReactions,
  groupGrokBotTimeline,
  isGrokBotReplyAfterSend,
  isGrokBotSendDelivered,
} from "./grokBotConversation";

const user = { kind: "user" as const };
const self = { kind: "bot" as const, id: "bot-self", name: "UniFi Manager" };
const chicken = { kind: "bot" as const, id: "bot-chicken", name: "Dr. Chicken" };

const transcript = [
  { id: "u1", role: "user" as const, sender: user, text: "hello" },
  { id: "a1", role: "assistant" as const, sender: self, text: "hi" },
];

describe("isGrokBotSendDelivered", () => {
  it("matches only a user message that was not in the baseline", () => {
    const baselineUserIds = grokBotUserMessageIds(transcript);
    expect(
      isGrokBotSendDelivered([...transcript, { id: "u2", sender: user, text: " ship it " }], {
        text: "ship it",
        baselineUserIds,
      }),
    ).toBe(true);
    expect(isGrokBotSendDelivered(transcript, { text: "hello", baselineUserIds })).toBe(false);
  });

  it("ignores bot messages with the same text", () => {
    const baselineUserIds = grokBotUserMessageIds(transcript);
    expect(
      isGrokBotSendDelivered([...transcript, { id: "a2", sender: self, text: "ship it" }], {
        text: "ship it",
        baselineUserIds,
      }),
    ).toBe(false);
  });

  it("ignores a peer bot message that reached this chat with the user's role", () => {
    const baselineUserIds = grokBotUserMessageIds(transcript);
    expect(
      isGrokBotSendDelivered([...transcript, { id: "p1", sender: chicken, text: "ship it" }], {
        text: "ship it",
        baselineUserIds,
      }),
    ).toBe(false);
  });
});

describe("groupGrokBotTimeline", () => {
  const message = (
    id: string,
    sender: (typeof GrokBotMessage.Type)["sender"],
    addressee?: (typeof GrokBotMessage.Type)["addressee"],
  ) => ({
    id,
    role: sender.kind === "user" ? ("user" as const) : ("assistant" as const),
    sender,
    ...(addressee === undefined ? {} : { addressee }),
    text: id,
    timestampMs: 0,
    streaming: false,
  });

  it("collapses consecutive messages from one peer under one header", () => {
    const items = groupGrokBotTimeline(
      [message("u1", user), message("p1", chicken), message("p2", chicken), message("a1", self)],
      "bot-self",
    );
    expect(items.map((item) => item.kind)).toEqual(["message", "peer", "message"]);
    expect(items[1]).toMatchObject({
      kind: "peer",
      direction: "from",
      peer: chicken,
      messages: [{ id: "p1" }, { id: "p2" }],
    });
  });

  it("starts a new group when the peer changes", () => {
    const comms = { kind: "unknown" as const, label: "Former Bot" };
    const items = groupGrokBotTimeline([message("p1", chicken), message("p2", comms)], "bot-self");
    expect(items).toHaveLength(2);
  });

  it("keeps this bot's messages to a peer separate from that peer's messages", () => {
    const items = groupGrokBotTimeline(
      [message("p1", chicken), message("o1", self, chicken)],
      "bot-self",
    );
    expect(items.map((item) => (item.kind === "peer" ? item.direction : item.kind))).toEqual([
      "from",
      "to",
    ]);
  });

  it("leaves the human's and this bot's own messages standalone", () => {
    const items = groupGrokBotTimeline([message("u1", user), message("a1", self)], "bot-self");
    expect(items.map((item) => item.kind)).toEqual(["message", "message"]);
  });
});

describe("groupGrokBotPeerCounts", () => {
  const message = (
    id: string,
    sender: (typeof GrokBotMessage.Type)["sender"],
    addressee?: (typeof GrokBotMessage.Type)["addressee"],
  ) => ({
    id,
    role: sender.kind === "user" ? ("user" as const) : ("assistant" as const),
    sender,
    ...(addressee === undefined ? {} : { addressee }),
    text: id,
    timestampMs: 0,
    streaming: false,
  });

  it("counts inbound and outbound bot-to-bot messages per peer, in first-seen order", () => {
    const comms = { kind: "bot" as const, id: "bot-comms", name: "Comms Bot" };
    const counts = groupGrokBotPeerCounts(
      [
        message("u1", user),
        message("p1", chicken),
        message("o1", self, chicken),
        message("p2", comms),
        message("p3", chicken),
        message("a1", self),
      ],
      "bot-self",
    );
    expect(counts).toEqual([
      { key: "bot:bot-chicken", peer: chicken, count: 3 },
      { key: "bot:bot-comms", peer: comms, count: 1 },
    ]);
  });

  it("is empty when the conversation has no bot-to-bot messages", () => {
    expect(groupGrokBotPeerCounts([message("u1", user), message("a1", self)], "bot-self")).toEqual(
      [],
    );
  });
});

describe("grokBotErrorReason", () => {
  it("reads the reason of a GrokBotError and nothing else", () => {
    expect(grokBotErrorReason({ _tag: "GrokBotError", reason: "delivery_unknown" })).toBe(
      "delivery_unknown",
    );
    expect(grokBotErrorReason({ _tag: "OtherError", reason: "delivery_unknown" })).toBeNull();
    expect(grokBotErrorReason(new Error("boom"))).toBeNull();
  });
});

describe("groupGrokBotReactions", () => {
  it("counts repeated emoji in first-seen order", () => {
    expect(
      groupGrokBotReactions([
        { emoji: "👍", from: "bot", messageId: "u1" },
        { emoji: "❤️", from: "user", messageId: "u1" },
        { emoji: "👍", from: "user", messageId: "u1" },
      ]),
    ).toEqual([
      { emoji: "👍", count: 2 },
      { emoji: "❤️", count: 1 },
    ]);
  });
});

describe("isGrokBotReplyAfterSend", () => {
  it("does not treat the settled reply from before the send as the answer", () => {
    expect(
      isGrokBotReplyAfterSend({
        afterMessageId: "a1",
        lastMessageId: "a1",
        lastMessageSettled: true,
      }),
    ).toBe(false);
  });

  it("settles on a newer settled message, including a reaction-only reply", () => {
    expect(
      isGrokBotReplyAfterSend({
        afterMessageId: "a1",
        lastMessageId: "a2",
        lastMessageSettled: true,
      }),
    ).toBe(true);
  });

  it("waits while the newer message is still streaming", () => {
    expect(
      isGrokBotReplyAfterSend({
        afterMessageId: "a1",
        lastMessageId: "a2",
        lastMessageSettled: false,
      }),
    ).toBe(false);
  });

  it("settles on the first reply to a conversation that had no messages before the send", () => {
    expect(
      isGrokBotReplyAfterSend({
        afterMessageId: undefined,
        lastMessageId: "a1",
        lastMessageSettled: true,
      }),
    ).toBe(true);
  });
});

describe("voice call marker", () => {
  it("reads the call clock as native does, m:ss and h:mm:ss from an hour", () => {
    expect(formatGrokBotVoiceCallDuration(12_000)).toBe("0:12");
    expect(formatGrokBotVoiceCallDuration(65_400)).toBe("1:05");
    expect(formatGrokBotVoiceCallDuration(3_601_000)).toBe("1:00:01");
  });

  it("labels a failed call as failed and any other ending as a plain voice chat", () => {
    expect(grokBotVoiceCallLabel({ callId: "c", ending: "failed" })).toBe("Voice chat failed");
    expect(grokBotVoiceCallLabel({ callId: "c", ending: "completed" })).toBe("Voice chat");
    expect(grokBotVoiceCallLabel({ callId: "c" })).toBe("Voice chat");
  });
});
