import type { MuseConnectorRequest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { MuseAgentNativeEvent } from "./MuseAgentTransport.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Create native idempotency keys synchronously at the inbound frame boundary.
import * as NodeCrypto from "node:crypto";

const Text = Schema.String.check(Schema.isMaxLength(1024));
const Card = Schema.Struct({
  title: Text,
  type: Schema.Literal("credentials_vault"),
  data: Schema.Struct({
    capture: Schema.Literals(["sign_in", "verification_code"]),
    page_url: Schema.String.check(Schema.isMaxLength(8192)),
    capture_authorization: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16384))),
    username_label: Schema.optionalKey(Text),
    password_label: Schema.optionalKey(Text),
    verification_code_label: Schema.optionalKey(Text),
  }),
  state: Schema.optionalKey(
    Schema.Struct({
      data: Schema.optionalKey(
        Schema.Struct({ credential_capture_completed: Schema.optionalKey(Schema.Boolean) }),
      ),
    }),
  ),
});
const ConnectorCard = Schema.Struct({
  title: Text,
  type: Schema.Literal("connector"),
  data: Schema.Struct({
    connector_id: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1024),
      // eslint-disable-next-line no-control-regex -- Connector IDs are opaque, but must not contain controls.
      Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
    ),
  }),
});
// Native chat cards can still name the legacy skill alias instead of the catalog connector.
const connectorAliases = new Map([
  ["facebook_cli", "facebook"],
  ["messenger_read", "messenger"],
  ["stripe_link", "stripe-link"],
  ["whatsapp_companion", "whatsapp"],
]);
const decodeConnectorCard = Schema.decodeUnknownOption(ConnectorCard);
const Frame = Schema.Struct({
  session_id: Text,
  message_id: Schema.optionalKey(Text),
  presentation_id: Schema.optionalKey(Text),
  widget_id: Schema.optionalKey(Text),
  id: Schema.optionalKey(Text),
  kind: Schema.Literal("internal_link_action_card"),
  data: Schema.Unknown,
  stream_lane: Schema.optionalKey(Text),
  transcript_surface: Schema.optionalKey(Text),
});
const decodeFrame = Schema.decodeUnknownOption(Frame);
const decodeCard = Schema.decodeUnknownOption(Card);
export interface CredentialRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly pageUrl: string;
  readonly capture: "sign_in" | "verification_code";
  readonly usernameLabel: string;
  readonly passwordLabel: string;
  readonly codeLabel: string;
}
interface Entry {
  readonly idempotencyKey: string;
  readonly binding: string;
  readonly request: CredentialRequest;
  readonly targetUrl: string;
  readonly authorization?: string;
  state: "pending" | "submitting" | "completed";
}

/** Capture authorizations stay in this private inbox, never in orchestration or model context. */
export class MuseAgentCredentialInbox extends Context.Service<
  MuseAgentCredentialInbox,
  {
    readonly observe: (binding: string, frame: MuseAgentNativeEvent) => void;
    readonly pending: (binding: string, sessionId: string) => readonly CredentialRequest[];
    readonly pendingConnectors: (
      binding: string,
      sessionId: string,
    ) => readonly MuseConnectorRequest[];
    readonly completeConnector: (binding: string, connectorId: string) => void;
    readonly take: (
      binding: string,
      sessionId: string,
      requestId: string,
    ) => {
      readonly request: CredentialRequest;
      readonly authorization?: string;
      readonly idempotencyKey: string;
      /** Restore only when capture was definitely not dispatched. */
      readonly restore: () => void;
    } | null;
    readonly complete: (binding: string, sessionId: string, requestId: string) => void;
  }
>()("t3/museAgent/MuseAgentCredentialInbox") {}

export const layer = Layer.sync(MuseAgentCredentialInbox, () => {
  const entries = new Map<string, Entry>();
  const connectorEntries = new Map<
    string,
    {
      readonly binding: string;
      readonly request: MuseConnectorRequest;
      state: "pending" | "completed";
    }
  >();
  const reserveVaultSlot = () => {
    if (entries.size < 128) return true;
    const completed = [...entries].find(([, entry]) => entry.state === "completed");
    if (!completed) return false;
    entries.delete(completed[0]);
    return true;
  };
  const reserveConnectorSlot = () => {
    if (connectorEntries.size < 128) return;
    const evicted =
      [...connectorEntries].find(([, entry]) => entry.state === "completed") ??
      connectorEntries.entries().next().value;
    if (evicted) connectorEntries.delete(evicted[0]);
  };
  const key = (binding: string, sessionId: string, requestId: string) =>
    JSON.stringify([binding, sessionId, requestId]);
  return MuseAgentCredentialInbox.of({
    observe: (binding, event) => {
      if (event.event !== "delta.presentation") return;
      const frame = decodeFrame(event.payload);
      if (frame._tag === "None" || frame.value.stream_lane === "subagent") return;
      if (
        frame.value.transcript_surface !== undefined &&
        frame.value.transcript_surface !== "main_chat"
      )
        return;
      const requestId =
        frame.value.presentation_id ??
        frame.value.widget_id ??
        frame.value.id ??
        frame.value.message_id;
      if (!requestId || !frame.value.session_id) return;
      let data = frame.value.data;
      if (typeof data === "string") {
        if (data.length > 32768) return;
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      const connector = decodeConnectorCard(data);
      if (connector._tag === "Some") {
        const id = key(binding, frame.value.session_id, requestId);
        const connectorId =
          connectorAliases.get(connector.value.data.connector_id) ??
          connector.value.data.connector_id;
        if (
          connectorEntries.has(id) ||
          [...connectorEntries.values()].some(
            (entry) =>
              entry.state === "pending" &&
              entry.binding === binding &&
              entry.request.sessionId === frame.value.session_id &&
              entry.request.connectorId === connectorId,
          )
        )
          return;
        reserveConnectorSlot();
        connectorEntries.set(id, {
          binding,
          request: {
            requestId,
            sessionId: frame.value.session_id,
            title: connector.value.title,
            connectorId,
          },
          state: "pending",
        });
        return;
      }
      const decoded = decodeCard(data);
      if (decoded._tag === "None") return;
      const card = decoded.value;
      let pageUrl: URL;
      try {
        pageUrl = new URL(card.data.page_url);
      } catch {
        return;
      }
      if (pageUrl.protocol !== "https:" || pageUrl.username || pageUrl.password) return;
      const id = key(binding, frame.value.session_id, requestId);
      const current = entries.get(id);
      if (card.state?.data?.credential_capture_completed === true) {
        if (current) current.state = "completed";
        return;
      }
      if (current) return;
      if (!reserveVaultSlot()) return;
      entries.set(id, {
        idempotencyKey: NodeCrypto.randomUUID(),
        binding,
        targetUrl: pageUrl.href,
        request: {
          requestId,
          sessionId: frame.value.session_id,
          title: card.title,
          pageUrl: pageUrl.origin,
          capture: card.data.capture,
          usernameLabel: card.data.username_label ?? "Username",
          passwordLabel: card.data.password_label ?? "Password",
          codeLabel: card.data.verification_code_label ?? "Verification code",
        },
        ...(card.data.capture_authorization === undefined
          ? {}
          : { authorization: card.data.capture_authorization }),
        state: "pending",
      });
      // Keep the native full target only in the private entry; the public prompt shows its origin.
    },
    pending: (binding, sessionId) =>
      [...entries.values()]
        .filter(
          (entry) =>
            entry.binding === binding &&
            entry.request.sessionId === sessionId &&
            entry.state === "pending",
        )
        .map((entry) => entry.request),
    pendingConnectors: (binding, sessionId) =>
      [...connectorEntries.values()]
        .filter(
          (entry) =>
            entry.binding === binding &&
            entry.request.sessionId === sessionId &&
            entry.state === "pending",
        )
        .map((entry) => entry.request),
    completeConnector: (binding, connectorId) => {
      for (const entry of connectorEntries.values())
        if (entry.binding === binding && entry.request.connectorId === connectorId)
          entry.state = "completed";
    },
    take: (binding, sessionId, requestId) => {
      const entry = entries.get(key(binding, sessionId, requestId));
      if (!entry || entry.state !== "pending") return null;
      entry.state = "submitting";
      let restorable = true;
      return {
        restore: () => {
          if (!restorable) return;
          restorable = false;
          if (entry.state === "submitting") entry.state = "pending";
        },
        idempotencyKey: entry.idempotencyKey,
        request: { ...entry.request, pageUrl: entry.targetUrl },
        ...(entry.authorization === undefined ? {} : { authorization: entry.authorization }),
      };
    },
    complete: (binding, sessionId, requestId) => {
      const entry = entries.get(key(binding, sessionId, requestId));
      if (entry) entry.state = "completed";
      const connector = connectorEntries.get(key(binding, sessionId, requestId));
      if (connector) connector.state = "completed";
    },
  });
});
