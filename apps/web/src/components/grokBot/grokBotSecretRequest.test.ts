import {
  EnvironmentId,
  GrokBotSecretError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forgetRespondedGrokBotSecretRequests,
  GROK_BOT_HIDDEN_SECRET_REQUESTS_MAX,
  grokBotPendingSecretRequests,
  grokBotSecretChatTarget,
  grokBotSecretDismissFailureMessage,
  grokBotSecretDismissIsUnsupported,
  grokBotSecretFailureEndsRequest,
  grokBotSecretFailureMessage,
  grokBotSecretRequestKey,
  grokBotSecretSubmitInput,
  hideGrokBotSecretRequest,
  isGrokBotSecretRequestSettled,
  markGrokBotSecretRequestSettled,
  useHiddenGrokBotSecretRequests,
  type GrokBotSecretRequestItem,
} from "./grokBotSecretRequest";

const request: GrokBotSecretRequestItem = {
  entryId: "entry-1",
  sessionId: "",
  title: "GitHub token",
  state: "pending",
};

describe("grokBotPendingSecretRequests", () => {
  it("keeps only requests the native side has not answered", () => {
    const answered = { ...request, entryId: "entry-2", state: "responded" as const };

    expect(grokBotPendingSecretRequests([request, answered])).toEqual([request]);
  });

  it("lists a repeated entry once, so one request never stacks two forms", () => {
    expect(grokBotPendingSecretRequests([request, { ...request }])).toEqual([request]);
  });
});

describe("settled secret requests", () => {
  const target = { environmentId: EnvironmentId.make("env-9"), botId: "bot-9" };

  it("keys a request by environment, bot and entry, so a same entry id elsewhere is unaffected", () => {
    const key = grokBotSecretRequestKey(target, request);
    markGrokBotSecretRequestSettled(key);

    expect(isGrokBotSecretRequestSettled(key)).toBe(true);
    expect(
      isGrokBotSecretRequestSettled(
        grokBotSecretRequestKey({ ...target, botId: "other-bot" }, request),
      ),
    ).toBe(false);
  });

  it("forgets a settled key only once native reports that request responded", () => {
    const key = grokBotSecretRequestKey(target, { ...request, entryId: "entry-forget" });
    markGrokBotSecretRequestSettled(key);

    forgetRespondedGrokBotSecretRequests(target, [
      { ...request, entryId: "entry-forget", state: "pending" },
    ]);
    expect(isGrokBotSecretRequestSettled(key)).toBe(true);

    forgetRespondedGrokBotSecretRequests(target, [
      { ...request, entryId: "entry-forget", state: "responded" },
    ]);
    expect(isGrokBotSecretRequestSettled(key)).toBe(false);
  });
});

describe("grokBotSecretFailureEndsRequest", () => {
  it("ends the request only when native says it is no longer asked or already answered", () => {
    expect(
      grokBotSecretFailureEndsRequest(new GrokBotSecretError({ reason: "already_answered" })),
    ).toBe(true);
    expect(
      grokBotSecretFailureEndsRequest(new GrokBotSecretError({ reason: "request_not_found" })),
    ).toBe(true);
  });

  it("keeps a genuine refusal or delivery failure retryable", () => {
    expect(grokBotSecretFailureEndsRequest(new GrokBotSecretError({ reason: "refused" }))).toBe(
      false,
    );
    expect(grokBotSecretFailureEndsRequest(new GrokBotSecretError({ reason: "unavailable" }))).toBe(
      false,
    );
    expect(grokBotSecretFailureEndsRequest(new Error("network"))).toBe(false);
  });
});

describe("grokBotSecretDismissIsUnsupported", () => {
  it("is true only for the unsupported reason, so refusals keep their retry and fallback", () => {
    expect(
      grokBotSecretDismissIsUnsupported(new GrokBotSecretError({ reason: "unsupported" })),
    ).toBe(true);
    expect(grokBotSecretDismissIsUnsupported(new GrokBotSecretError({ reason: "refused" }))).toBe(
      false,
    );
    expect(grokBotSecretDismissIsUnsupported(new Error("unsupported"))).toBe(false);
  });
});

describe("grokBotSecretSubmitInput", () => {
  it("builds the payload from the request's own session and entry, with the value trimmed", () => {
    expect(grokBotSecretSubmitInput(request, "bot-1", "  s3cret \n")).toEqual({
      botId: "bot-1",
      sessionId: "",
      entryId: "entry-1",
      value: "s3cret",
    });
  });

  it("returns no payload for a blank value, so Save stays unavailable", () => {
    expect(grokBotSecretSubmitInput(request, "bot-1", "   ")).toBeNull();
  });
});

describe("grokBotSecretFailureMessage", () => {
  it("passes through the server's GrokBotSecretError copy", () => {
    const error = new GrokBotSecretError({ reason: "already_answered" });

    expect(grokBotSecretFailureMessage(error)).toBe(error.message);
  });

  it("gives unknown failures generic copy", () => {
    expect(grokBotSecretFailureMessage(new Error("boom"))).toBe(
      "Could not send the secure input. Try again.",
    );
  });
});

describe("grokBotSecretChatTarget", () => {
  const environmentId = EnvironmentId.make("env-1");
  const botThread = {
    environmentId,
    id: ThreadId.make("grok-bot:abc123"),
    modelSelection: { instanceId: ProviderInstanceId.make("grok-bot"), model: "bot-1" },
  };
  const ready = { canOperate: true, loading: false };

  it("targets the bot of a canonical bot thread in the thread's own environment", () => {
    expect(grokBotSecretChatTarget({ thread: botThread, ...ready })).toEqual({
      environmentId,
      botId: "bot-1",
    });
  });

  it("never targets an ordinary thread, even one that uses the bot's model", () => {
    const ordinary = { ...botThread, id: ThreadId.make("thread-1") };

    expect(grokBotSecretChatTarget({ thread: ordinary, ...ready })).toBeNull();
  });

  it("stays off without an operate permission or while the thread is loading", () => {
    expect(grokBotSecretChatTarget({ thread: botThread, canOperate: false, loading: false })).toBe(
      null,
    );
    expect(grokBotSecretChatTarget({ thread: botThread, canOperate: true, loading: true })).toBe(
      null,
    );
  });

  it("returns null when no thread is selected", () => {
    expect(grokBotSecretChatTarget({ thread: null, ...ready })).toBeNull();
  });
});

describe("locally hidden secret requests", () => {
  const target = { environmentId: EnvironmentId.make("env-hide"), botId: "bot-hide" };
  const hiddenKeys = () => useHiddenGrokBotSecretRequests.getState().keys;

  it("keeps a hidden key until native reports that request responded", () => {
    const key = grokBotSecretRequestKey(target, { ...request, entryId: "entry-hide" });
    hideGrokBotSecretRequest(key);
    expect(hiddenKeys()).toContain(key);

    forgetRespondedGrokBotSecretRequests(target, [
      { ...request, entryId: "entry-hide", state: "pending" },
    ]);
    expect(hiddenKeys()).toContain(key);

    forgetRespondedGrokBotSecretRequests(target, [
      { ...request, entryId: "entry-hide", state: "responded" },
    ]);
    expect(hiddenKeys()).not.toContain(key);
  });

  it("caps the hidden list at the newest keys so cleanup stays bounded", () => {
    for (let index = 0; index < GROK_BOT_HIDDEN_SECRET_REQUESTS_MAX + 5; index += 1) {
      hideGrokBotSecretRequest(`cap-${index}`);
    }

    expect(hiddenKeys()).toHaveLength(GROK_BOT_HIDDEN_SECRET_REQUESTS_MAX);
    expect(hiddenKeys()).toContain(`cap-${GROK_BOT_HIDDEN_SECRET_REQUESTS_MAX + 4}`);
    expect(hiddenKeys()).not.toContain("cap-0");
  });
});

describe("grokBotSecretDismissFailureMessage", () => {
  it("names the dismissal and the local fallback, not a delivery failure", () => {
    const message = grokBotSecretDismissFailureMessage();

    expect(message).toContain("dismissal");
    expect(message).toContain("hide it on this device");
    expect(message).not.toContain("delivered");
  });
});
