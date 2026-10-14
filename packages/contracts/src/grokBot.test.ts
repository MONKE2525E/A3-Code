import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  GrokBotCreateInput,
  GrokBotRuntimeActivity,
  grokBotAgentStamp,
  splitGrokBotAgentStamp,
} from "./grokBot.ts";

const accepts = Schema.is(GrokBotRuntimeActivity);
const activity = {
  source: "native",
  observedAtMs: 100,
  isRunning: true,
  isComposingMessage: false,
  awaitingUserResponse: null,
  currentActivity: { kind: "tool", tool: "WebSearch", hasDetail: false },
};
describe("Grok Bot runtime observations", () => {
  it("accepts bounded observed facts and partial transcript activity", () => {
    expect(accepts(activity)).toBe(true);
    expect(
      accepts({
        source: "transcript",
        observedAtMs: 100,
        awaitingUserResponse: { reason: "approval_pending" },
      }),
    ).toBe(true);
  });
  it("rejects unbounded labels and invalid observation times", () => {
    expect(accepts({ ...activity, observedAtMs: Infinity })).toBe(false);
    expect(accepts({ ...activity, observedAtMs: -1 })).toBe(false);
    expect(
      accepts({
        ...activity,
        currentActivity: { ...activity.currentActivity, tool: "x".repeat(129) },
      }),
    ).toBe(false);
    expect(accepts({ ...activity, awaitingUserResponse: { reason: "x".repeat(129) } })).toBe(false);
  });
});

describe("Grok Bot agent stamp", () => {
  it("strips the stamp line from agent-sent text and keeps the body", () => {
    const text = `${grokBotAgentStamp("Agent comms")}\n\nship it`;
    expect(splitGrokBotAgentStamp(text)).toEqual({ fromAgent: true, text: "ship it" });
  });

  it("leaves user-typed text unchanged, including text that only mentions the stamp", () => {
    expect(splitGrokBotAgentStamp("ship it")).toEqual({ fromAgent: false, text: "ship it" });
    const quoted = "[message from another agent, x] is how it looks";
    expect(splitGrokBotAgentStamp(quoted)).toEqual({ fromAgent: false, text: quoted });
  });
});

describe("native group creation", () => {
  it("accepts existing bot members and bounds the native one-to-six membership", () => {
    const accepts = Schema.is(GrokBotCreateInput);
    expect(accepts({ name: "Team" })).toBe(true);
    expect(accepts({ name: "Team", memberIds: ["a", "b"] })).toBe(true);
    for (const memberIds of [[], [""], Array.from({ length: 7 }, (_, i) => String(i))]) {
      expect(accepts({ name: "Team", memberIds })).toBe(false);
    }
  });
});
