import { assert, it } from "@effect/vitest";

import {
  museIdentityOfThread,
  museThreadIdentity,
  museSessionOfThread,
  museThreadIdForSession,
} from "./MuseAgentThreadIds.ts";

const identity = "a".repeat(64);

it("keeps Main chat's id unchanged and gives each side chat its own id", () => {
  assert.strictEqual(museThreadIdForSession(identity), `muse-agent:${identity}`);
  const side = museThreadIdForSession(identity, "session:42/x");
  assert.strictEqual(side, `muse-agent:${identity}:session%3A42%2Fx`);
  assert.strictEqual(museIdentityOfThread(side), identity);
  assert.strictEqual(museSessionOfThread(side), "session:42/x");
});

it("reads Main chat as the primary session and ignores other threads", () => {
  const main = museThreadIdForSession(identity);
  assert.strictEqual(museIdentityOfThread(main), identity);
  assert.strictEqual(museSessionOfThread(main), undefined);
  assert.strictEqual(museIdentityOfThread("grok-bot:abc"), null);
  assert.strictEqual(museIdentityOfThread(`muse-agent:${identity}:a:b`), null);
});

it("keeps the existing account/provider identity encoding stable", () => {
  assert.equal(
    museThreadIdentity("a".repeat(64), "muse-native-test"),
    "e95e6ca23067134c5f3a6110b701f50bb658347838651b8a2954ba1fc3dcabd8",
  );
});
