import type { GrokBot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { grokBotEntryCopy, grokBotEntryPhase } from "./grokBotEntryPhase";

const bot = { id: "b1", name: "Pip" } as GrokBot;

describe("grokBotEntryPhase", () => {
  it("names the step the entry is waiting on", () => {
    expect(grokBotEntryPhase({ readinessPending: true, bot: null })).toBe("connecting");
    expect(grokBotEntryPhase({ readinessPending: false, bot: null })).toBe("finding");
    expect(grokBotEntryPhase({ readinessPending: false, bot })).toBe("opening");
  });

  it("uses the bot's name only once it is known", () => {
    expect(grokBotEntryCopy("opening", "Pip").title).toBe("Opening Pip");
    expect(grokBotEntryCopy("opening", null).title).toBe("Opening chat");
  });
});
