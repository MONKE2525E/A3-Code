import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Inbox from "./MuseAgentCredentialInbox.ts";

const card = {
  title: "Sign in to Example",
  type: "credentials_vault",
  data: {
    capture: "sign_in",
    page_url: "https://example.test/login?private=target",
    capture_authorization: "synthetic-private-authorization",
  },
};
const frame = (data: unknown = card, extra = {}) => ({
  event: "delta.presentation",
  payload: {
    session_id: "session-one",
    message_id: "host-message",
    presentation_id: "credential-card",
    kind: "internal_link_action_card",
    data,
    ...extra,
  },
});

it.effect(
  "keeps authorizations private and binds a one-time submission to its account and session",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MuseAgentCredentialInbox;
      inbox.observe("account-one", frame(JSON.stringify(card)));
      const pending = inbox.pending("account-one", "session-one");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        requestId: "credential-card",
        pageUrl: "https://example.test",
      });
      expect(JSON.stringify(pending)).not.toContain("synthetic-private-authorization");
      expect(JSON.stringify(pending)).not.toContain("private=target");
      expect(inbox.take("account-two", "session-one", "credential-card")).toBeNull();
      expect(inbox.take("account-one", "session-two", "credential-card")).toBeNull();
      const submission = inbox.take("account-one", "session-one", "credential-card");
      expect(submission?.authorization).toBe("synthetic-private-authorization");
      expect(submission?.request.pageUrl).toBe(card.data.page_url);
      expect(submission?.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
      expect(inbox.take("account-one", "session-one", "credential-card")).toBeNull();
      inbox.observe("account-one", frame());
      expect(inbox.pending("account-one", "session-one")).toEqual([]);
    }).pipe(Effect.provide(Inbox.layer)),
);

it.effect("rejects untrusted targets, subagent cards, malformed cards and completed prompts", () =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.MuseAgentCredentialInbox;
    inbox.observe("account", frame(card, { stream_lane: "subagent" }));
    inbox.observe("account", frame(card, { transcript_surface: "tool" }));
    inbox.observe("account", frame("{invalid"));
    inbox.observe(
      "account",
      frame({ ...card, data: { ...card.data, page_url: "http://example.test" } }),
    );
    inbox.observe(
      "account",
      frame({ ...card, data: { ...card.data, page_url: "https://user:pass@example.test" } }),
    );
    expect(inbox.pending("account", "session-one")).toEqual([]);
    inbox.observe("account", frame());
    inbox.observe(
      "account",
      frame({ ...card, state: { data: { credential_capture_completed: true } } }),
    );
    expect(inbox.pending("account", "session-one")).toEqual([]);
  }).pipe(Effect.provide(Inbox.layer)),
);
