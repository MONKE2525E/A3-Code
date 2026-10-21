// @effect-diagnostics-next-line nodeBuiltinImport:off -- Request hashes are computed synchronously inside the SQLite transaction.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The native SQLite acquisition boundary creates its private directory before opening the database.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The native database acquisition boundary resolves its Node path before opening it.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  MuseAgentDeliveryContext,
  MuseAgentManagedMessageSnapshot,
  type MuseAgentDeliveryScope,
  type MuseAgentHistoryOwnership,
  type MuseAgentHistoryOwnershipScope,
  type MuseAgentPendingDelivery,
} from "./MuseAgentDeliveryOwnership.ts";

export class MuseAgentDeliveryError extends Schema.TaggedError<MuseAgentDeliveryError>()(
  "MuseAgentDeliveryError",
  {
    kind: Schema.Literals(["storage", "conflict", "uncertain", "busy"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    if (this.kind === "uncertain")
      return "Muse delivery is uncertain. Check the native conversation before starting another turn.";
    if (this.kind === "busy") return "This Muse account already has an unsettled managed turn.";
    if (this.kind === "conflict") return "This Muse delivery identity belongs to another request.";
    return "Muse delivery state could not be saved. No message was retried.";
  }
}

export const MuseAgentReceipt = Schema.Struct({
  messageId: Schema.String,
  replyToMessageId: Schema.String,
  sessionId: Schema.String,
});
export type MuseAgentReceipt = typeof MuseAgentReceipt.Type;
const DeliveryRow = Schema.Struct({
  delivery_key: Schema.String,
  binding: Schema.String,
  session_id: Schema.String,
  request_hash: Schema.String,
  status: Schema.Literals(["intent", "accepted", "terminal", "released"]),
  receipt_json: Schema.NullOr(Schema.String),
  ownership_json: Schema.NullOr(Schema.String),
});

const decodeRow = Schema.decodeUnknownSync(DeliveryRow);
const decodeReceipt = Schema.decodeUnknownSync(MuseAgentReceipt);
const decodeContext = Schema.decodeUnknownSync(Schema.fromJsonString(MuseAgentDeliveryContext));
const encodeContext = Schema.encodeSync(Schema.fromJsonString(MuseAgentDeliveryContext));
const decodeSnapshot = Schema.decodeUnknownSync(
  Schema.fromJsonString(MuseAgentManagedMessageSnapshot),
);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(MuseAgentManagedMessageSnapshot));
const isDeliveryError = Schema.is(MuseAgentDeliveryError);

export class MuseAgentDeliveryStore extends Context.Service<
  MuseAgentDeliveryStore,
  {
    readonly assertTurnAvailable: (
      scope: MuseAgentDeliveryScope,
    ) => Effect.Effect<void, MuseAgentDeliveryError>;
    /** null means newly persisted intent; existing accepted receipts are returned without resending. */
    readonly begin: (input: {
      readonly binding: string;
      readonly sessionId: string;
      readonly deliveryKey: string;
      readonly text: string;
      readonly attachmentIdentity?: string;
      readonly context?: MuseAgentDeliveryContext;
    }) => Effect.Effect<MuseAgentReceipt | null, MuseAgentDeliveryError>;
    readonly accept: (
      deliveryKey: string,
      receipt: MuseAgentReceipt,
    ) => Effect.Effect<void, MuseAgentDeliveryError>;
    readonly settle: (deliveryKey: string) => Effect.Effect<void, MuseAgentDeliveryError>;
    /** Called only when the owner proves chat admission was never attempted. */
    readonly abandonBeforePrompt: (
      deliveryKey: string,
    ) => Effect.Effect<void, MuseAgentDeliveryError>;
    readonly receipt: (
      deliveryKey: string,
      scope?: MuseAgentDeliveryScope,
    ) => Effect.Effect<MuseAgentReceipt | null, MuseAgentDeliveryError>;
    readonly historyOwnership: (
      scope: MuseAgentHistoryOwnershipScope,
      options?: { readonly receiptsOnly?: boolean; readonly nativeMessageId?: string },
    ) => Effect.Effect<MuseAgentHistoryOwnership, MuseAgentDeliveryError>;
    readonly recordManagedMessage: (
      input: MuseAgentDeliveryScope & {
        readonly deliveryKey: string;
        readonly nativeMessageId: string;
        readonly snapshot: MuseAgentManagedMessageSnapshot;
      },
    ) => Effect.Effect<void, MuseAgentDeliveryError>;
    readonly pendingDeliveries: (
      scope: MuseAgentDeliveryScope,
    ) => Effect.Effect<readonly MuseAgentPendingDelivery[], MuseAgentDeliveryError>;
    /** Releases only local ownership. The retained tombstone forbids reuse of this delivery key. */
    readonly releaseLocalOwnership: (
      input: MuseAgentDeliveryScope & { readonly deliveryKey: string },
    ) => Effect.Effect<void, MuseAgentDeliveryError>;
  }
>()("t3/museAgent/MuseAgentDeliveryStore") {}

export const makeMuseAgentDeliveryStore = (
  db: NodeSqlite.DatabaseSync,
): MuseAgentDeliveryStore["Service"] => {
  db.exec(`CREATE TABLE IF NOT EXISTS muse_deliveries (
    delivery_key TEXT PRIMARY KEY, binding TEXT NOT NULL, session_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, status TEXT NOT NULL, receipt_json TEXT, ownership_json TEXT
  ); CREATE INDEX IF NOT EXISTS muse_delivery_session ON muse_deliveries(binding, session_id, status);
  CREATE TABLE IF NOT EXISTS muse_managed_messages (
    binding TEXT NOT NULL, session_id TEXT NOT NULL, native_message_id TEXT NOT NULL,
    delivery_key TEXT NOT NULL, snapshot_json TEXT, PRIMARY KEY(binding, session_id, native_message_id)
  );`);
  if (
    !db
      .prepare("PRAGMA table_info(muse_deliveries)")
      .all()
      .some((column) => column.name === "ownership_json")
  )
    db.exec("ALTER TABLE muse_deliveries ADD COLUMN ownership_json TEXT");
  if (
    !db
      .prepare("PRAGMA table_info(muse_managed_messages)")
      .all()
      .some((column) => column.name === "snapshot_json")
  )
    db.exec("ALTER TABLE muse_managed_messages ADD COLUMN snapshot_json TEXT");
  const operation = <A>(run: () => A) =>
    Effect.try({
      try: run,
      catch: (cause) =>
        isDeliveryError(cause) ? cause : new MuseAgentDeliveryError({ kind: "storage", cause }),
    });
  const find = (key: string) => {
    const row = db.prepare("SELECT * FROM muse_deliveries WHERE delivery_key = ?").get(key);
    return row ? decodeRow(row) : undefined;
  };
  const assertTurnAvailable = (scope: MuseAgentDeliveryScope) => {
    if (
      db
        .prepare(
          "SELECT 1 FROM muse_deliveries WHERE binding = ? AND session_id != ? AND status IN ('intent', 'accepted') LIMIT 1",
        )
        .get(scope.binding, scope.sessionId)
    )
      throw new MuseAgentDeliveryError({ kind: "busy" });
  };
  return MuseAgentDeliveryStore.of({
    assertTurnAvailable: (scope) => operation(() => assertTurnAvailable(scope)),
    begin: (input) =>
      operation(() => {
        const requestHash = NodeCrypto.createHash("sha256")
          .update(
            JSON.stringify([
              input.binding,
              input.sessionId,
              input.text,
              ...(input.attachmentIdentity ? [input.attachmentIdentity] : []),
            ]),
          )
          .digest("hex");
        db.exec("BEGIN IMMEDIATE");
        try {
          assertTurnAvailable(input);
          const prior = find(input.deliveryKey);
          if (prior) {
            if (
              prior.binding !== input.binding ||
              prior.session_id !== input.sessionId ||
              prior.request_hash !== requestHash
            )
              throw new MuseAgentDeliveryError({ kind: "conflict" });
            if (prior.status === "released")
              throw new MuseAgentDeliveryError({ kind: "uncertain" });
            if ((input.context ? encodeContext(input.context) : null) !== prior.ownership_json)
              throw new MuseAgentDeliveryError({ kind: "conflict" });
            if (!prior.receipt_json) throw new MuseAgentDeliveryError({ kind: "uncertain" });
            const receipt = decodeReceipt(JSON.parse(prior.receipt_json));
            db.exec("COMMIT");
            return receipt;
          }
          if (
            db
              .prepare(
                "SELECT 1 FROM muse_deliveries WHERE binding = ? AND session_id = ? AND status IN ('intent', 'accepted') LIMIT 1",
              )
              .get(input.binding, input.sessionId)
          )
            throw new MuseAgentDeliveryError({ kind: "busy" });
          db.prepare(
            "INSERT INTO muse_deliveries (delivery_key,binding,session_id,request_hash,status,receipt_json,ownership_json) VALUES (?, ?, ?, ?, 'intent', NULL, ?)",
          ).run(
            input.deliveryKey,
            input.binding,
            input.sessionId,
            requestHash,
            input.context ? encodeContext(input.context) : null,
          );
          db.exec("COMMIT");
          return null;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
    accept: (deliveryKey, receipt) =>
      operation(() => {
        const row = find(deliveryKey);
        if (!row || row.session_id !== receipt.sessionId)
          throw new MuseAgentDeliveryError({ kind: "conflict" });
        const encoded = JSON.stringify(receipt);
        if (row.receipt_json && row.receipt_json !== encoded)
          throw new MuseAgentDeliveryError({ kind: "conflict" });
        db.prepare(
          "UPDATE muse_deliveries SET receipt_json = ?, status = CASE WHEN status IN ('terminal', 'released') THEN status ELSE 'accepted' END WHERE delivery_key = ?",
        ).run(encoded, deliveryKey);
      }),
    settle: (deliveryKey) =>
      operation(() => {
        const row = find(deliveryKey);
        if (!row?.receipt_json) throw new MuseAgentDeliveryError({ kind: "uncertain" });
        db.prepare(
          "UPDATE muse_deliveries SET status = 'terminal' WHERE delivery_key = ? AND status != 'released'",
        ).run(deliveryKey);
      }),
    abandonBeforePrompt: (deliveryKey) =>
      operation(() => {
        db.prepare(
          "DELETE FROM muse_deliveries WHERE delivery_key = ? AND status = 'intent' AND receipt_json IS NULL",
        ).run(deliveryKey);
      }),
    receipt: (deliveryKey, scope) =>
      operation(() => {
        const row = find(deliveryKey);
        if (scope && (!row || row.binding !== scope.binding || row.session_id !== scope.sessionId))
          throw new MuseAgentDeliveryError({ kind: "conflict" });
        return row?.receipt_json ? decodeReceipt(JSON.parse(row.receipt_json)) : null;
      }),
    historyOwnership: (scope, options) =>
      operation(() => {
        const rows = db
          .prepare(
            "SELECT * FROM muse_deliveries WHERE binding=? AND session_id=? AND ownership_json IS NOT NULL",
          )
          .all(scope.binding, scope.sessionId)
          .map((row) => decodeRow(row));
        const contexts = new Map<string, MuseAgentDeliveryContext>();
        const receipts: MuseAgentHistoryOwnership["receipts"][number][] = [];
        for (const row of rows) {
          const context = decodeContext(row.ownership_json!);
          if (
            context.threadId !== scope.threadId ||
            context.providerInstanceId !== scope.providerInstanceId
          )
            continue;
          contexts.set(row.delivery_key, context);
          if (row.receipt_json) {
            const receipt = decodeReceipt(JSON.parse(row.receipt_json));
            receipts.push({
              messageId: receipt.messageId,
              replyToMessageId: receipt.replyToMessageId,
              context,
            });
          }
        }
        const messages: MuseAgentHistoryOwnership["messages"][number][] = [];
        if (options?.receiptsOnly) return { receipts, messages };
        const associationQuery =
          "SELECT native_message_id,delivery_key,snapshot_json FROM muse_managed_messages WHERE binding=? AND session_id=? AND snapshot_json IS NOT NULL";
        const associations =
          options?.nativeMessageId === undefined
            ? db.prepare(associationQuery).all(scope.binding, scope.sessionId)
            : db
                .prepare(`${associationQuery} AND native_message_id=?`)
                .all(scope.binding, scope.sessionId, options.nativeMessageId);
        for (const row of associations) {
          const context = contexts.get(String(row.delivery_key));
          if (context)
            messages.push({
              nativeMessageId: String(row.native_message_id),
              deliveryKey: String(row.delivery_key),
              context,
              snapshot: decodeSnapshot(String(row.snapshot_json)),
              frozen:
                rows.find((delivery) => delivery.delivery_key === row.delivery_key)?.status !==
                "accepted",
            });
        }
        return { receipts, messages };
      }),
    recordManagedMessage: (input) =>
      operation(() => {
        const row = find(input.deliveryKey);
        if (
          !row ||
          row.binding !== input.binding ||
          row.session_id !== input.sessionId ||
          !row.receipt_json ||
          !row.ownership_json ||
          !input.nativeMessageId ||
          input.nativeMessageId.length > 1024
        )
          throw new MuseAgentDeliveryError({ kind: "conflict" });
        const context = decodeContext(row.ownership_json);
        const { message, turnItem } = input.snapshot;
        if (
          message.role !== "assistant" ||
          turnItem.type !== "assistant_message" ||
          message.threadId !== context.threadId ||
          message.runId !== context.runId ||
          message.nodeId !== context.nodeId ||
          turnItem.threadId !== context.threadId ||
          turnItem.runId !== context.runId ||
          turnItem.nodeId !== context.nodeId ||
          turnItem.providerThreadId !== context.providerThreadId ||
          turnItem.providerTurnId !== context.providerTurnId ||
          turnItem.nativeItemRef?.driver !== "muse-agent" ||
          turnItem.nativeItemRef.nativeId !== input.nativeMessageId ||
          turnItem.messageId !== message.id ||
          turnItem.text !== message.text ||
          turnItem.streaming !== message.streaming ||
          JSON.stringify(turnItem.attachments) !== JSON.stringify(message.attachments)
        )
          throw new MuseAgentDeliveryError({ kind: "conflict" });
        const prior = db
          .prepare(
            "SELECT delivery_key,snapshot_json FROM muse_managed_messages WHERE binding=? AND session_id=? AND native_message_id=?",
          )
          .get(input.binding, input.sessionId, input.nativeMessageId);
        if (prior && prior.delivery_key !== input.deliveryKey)
          throw new MuseAgentDeliveryError({ kind: "conflict" });
        if (prior?.snapshot_json) {
          const previous = decodeSnapshot(String(prior.snapshot_json));
          if (!previous.message.streaming && message.streaming) return;
          // Trusted file imports can finish after execution. Preserve owned text while
          // adding persisted attachments; later native redirections cannot replace it.
          if (row.status === "terminal" || row.status === "released") {
            if (
              message.text !== previous.message.text ||
              message.streaming ||
              !previous.message.attachments.every((attachment) =>
                message.attachments.some(
                  (next) => JSON.stringify(next) === JSON.stringify(attachment),
                ),
              )
            )
              return;
          }
        }
        db.prepare(
          "INSERT INTO muse_managed_messages (binding,session_id,native_message_id,delivery_key,snapshot_json) VALUES(?,?,?,?,?) ON CONFLICT(binding,session_id,native_message_id) DO UPDATE SET snapshot_json=excluded.snapshot_json",
        ).run(
          input.binding,
          input.sessionId,
          input.nativeMessageId,
          input.deliveryKey,
          encodeSnapshot(input.snapshot),
        );
      }),
    pendingDeliveries: (scope) =>
      operation(() =>
        db
          .prepare(
            "SELECT * FROM muse_deliveries WHERE binding=? AND session_id=? AND status IN ('intent','accepted') ORDER BY rowid",
          )
          .all(scope.binding, scope.sessionId)
          .map((raw) => {
            const row = decodeRow(raw);
            if (row.status !== "intent" && row.status !== "accepted")
              throw new MuseAgentDeliveryError({ kind: "storage" });
            return {
              deliveryKey: row.delivery_key,
              status: row.status,
              context: row.ownership_json ? decodeContext(row.ownership_json) : null,
            };
          }),
      ),
    releaseLocalOwnership: (input) =>
      operation(() => {
        const row = find(input.deliveryKey);
        if (!row || row.binding !== input.binding || row.session_id !== input.sessionId)
          throw new MuseAgentDeliveryError({ kind: "conflict" });
        db.prepare(
          "UPDATE muse_deliveries SET status='released' WHERE delivery_key=? AND status IN ('intent','accepted')",
        ).run(input.deliveryKey);
      }),
  });
};

export const layer = Layer.effect(
  MuseAgentDeliveryStore,
  Effect.gen(function* () {
    const host = yield* ProviderHost.ProviderHost;
    const db = yield* Effect.tryPromise({
      try: async () => {
        const directory = NodePath.join(host.paths.stateDir, "integrations/muse-agent");
        await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
        const file = NodePath.join(directory, "deliveries.sqlite");
        const database = new NodeSqlite.DatabaseSync(file);
        try {
          await NodeFSP.chmod(file, 0o600);
          return database;
        } catch (error) {
          database.close();
          throw error;
        }
      },
      catch: (cause) => new MuseAgentDeliveryError({ kind: "storage", cause }),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
    return yield* Effect.try({
      try: () => makeMuseAgentDeliveryStore(db),
      catch: (cause) => new MuseAgentDeliveryError({ kind: "storage", cause }),
    });
  }),
);
