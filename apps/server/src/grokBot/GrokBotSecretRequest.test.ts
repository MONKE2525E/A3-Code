import { assert, it } from "@effect/vitest";
import { decodeGrokBotSecretRequest, secretRequestsIn } from "./GrokBotSecretRequest.ts";

const entry = (overrides: Record<string, unknown> = {}, request: Record<string, unknown> = {}) => ({
  id: "e1",
  kind: "send-message",
  message: {
    type: "secret-request",
    secretRequest: {
      label: "OpenAI API key",
      description: "Used to call the API",
      target: { kind: "box-env", name: "OPENAI_API_KEY", platform: "box", field: "OPENAI_API_KEY" },
      ...request,
    },
  },
  ...overrides,
});

it("exposes only id, title, description and state", () => {
  const request = decodeGrokBotSecretRequest(entry());
  assert.deepStrictEqual(request, {
    entryId: "e1",
    title: "OpenAI API key",
    description: "Used to call the API",
    state: "pending",
  });
  assert.notInclude(JSON.stringify(request), "OPENAI_API_KEY");
});

it("treats only native's secretProvided marker as responded", () => {
  assert.strictEqual(
    decodeGrokBotSecretRequest(entry({ secretProvided: true }))?.state,
    "responded",
  );
  // Widget-only markers never apply to a secure input.
  for (const marker of [{ respondedValue: "x" }, { widgetDismissed: true }]) {
    assert.strictEqual(decodeGrokBotSecretRequest(entry(marker))?.state, "pending");
  }
});

it("ignores other cards and malformed secret requests", () => {
  assert.isUndefined(decodeGrokBotSecretRequest({ ...entry(), kind: "event" }));
  assert.isUndefined(decodeGrokBotSecretRequest(entry({}, { label: "  " })));
  assert.isUndefined(decodeGrokBotSecretRequest(entry({}, { target: "env" })));
  assert.isUndefined(decodeGrokBotSecretRequest(entry({ id: "" })));
  assert.deepStrictEqual(
    secretRequestsIn([{ id: "t", kind: "send-message", message: { type: "text" } }, entry()]).map(
      (request) => request.entryId,
    ),
    ["e1"],
  );
});
