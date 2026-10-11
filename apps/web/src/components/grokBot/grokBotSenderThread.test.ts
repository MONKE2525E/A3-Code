import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { grokBotIdForSenderThread } from "./grokBotSenderThread";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

function shell(input: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly model: string;
  readonly title?: string;
}) {
  return {
    environmentId: input.environmentId,
    id: ThreadId.make(input.id),
    title: input.title ?? "Untitled",
    modelSelection: {
      instanceId: ProviderInstanceId.make("grok-bot-instance"),
      model: input.model,
    },
  };
}

describe("grokBotIdForSenderThread", () => {
  const shells = [
    shell({ environmentId: envA, id: "grok-bot:canonical-1", model: "bot-1" }),
    shell({ environmentId: envA, id: "thread:coding", model: "gpt-x", title: "Grok Bot" }),
    shell({ environmentId: envB, id: "grok-bot:canonical-2", model: "bot-2" }),
  ];

  it("resolves a canonical bot thread in the same environment to its bot", () => {
    expect(
      grokBotIdForSenderThread(shells, {
        environmentId: envA,
        threadId: ThreadId.make("grok-bot:canonical-1"),
      }),
    ).toBe("bot-1");
  });

  it("does not match a canonical thread from another environment", () => {
    expect(
      grokBotIdForSenderThread(shells, {
        environmentId: envA,
        threadId: ThreadId.make("grok-bot:canonical-2"),
      }),
    ).toBeNull();
  });

  it("never treats an ordinary thread as a bot, even with a bot-like title", () => {
    expect(
      grokBotIdForSenderThread(shells, {
        environmentId: envA,
        threadId: ThreadId.make("thread:coding"),
      }),
    ).toBeNull();
  });

  it("leaves unknown senders to the generic fallback", () => {
    expect(
      grokBotIdForSenderThread(shells, {
        environmentId: envA,
        threadId: ThreadId.make("thread:missing"),
      }),
    ).toBeNull();
  });
});
