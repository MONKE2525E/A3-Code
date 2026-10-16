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

const connectorCard = {
  title: "Example connector",
  type: "connector",
  data: { connector_id: "example", url: "https://example.test/private?authorization=synthetic" },
};
it.effect(
  "recovers native connector cards without exposing their URLs or accepting vault submissions",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MuseAgentCredentialInbox;
      inbox.observe("account-one", frame(connectorCard));
      const pending = inbox.pendingConnectors("account-one", "session-one");
      expect(pending).toEqual([
        {
          requestId: "credential-card",
          sessionId: "session-one",
          title: "Example connector",
          connectorId: "example",
        },
      ]);
      expect(JSON.stringify(pending)).not.toContain("authorization");
      expect(inbox.pendingConnectors("account-two", "session-one")).toEqual([]);
      expect(inbox.pendingConnectors("account-one", "session-two")).toEqual([]);
      expect(inbox.pending("account-one", "session-one")).toEqual([]);
      expect(inbox.take("account-one", "session-one", "credential-card")).toBeNull();
      inbox.observe("account-one", frame(connectorCard));
      expect(inbox.pendingConnectors("account-one", "session-one")).toHaveLength(1);
      inbox.completeConnector("account-two", "example");
      expect(inbox.pendingConnectors("account-one", "session-one")).toHaveLength(1);
      inbox.completeConnector("account-one", "example");
      inbox.observe("account-one", frame(connectorCard));
      expect(inbox.pendingConnectors("account-one", "session-one")).toEqual([]);
    }).pipe(Effect.provide(Inbox.layer)),
);
it.effect("bounds connector cards and rejects malformed or hidden card identities", () =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.MuseAgentCredentialInbox;
    inbox.observe("account", frame(connectorCard, { stream_lane: "subagent" }));
    inbox.observe("account", frame(connectorCard, { transcript_surface: "tool" }));
    inbox.observe(
      "account",
      frame({ ...connectorCard, data: { connector_id: "bad\nidentifier" } }),
    );
    expect(inbox.pendingConnectors("account", "session-one")).toEqual([]);
    for (let i = 0; i < 140; i++)
      inbox.observe(
        "account",
        frame(
          { ...connectorCard, data: { connector_id: `connector-${i}` } },
          { presentation_id: `connector-${i}` },
        ),
      );
    expect(inbox.pendingConnectors("account", "session-one")).toHaveLength(128);
    inbox.complete("account", "session-one", "connector-139");
    inbox.observe("account", frame(card, { presentation_id: "vault-after-connector" }));
    expect(inbox.pendingConnectors("account", "session-one")).toHaveLength(127);
    expect(inbox.pending("account", "session-one")).toHaveLength(1);
  }).pipe(Effect.provide(Inbox.layer)),
);

it.effect.each([
  { alias: "facebook_cli", canonical: "facebook" },
  { alias: "messenger_read", canonical: "messenger" },
  { alias: "stripe_link", canonical: "stripe-link" },
  { alias: "whatsapp_companion", canonical: "whatsapp" },
])("resolves the native connector card alias $alias", ({ alias, canonical }) =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.MuseAgentCredentialInbox;
    inbox.observe("account", frame({ ...connectorCard, data: { connector_id: alias } }));
    expect(inbox.pendingConnectors("account", "session-one")[0]?.connectorId).toBe(canonical);
  }).pipe(Effect.provide(Inbox.layer)),
);

it.effect("connector saturation and repeated cards cannot hide vault prompts", () =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.MuseAgentCredentialInbox;
    for (let i = 0; i < 128; i++)
      inbox.observe(
        "old-account",
        frame(
          { ...connectorCard, data: { connector_id: `connector-${i}` } },
          { presentation_id: `card-${i}` },
        ),
      );
    inbox.observe("account", frame(card));
    expect(inbox.pending("account", "session-one")).toHaveLength(1);
    for (let i = 0; i < 140; i++)
      inbox.observe("account", frame(connectorCard, { presentation_id: `repeated-${i}` }));
    expect(inbox.pendingConnectors("account", "session-one")).toHaveLength(1);
    expect(inbox.pending("account", "session-one")).toHaveLength(1);
  }).pipe(Effect.provide(Inbox.layer)),
);
