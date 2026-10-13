import { describe, expect, it } from "vite-plus/test";

import type { GrokBotMessage } from "@t3tools/contracts";

import {
  formatGrokBotVoiceCallDuration,
  grokBotErrorReason,
  grokBotReactionTitle,
  grokBotUserMessageIds,
  grokBotVoiceCallLabel,
  groupGrokBotPeerCounts,
  groupGrokBotReactions,
  groupGrokBotTimeline,
  isGrokBotReactionReplyToSend,
  isGrokBotSendDelivered,
  isGrokBotSettledTextTurn,
  isGrokBotTextReplyAfterSend,
} from "./grokBotConversation";

const user = { kind: "user" as const };
const self = { kind: "bot" as const, id: "bot-self", name: "UniFi Manager" };
const chicken = { kind: "bot" as const, id: "bot-chicken", name: "Dr. Chicken" };

const transcript = [
  { id: "u1", role: "user" as const, sender: user, text: "hello" },
  { id: "a1", role: "assistant" as const, sender: self, text: "hi" },
];

type Row = typeof GrokBotMessage.Type;
const row = (
  id: string,
  sender: Row["sender"],
  fields: {
    readonly text?: string;
    readonly reactions?: Row["reactions"];
    readonly reactionOnly?: true;
    readonly streaming?: true;
    readonly addressee?: Row["addressee"];
  } = {},
): Row => ({
  id,
  role: sender.kind === "user" ? "user" : "assistant",
  sender,
  text: fields.text ?? id,
  timestampMs: 0,
  streaming: fields.streaming ?? false,
  ...(fields.reactions === undefined ? {} : { reactions: fields.reactions }),
  ...(fields.reactionOnly === undefined ? {} : { reactionOnly: fields.reactionOnly }),
  ...(fields.addressee === undefined ? {} : { addressee: fields.addressee }),
});

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

describe("isGrokBotTextReplyAfterSend", () => {
  const botId = self.id;
  // The send follows a1, the last row from before it.
  const before = [row("u1", user, { text: "hello" }), row("a1", self)];
  const sentRow = row("u2", user, { text: "ship it" });
  const standalone = (id: string) =>
    row(id, self, {
      text: "👍",
      reactions: [{ emoji: "👍", from: "bot", messageId: "gone" }],
      reactionOnly: true,
    });
  // `afterMessageId` is the send's boundary; it is required so each case states it.
  const answers = (afterMessageId: string | undefined, messages: readonly Row[]) =>
    isGrokBotTextReplyAfterSend({ afterMessageId, botId, messages });

  it("settles on a settled text reply after the send", () => {
    expect(answers("a1", [...before, sentRow, row("a2", self, { text: "shipped" })])).toBe(true);
  });

  it("settles on a text reply even when a standalone reaction follows it", () => {
    expect(
      answers("a1", [...before, sentRow, row("a2", self, { text: "shipped" }), standalone("r1")]),
    ).toBe(true);
  });

  it("does not settle on a standalone reaction alone", () => {
    expect(answers("a1", [...before, sentRow, standalone("r1")])).toBe(false);
  });

  it("does not treat the settled reply from before the send as the answer", () => {
    expect(answers("a1", [...before, sentRow])).toBe(false);
  });

  it("does not settle on an older text reply that sits before the send's boundary", () => {
    expect(
      answers("a1", [
        row("a0", self, { text: "old answer" }),
        row("u1", user),
        row("a1", self),
        sentRow,
      ]),
    ).toBe(false);
  });

  it("waits while the reply after the send is still streaming", () => {
    expect(
      answers("a1", [...before, sentRow, row("a2", self, { text: "shi", streaming: true })]),
    ).toBe(false);
  });

  it("settles on the first reply to a conversation that had no messages before the send", () => {
    expect(answers(undefined, [sentRow, row("a1", self)])).toBe(true);
    expect(answers(undefined, [sentRow])).toBe(false);
  });

  it("settles nothing when the boundary is missing from the transcript", () => {
    const messages = [row("a0", self, { text: "old answer" }), sentRow, row("a2", self)];
    expect(answers("gone", messages)).toBe(false);
  });

  it("does not settle on this bot's message to a peer after the send", () => {
    const toPeer = row("o1", self, { text: "hi chicken", addressee: chicken });
    expect(answers("a1", [...before, sentRow, toPeer])).toBe(false);
  });

  it("settles on this bot's reply after it messaged a peer", () => {
    const toPeer = row("o1", self, { text: "hi chicken", addressee: chicken });
    const reply = row("a2", self, { text: "shipped" });
    expect(answers("a1", [...before, sentRow, toPeer, reply])).toBe(true);
  });

  it("does not settle on a peer bot's message that reached this chat", () => {
    const fromPeer = row("p1", chicken, { text: "cluck" });
    // The wire marks a peer's message role user; the assistant-role copy is rejected by sender.
    expect(answers("a1", [...before, sentRow, fromPeer])).toBe(false);
    expect(answers("a1", [...before, sentRow, { ...fromPeer, role: "user" }])).toBe(false);
  });
});

describe("grokBotReactionTitle", () => {
  it("names who put each emoji on the message", () => {
    const reactions = [
      { emoji: "👍", from: "bot" as const, messageId: "u1" },
      { emoji: "👍", from: "user" as const, messageId: "u1" },
      { emoji: "🎉", from: "bot" as const, messageId: "u1" },
    ];
    expect(grokBotReactionTitle(reactions, "👍")).toBe("Reacted by you and Grok Bot");
    expect(grokBotReactionTitle(reactions, "🎉")).toBe("Reacted by Grok Bot");
  });
});

describe("isGrokBotReactionReplyToSend", () => {
  const botReaction = (messageId: string): NonNullable<Row["reactions"]> => [
    { emoji: "👍", from: "bot", messageId },
  ];
  // "ship it" was sent after u1 and a1 were in the transcript.
  const sent = { text: "ship it", baselineUserIds: new Set(["u1"]) };
  const reply = (messages: readonly Row[]) => isGrokBotReactionReplyToSend({ sent, messages });

  it("does not count a new bot reaction on an old message the send did not produce", () => {
    const messages = [
      row("u1", user, {
        text: "hello",
        reactions: [...botReaction("u1"), { emoji: "🎉", from: "bot", messageId: "u1" }],
      }),
      row("a1", self),
      row("u2", user, { text: "ship it" }),
    ];
    expect(reply(messages)).toBe(false);
  });

  it("does not count an old same-text message as the echo of the send", () => {
    const messages = [
      row("u1", user, { text: "ship it", reactions: botReaction("u1") }),
      row("a1", self),
    ];
    expect(reply(messages)).toBe(false);
  });

  it("counts a bot reaction on the message the send produced", () => {
    const messages = [
      row("u1", user, { text: "hello" }),
      row("a1", self),
      row("u2", user, { text: "ship it", reactions: botReaction("u2") }),
    ];
    expect(reply(messages)).toBe(true);
  });

  it("does not count the user's own reaction on the sent message", () => {
    const messages = [
      row("a1", self),
      row("u2", user, {
        text: "ship it",
        reactions: [{ emoji: "❤️", from: "user", messageId: "u2" }],
      }),
    ];
    expect(reply(messages)).toBe(false);
  });

  it("does not count a standalone bot reaction, whose target is not in the transcript", () => {
    const standalone = (id: string) =>
      row(id, self, {
        text: "👍",
        reactions: [{ emoji: "👍", from: "bot", messageId: "gone" }],
        reactionOnly: true,
      });
    const messages = [
      standalone("r0"),
      row("a1", self),
      row("u2", user, { text: "ship it" }),
      standalone("r1"),
    ];
    expect(reply(messages)).toBe(false);
  });
});

describe("isGrokBotSettledTextTurn", () => {
  const turn = (fields: Partial<typeof GrokBotMessage.Type>) => ({
    id: "a1",
    role: "assistant" as const,
    sender: self,
    text: "done",
    timestampMs: 0,
    streaming: false,
    ...fields,
  });

  it("settles on a finished bot text reply", () => {
    expect(isGrokBotSettledTextTurn(turn({}))).toBe(true);
  });

  it("does not settle on a streaming, user, reaction-only, or missing turn", () => {
    expect(isGrokBotSettledTextTurn(turn({ streaming: true }))).toBe(false);
    expect(isGrokBotSettledTextTurn(turn({ role: "user", sender: user }))).toBe(false);
    expect(isGrokBotSettledTextTurn(turn({ reactionOnly: true }))).toBe(false);
    expect(isGrokBotSettledTextTurn(undefined)).toBe(false);
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
