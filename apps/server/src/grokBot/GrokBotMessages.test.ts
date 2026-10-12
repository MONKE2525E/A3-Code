import { describe, expect, it } from "@effect/vitest";
import { messagesFrom } from "./GrokBotService.ts";

const self = { id: "bot-self", name: "UniFi Manager" };
const roster = [
  self,
  { id: "bot-chicken", name: "Dr. Chicken" },
  { id: "bot-comms", name: "Comms Bot" },
];

// Shapes match the live gateway transcript: bot-to-bot entries are `kind: "message"`, with
// `toAgent` on the bot's own outbound and `fromAgent` on the peer's inbound, never both.
const entries = [
  { kind: "message", id: "u1", role: "user", content: "check the audit", timestampMs: 1 },
  { kind: "send-message", id: "a1", message: { type: "text", content: "on it" }, timestampMs: 2 },
  {
    kind: "message",
    id: "out1",
    role: "assistant",
    content: "blocked: gateway down",
    toAgent: { id: "bot-chicken", name: "Chicken (old name)", kind: "agent" },
    timestampMs: 3,
  },
  {
    kind: "message",
    id: "in1",
    role: "user",
    content: "gateway is back",
    fromAgent: { id: "bot-chicken", name: "Noah's CEO" },
    timestampMs: 4,
  },
  {
    kind: "message",
    id: "in2",
    role: "user",
    content: "stranger says hi",
    fromAgent: { id: "bot-removed", name: "Former Bot" },
    timestampMs: 5,
  },
  {
    kind: "message",
    id: "out2",
    role: "assistant",
    content: "to comms",
    toAgent: { id: "bot-comms", name: "Comms Bot", kind: "agent" },
    timestampMs: 6,
  },
] as const;

describe("messagesFrom", () => {
  it("attributes peer messages to the peer, resolved on id against the roster", () => {
    const messages = messagesFrom(entries, self, roster);
    const inbound = messages.find((message) => message.id === "in1");
    expect(inbound?.sender).toEqual({ kind: "bot", id: "bot-chicken", name: "Dr. Chicken" });
    expect(inbound?.addressee).toBeUndefined();
  });

  it("never reports a peer message as the human user", () => {
    const messages = messagesFrom(entries, self, roster);
    for (const id of ["in1", "in2"]) {
      expect(messages.find((message) => message.id === id)?.sender.kind).not.toBe("user");
    }
    expect(messages.find((message) => message.id === "u1")?.sender).toEqual({ kind: "user" });
  });

  it("keeps outbound bot-to-bot messages, from this bot and addressed to the peer", () => {
    const messages = messagesFrom(entries, self, roster);
    const outbound = messages.find((message) => message.id === "out1");
    expect(outbound?.text).toBe("blocked: gateway down");
    expect(outbound?.sender).toEqual({ kind: "bot", id: "bot-self", name: "UniFi Manager" });
    expect(outbound?.addressee).toEqual({ kind: "bot", id: "bot-chicken", name: "Dr. Chicken" });
    expect(messages.find((message) => message.id === "out2")?.addressee).toEqual({
      kind: "bot",
      id: "bot-comms",
      name: "Comms Bot",
    });
  });

  it("falls back to the wire name as an unknown label when the peer is not in the roster", () => {
    const messages = messagesFrom(entries, self, roster);
    expect(messages.find((message) => message.id === "in2")?.sender).toEqual({
      kind: "unknown",
      label: "Former Bot",
    });
  });

  it("keeps the wire order and the role field older clients read", () => {
    const messages = messagesFrom(entries, self, roster);
    expect(messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "out1",
      "in1",
      "in2",
      "out2",
    ]);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
      "user",
      "assistant",
    ]);
  });
});

it("retains a native Teach handoff workflow chip in the readonly bot conversation", () => {
  const references = [
    {
      id: "learn-from-demonstration",
      label: "Learn from demonstration",
      teachQueueScope: "demo-scope",
    },
  ];
  const messages = messagesFrom(
    [
      {
        id: "teach-handoff",
        kind: "message",
        role: "user",
        content: "The recording is finished. Learn the task from it.",
        richText: JSON.stringify({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "workflowReference", attrs: references[0] }] },
          ],
        }),
        clientNonce: "teach-recording:demo-scope:recording.json",
      },
    ],
    self,
    roster,
  );
  expect(messages[0]?.text).toBe("The recording is finished. Learn the task from it.");
  expect(messages[0]?.grokBotWorkflowReferences).toEqual(references);
});

describe("voice call history", () => {
  // Shapes follow native's transcript: a `voice-call` row carries the call record, the call's
  // follow-up instruction is a suppressed user message on its `voice:` channel, and the summary is
  // bot text. A user's own spoken line on the same channel is not suppressed and stays visible.
  const voiceEntries = [
    { kind: "message", id: "u0", role: "user", content: "call them", timestampMs: 1 },
    {
      kind: "message",
      id: "uvoice",
      role: "user",
      content: "what did we decide?",
      channel: "voice:call-1",
      timestampMs: 5,
    },
    {
      kind: "message",
      id: "ins1",
      role: "user",
      content: "The call ended. Recap it.",
      channel: "voice:call-1",
      suppressed: "voice-call",
      timestampMs: 9,
    },
    {
      kind: "voice-call",
      id: "vc1",
      call: { callId: "call-1", durationMs: 12_000, ending: "completed", turnCount: 4 },
      timestampMs: 10,
    },
    {
      kind: "send-message",
      id: "sum1",
      message: { type: "text", content: "We agreed on the rollout.", channel: "voice:call-1" },
      timestampMs: 11,
    },
  ] as const;

  it("shows the call as a marker before native's summary and hides only the suppressed instruction", () => {
    const messages = messagesFrom(voiceEntries, self, roster);
    expect(messages.map((message) => message.id)).toEqual(["u0", "uvoice", "vc1", "sum1"]);
    expect(messages[1]).toMatchObject({ text: "what did we decide?", sender: { kind: "user" } });
    expect(messages[2]).toMatchObject({
      text: "",
      voiceCall: { callId: "call-1", durationMs: 12_000, ending: "completed" },
    });
    expect(messages[3]).toMatchObject({ text: "We agreed on the rollout.", sender: self });
  });

  it("leaves duration absent when native recorded none rather than estimating it", () => {
    const [marker] = messagesFrom(
      [{ kind: "voice-call", id: "vc2", call: { callId: "call-2", ending: "failed" } }],
      self,
      roster,
    );
    expect(marker?.voiceCall).toEqual({ callId: "call-2", ending: "failed" });
  });

  it("drops a call record without a usable callId and shows a replayed call once", () => {
    const messages = messagesFrom(
      [
        { kind: "voice-call", id: "bad", call: { durationMs: 5_000 } },
        { kind: "voice-call", id: "vc3", call: { callId: "call-3", durationMs: 1_000 } },
        { kind: "voice-call", id: "vc3", call: { callId: "call-3", durationMs: 1_000 } },
      ],
      self,
      roster,
    );
    expect(messages.map((message) => message.id)).toEqual(["vc3"]);
  });
});
