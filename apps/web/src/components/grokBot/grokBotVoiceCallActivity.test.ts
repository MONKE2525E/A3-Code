import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveGrokBotVoiceCallActivity } from "./grokBotVoiceCallActivity";
import type { GrokBotVoicePhase } from "./grokBotVoiceCall";
import type { PinnedGrokBotVoiceCall } from "./useGrokBotVoiceCall";

const ENVIRONMENT = "call-environment" as EnvironmentId;

function call(phase: GrokBotVoicePhase): PinnedGrokBotVoiceCall {
  return {
    environmentId: ENVIRONMENT,
    botId: "bot-one",
    botName: "Bot one",
    state: { phase, muted: false, notice: null },
  };
}

describe("resolveGrokBotVoiceCallActivity", () => {
  it("follows connection, live audio, reconnection, and hang-up without leaving call motion behind", () => {
    const phases = ["starting", "connecting", "live", "reconnecting", "live", "idle"] as const;
    expect(
      phases.map((phase) =>
        resolveGrokBotVoiceCallActivity({
          call: call(phase),
          environmentId: ENVIRONMENT,
          botId: "bot-one",
          activity: undefined,
        }),
      ),
    ).toEqual(["loading", "loading", "listening", "loading", "listening", undefined]);
  });

  it("requires both the bot identity and environment, including identical bot ids on remote environments", () => {
    for (const target of [
      { environmentId: ENVIRONMENT, botId: "bot-two" },
      { environmentId: "other-environment" as EnvironmentId, botId: "bot-one" },
      { environmentId: null, botId: "bot-one" },
    ]) {
      expect(
        resolveGrokBotVoiceCallActivity({ call: call("live"), ...target, activity: "reading" }),
      ).toBe("reading");
    }
  });

  it("restores ongoing thread work after terminal disconnects even while the call notice remains", () => {
    for (const notice of [null, "Call ended.", "Call disconnected.", "Voice connection failed."]) {
      const ended = call("idle");
      expect(
        resolveGrokBotVoiceCallActivity({
          call: { ...ended, state: { ...ended.state, notice } },
          environmentId: ENVIRONMENT,
          botId: "bot-one",
          activity: "working",
        }),
      ).toBe("working");
    }
  });

  it("keeps a muted live call active and preserves ordinary activity without a call provider", () => {
    const live = call("live");
    const target = { environmentId: ENVIRONMENT, botId: "bot-one", activity: "running" as const };
    expect(
      resolveGrokBotVoiceCallActivity({
        ...target,
        call: { ...live, state: { ...live.state, muted: true } },
      }),
    ).toBe("listening");
    expect(resolveGrokBotVoiceCallActivity({ ...target, call: null })).toBe("running");
  });
});
