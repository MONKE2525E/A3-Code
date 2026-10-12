import { assert, it } from "@effect/vitest";

import { defaultGrokBotAvatarColor, defaultGrokBotAvatarShape } from "./defaultAvatar.ts";

it("picks the look the Grok Bot app shows for a bot without one", () => {
  const commsBot = "faa4a5e6-7dce-44b5-84d1-94c06a8718fe";
  assert.strictEqual(defaultGrokBotAvatarShape(commsBot), "cloud");
  assert.strictEqual(defaultGrokBotAvatarColor(commsBot), "blue");
});
