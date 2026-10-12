import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import type { GrokBotBoundSession } from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import type { GrokBotTurnIdentity } from "../orchestration-v2/Adapters/GrokBotSettlementProjection.ts";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Native = Schema.Struct({
  binding: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  botId: NonEmpty,
  sessionId: Schema.String,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  afterUpdatedSeq: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)),
});
const Identity = Schema.Struct({
  native: Native,
  messageId: NonEmpty,
  sentAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runId: RunId,
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  providerThreadId: ProviderThreadId,
  providerTurnId: ProviderTurnId,
  runOrdinal: Schema.Int,
  providerTurnOrdinal: Schema.Int,
  managedSkill: Schema.optionalKey(
    Schema.Struct({
      skillId: NonEmpty,
      hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      changed: Schema.Boolean,
      workflowPath: Schema.optionalKey(NonEmpty),
      confirmed: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const decodeManagedMessageId = Schema.decodeUnknownEffect(Schema.Struct({ messageId: NonEmpty }));
const Stored = Schema.Struct({
  identity: Schema.fromJsonString(Identity),
  state: Schema.Literals(["prepared", "uncertain", "accepted", "settled"]),
  delivery: Schema.NullOr(Schema.Literals(["accepted", "duplicate"])),
  workflowId: Schema.NullOr(Schema.String),
  echoEntryId: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.Literals(["success", "error", "cancelled"])),
  settledAtMs: Schema.NullOr(Schema.Int),
});
export type StoredGrokBotTurn = typeof Stored.Type;

const Completion = Schema.Struct({
  identity: Schema.fromJsonString(Identity),
  source: Schema.Literal("agent_declaration"),
  finalText: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000000)),
  declaredAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
/** An explicit T3 final answer, never evidence of native workflow success or quiescence. */
export type GrokBotManagedCompletion = typeof Completion.Type;

export class ManagedStateConflict extends Schema.TaggedError<ManagedStateConflict>()(
  "GrokBotManagedStateConflict",
  {
    stage: Schema.Literals(["binding", "turn", "receipt", "cursor", "settlement", "completion"]),
  },
) {
  override get message() {
    return "The Grok Bot runtime state belongs to a different binding or turn.";
  }
}
type StoreError = PersistenceSqlError | PersistenceDecodeError | ManagedStateConflict;
const isConflict = Schema.is(ManagedStateConflict);
const isDecodeError = Schema.is(PersistenceDecodeError);
const isSqlError = Schema.is(PersistenceSqlError);
const decodeSettlementTime = Schema.decodeUnknownEffect(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
);

/** Durable identities, receipts, and final answers. Prompts, credentials, and config stay outside this store. */
export class GrokBotManagedStateStore extends Context.Service<
  GrokBotManagedStateStore,
  {
    readonly acquire: (
      native: GrokBotBoundSession,
    ) => Effect.Effect<GrokBotBoundSession, StoreError>;
    readonly get: (
      key: Pick<GrokBotBoundSession, "binding" | "botId" | "sessionId">,
    ) => Effect.Effect<GrokBotBoundSession | undefined, StoreError>;
    readonly prepareTurn: (
      identity: GrokBotTurnIdentity,
    ) => Effect.Effect<GrokBotTurnIdentity, StoreError>;
    readonly accepted: (input: {
      readonly identity: GrokBotTurnIdentity;
      readonly delivery: "accepted" | "duplicate";
      readonly workflowId?: string;
      readonly echoEntryId?: string;
    }) => Effect.Effect<void, StoreError>;
    readonly uncertain: (identity: GrokBotTurnIdentity) => Effect.Effect<void, StoreError>;
    readonly restoreTurns: (
      native: GrokBotBoundSession,
    ) => Effect.Effect<readonly GrokBotTurnIdentity[], StoreError>;
    readonly restoreTranscriptTurns: (
      native: GrokBotBoundSession,
    ) => Effect.Effect<readonly GrokBotTurnIdentity[], StoreError>;
    readonly restoreManagedMessageIds: (
      native: GrokBotBoundSession,
    ) => Effect.Effect<readonly string[], StoreError>;
    readonly lookupTranscriptTurn: (
      native: GrokBotBoundSession,
      messageId: string,
    ) => Effect.Effect<GrokBotTurnIdentity | undefined, StoreError>;
    readonly lookupTurn: (
      query: GrokBotTurnIdentity | { readonly runId: RunId; readonly attemptId: RunAttemptId },
    ) => Effect.Effect<StoredGrokBotTurn | undefined, StoreError>;
    /** Read the accepted immutable answer for this exact delivery, independently of observer scheduling. */
    readonly lookupCompletion: (
      identity: GrokBotTurnIdentity,
    ) => Effect.Effect<GrokBotManagedCompletion | undefined, StoreError>;
    readonly declareCompletion: (input: {
      readonly identity: GrokBotTurnIdentity;
      readonly finalText: string;
      readonly declaredAtMs: number;
      readonly managedSkillHash?: string;
    }) => Effect.Effect<GrokBotManagedCompletion, StoreError>;
    readonly hasConfirmedWorkflowSkill: (input: {
      readonly native: GrokBotBoundSession;
      readonly hash: string;
      readonly workflowPath: string;
    }) => Effect.Effect<boolean, StoreError>;
    /** Subscribe before reading durable pending declarations, so reconnect cannot miss a completion. */
    readonly openCompletionWatch: (
      native: GrokBotBoundSession,
    ) => Effect.Effect<Stream.Stream<GrokBotManagedCompletion>, StoreError, Scope.Scope>;
    /** Fold a committed V2 terminal projection into its exact durable native identity. */
    readonly projectSettlement: (input: {
      readonly threadId: ThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly attemptId: RunAttemptId;
      readonly rootNodeId: NodeId;
      readonly outcome: "success" | "error" | "cancelled";
      readonly settledAtMs: number;
    }) => Effect.Effect<void, StoreError>;
    /** Invoke in the projection transaction, after terminal events are persisted. */
    readonly commitSettlement: (input: {
      readonly identity: GrokBotTurnIdentity;
      readonly outcome: "success" | "error" | "cancelled";
      readonly settledAtMs: number;
    }) => Effect.Effect<void, StoreError>;
    /** Invoke in the projection transaction. Receiving/yielding a frame is not a committed cursor. */
    readonly commitCursor: (native: GrokBotBoundSession) => Effect.Effect<void, StoreError>;
  }
>()("t3/grokBot/GrokBotManagedStateStore") {}

const sameOwner = (a: GrokBotBoundSession, b: GrokBotBoundSession) =>
  a.binding === b.binding &&
  a.botId === b.botId &&
  a.sessionId === b.sessionId &&
  a.threadId === b.threadId &&
  a.providerInstanceId === b.providerInstanceId;
const sameTurn = (a: GrokBotTurnIdentity, b: GrokBotTurnIdentity) =>
  sameOwner(a.native, b.native) &&
  a.runId === b.runId &&
  a.attemptId === b.attemptId &&
  a.rootNodeId === b.rootNodeId &&
  a.providerThreadId === b.providerThreadId &&
  a.providerTurnId === b.providerTurnId &&
  a.runOrdinal === b.runOrdinal &&
  a.providerTurnOrdinal === b.providerTurnOrdinal;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const completions = yield* PubSub.unbounded<GrokBotManagedCompletion>();
  const queryError = (operation: string) => (cause: unknown) =>
    isConflict(cause) || isDecodeError(cause) || isSqlError(cause)
      ? cause
      : new PersistenceSqlError({ operation, cause });
  const decodeError = (cause: Schema.SchemaError) =>
    PersistenceDecodeError.fromSchemaError("GrokBotManagedStateStore.decode", cause);
  const decodeNative = Schema.decodeUnknownEffect(Native);
  const decodeTurn = Schema.decodeUnknownEffect(Identity);
  const encodeTurn = Schema.encodeEffect(Schema.fromJsonString(Identity));
  const decodeStored = Schema.decodeUnknownEffect(Stored);
  const decodeCompletion = Schema.decodeUnknownEffect(Completion);
  const decodeIdentityRow = Schema.decodeUnknownEffect(
    Schema.Struct({ identity: Schema.fromJsonString(Identity) }),
  );
  const get = Effect.fn("GrokBotManagedStateStore.get")(function* (
    key: Pick<GrokBotBoundSession, "binding" | "botId" | "sessionId">,
  ) {
    const rows = yield* sql`
      SELECT account_binding AS "binding", bot_id AS "botId", session_id AS "sessionId",
        thread_id AS "threadId", provider_instance_id AS "providerInstanceId",
        generation, after_updated_seq AS "afterUpdatedSeq"
      FROM grok_bot_managed_bindings WHERE account_binding = ${key.binding}
        AND bot_id = ${key.botId} AND session_id = ${key.sessionId}
    `.pipe(Effect.mapError(queryError("GrokBotManagedStateStore.get")));
    return rows[0] === undefined
      ? undefined
      : yield* decodeNative(rows[0]).pipe(Effect.mapError(decodeError));
  });
  const requireOwner = Effect.fnUntraced(function* (native: GrokBotBoundSession) {
    const owner = yield* get(native);
    if (owner === undefined || !sameOwner(owner, native))
      return yield* new ManagedStateConflict({ stage: "binding" });
    return owner;
  });
  const lookupTurn = Effect.fn("GrokBotManagedStateStore.lookupTurn")(function* (
    identity: GrokBotTurnIdentity | { readonly runId: RunId; readonly attemptId: RunAttemptId },
  ) {
    if ("native" in identity) yield* requireOwner(identity.native);
    const rows = yield* sql`
      SELECT identity_json AS "identity", state, delivery, workflow_id AS "workflowId",
        echo_entry_id AS "echoEntryId", outcome, settled_at_ms AS "settledAtMs"
      FROM grok_bot_managed_turns WHERE run_id = ${identity.runId} AND attempt_id = ${identity.attemptId}
        ${
          "native" in identity
            ? sql`AND account_binding = ${identity.native.binding}
          AND bot_id = ${identity.native.botId} AND session_id = ${identity.native.sessionId}
          AND provider_turn_id = ${identity.providerTurnId}`
            : sql``
        }
      ORDER BY rowid DESC LIMIT 1
    `.pipe(Effect.mapError(queryError("GrokBotManagedStateStore.lookupTurn")));
    if (rows[0] === undefined) return undefined;
    const row = yield* decodeStored(rows[0]).pipe(Effect.mapError(decodeError));
    if ("native" in identity && !sameTurn(row.identity, identity))
      return yield* new ManagedStateConflict({ stage: "turn" });
    yield* requireOwner(row.identity.native);
    return row;
  });
  const requireTurn = Effect.fnUntraced(function* (identity: GrokBotTurnIdentity) {
    const row = yield* lookupTurn(identity);
    if (
      row === undefined ||
      row.identity.messageId !== identity.messageId ||
      row.identity.sentAtMs !== identity.sentAtMs
    )
      return yield* new ManagedStateConflict({ stage: "turn" });
    return row;
  });
  return GrokBotManagedStateStore.of({
    get,
    lookupTurn,
    hasConfirmedWorkflowSkill: Effect.fn("GrokBotManagedStateStore.hasConfirmedWorkflowSkill")(
      function* (input) {
        yield* requireOwner(input.native);
        const rows = yield* sql`SELECT t.identity_json AS "identity", t.outcome AS "outcome"
          FROM grok_bot_managed_turns t JOIN grok_bot_managed_completions c
            ON c.provider_turn_id = t.provider_turn_id
          WHERE t.account_binding = ${input.native.binding} AND t.bot_id = ${input.native.botId}
            AND t.session_id = ${input.native.sessionId} AND t.state = 'settled'
          ORDER BY c.rowid DESC LIMIT 1`.pipe(
          Effect.mapError(queryError("GrokBotManagedStateStore.hasConfirmedWorkflowSkill")),
        );
        if (rows[0] === undefined) return false;
        const identity = (yield* decodeIdentityRow(rows[0]).pipe(Effect.mapError(decodeError)))
          .identity;
        return (
          rows[0].outcome === "success" &&
          identity.managedSkill?.confirmed === true &&
          identity.managedSkill.hash === input.hash &&
          identity.managedSkill.workflowPath === input.workflowPath
        );
      },
    ),
    lookupCompletion: Effect.fn("GrokBotManagedStateStore.lookupCompletion")(function* (identity) {
      yield* requireTurn(identity);
      const rows = yield* sql`
        SELECT t.identity_json AS "identity", c.source, c.final_text AS "finalText",
          c.declared_at_ms AS "declaredAtMs"
        FROM grok_bot_managed_completions c JOIN grok_bot_managed_turns t
          ON t.provider_turn_id = c.provider_turn_id
        WHERE c.provider_turn_id = ${identity.providerTurnId}
      `.pipe(Effect.mapError(queryError("GrokBotManagedStateStore.lookupCompletion")));
      return rows[0] === undefined
        ? undefined
        : yield* decodeCompletion(rows[0]).pipe(Effect.mapError(decodeError));
    }),
    declareCompletion: Effect.fn("GrokBotManagedStateStore.declareCompletion")(function* (input) {
      const declaration = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* requireTurn(input.identity);
            if (row.state === "settled")
              return yield* new ManagedStateConflict({ stage: "completion" });
            const previous = yield* sql`
            SELECT t.identity_json AS "identity", c.source, c.final_text AS "finalText",
              c.declared_at_ms AS "declaredAtMs"
            FROM grok_bot_managed_completions c JOIN grok_bot_managed_turns t
              ON t.provider_turn_id = c.provider_turn_id
            WHERE c.provider_turn_id = ${input.identity.providerTurnId}
          `;
            if (previous[0] !== undefined) {
              const saved = yield* decodeCompletion(previous[0]).pipe(Effect.mapError(decodeError));
              if (saved.finalText !== input.finalText)
                return yield* new ManagedStateConflict({ stage: "completion" });
              return saved;
            }
            const receipt = row.identity.managedSkill;
            const acknowledged =
              input.managedSkillHash !== undefined &&
              receipt?.workflowPath !== undefined &&
              input.managedSkillHash === receipt.hash;
            const completedIdentity = acknowledged
              ? { ...row.identity, managedSkill: { ...receipt, confirmed: true } }
              : row.identity;
            const identityJson = yield* encodeTurn(completedIdentity).pipe(
              Effect.mapError(decodeError),
            );
            const valid = yield* decodeCompletion({
              identity: identityJson,
              source: "agent_declaration",
              finalText: input.finalText,
              declaredAtMs: input.declaredAtMs,
            }).pipe(Effect.mapError(decodeError));
            yield* sql`INSERT INTO grok_bot_managed_completions
            (provider_turn_id, source, final_text, declared_at_ms)
            VALUES(${input.identity.providerTurnId}, ${valid.source}, ${valid.finalText}, ${valid.declaredAtMs})`;
            if (acknowledged)
              yield* sql`UPDATE grok_bot_managed_turns SET identity_json = ${identityJson}
              WHERE provider_turn_id = ${input.identity.providerTurnId}`;
            return valid;
          }),
        )
        .pipe(Effect.mapError(queryError("GrokBotManagedStateStore.declareCompletion")));
      yield* PubSub.publish(completions, declaration);
      return declaration;
    }, Effect.uninterruptible),
    openCompletionWatch: Effect.fn("GrokBotManagedStateStore.openCompletionWatch")(
      function* (native) {
        yield* requireOwner(native);
        const subscription = yield* PubSub.subscribe(completions);
        const rows = yield* sql`
        SELECT t.identity_json AS "identity", c.source, c.final_text AS "finalText",
          c.declared_at_ms AS "declaredAtMs"
        FROM grok_bot_managed_completions c JOIN grok_bot_managed_turns t
          ON t.provider_turn_id = c.provider_turn_id
        WHERE t.account_binding = ${native.binding} AND t.bot_id = ${native.botId}
          AND t.session_id = ${native.sessionId} AND t.state != 'settled'
        ORDER BY c.declared_at_ms, c.rowid
      `.pipe(Effect.mapError(queryError("GrokBotManagedStateStore.openCompletionWatch")));
        const saved = yield* Effect.forEach(rows, (row) =>
          decodeCompletion(row).pipe(Effect.mapError(decodeError)),
        );
        return Stream.fromIterable(saved).pipe(
          Stream.concat(Stream.fromSubscription(subscription)),
          Stream.filter((declaration) => sameOwner(declaration.identity.native, native)),
        );
      },
    ),
    projectSettlement: Effect.fn("GrokBotManagedStateStore.projectSettlement")(function* (input) {
      const rows = yield* sql`
        SELECT identity_json AS "identity", state, delivery, workflow_id AS "workflowId",
          echo_entry_id AS "echoEntryId", outcome, settled_at_ms AS "settledAtMs"
        FROM grok_bot_managed_turns WHERE provider_turn_id = ${input.providerTurnId}
      `.pipe(Effect.mapError(queryError("GrokBotManagedStateStore.projectSettlement")));
      if (rows[0] === undefined) return;
      const row = yield* decodeStored(rows[0]).pipe(Effect.mapError(decodeError));
      if (
        row.identity.native.threadId !== input.threadId ||
        row.identity.attemptId !== input.attemptId ||
        row.identity.rootNodeId !== input.rootNodeId
      )
        return yield* new ManagedStateConflict({ stage: "settlement" });
      yield* requireOwner(row.identity.native);
      if (row.state === "settled") {
        if (row.outcome !== input.outcome || row.settledAtMs !== input.settledAtMs)
          return yield* new ManagedStateConflict({ stage: "settlement" });
        return;
      }
      yield* decodeSettlementTime(input.settledAtMs).pipe(Effect.mapError(decodeError));
      yield* sql`
        UPDATE grok_bot_managed_turns SET state = 'settled', outcome = ${input.outcome},
          settled_at_ms = ${input.settledAtMs} WHERE provider_turn_id = ${input.providerTurnId}
      `.pipe(Effect.mapError(queryError("GrokBotManagedStateStore.projectSettlement")));
    }),
    acquire: Effect.fn("GrokBotManagedStateStore.acquire")(function* (native) {
      const valid = yield* decodeNative(native).pipe(Effect.mapError(decodeError));
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Only a projection commit can advance a cursor, never binding acquisition.
            yield* sql`INSERT OR IGNORE INTO grok_bot_managed_bindings
          (account_binding, bot_id, session_id, thread_id, provider_instance_id, generation, after_updated_seq)
          VALUES(${valid.binding}, ${valid.botId}, ${valid.sessionId}, ${valid.threadId}, ${valid.providerInstanceId}, 0, '0')`.pipe(
              Effect.mapError(queryError("GrokBotManagedStateStore.acquire")),
            );
            return yield* requireOwner(valid);
          }),
        )
        .pipe(Effect.mapError(queryError("GrokBotManagedStateStore.acquireTransaction")));
    }),
    prepareTurn: Effect.fn("GrokBotManagedStateStore.prepareTurn")(function* (identity) {
      const valid = yield* decodeTurn(identity).pipe(Effect.mapError(decodeError));
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireOwner(valid.native);
            const previous = yield* lookupTurn(valid);
            // Regenerating a delivery nonce on worker replay would send a second cloud prompt.
            if (previous !== undefined) return previous.identity;
            const json = yield* encodeTurn(valid).pipe(Effect.mapError(decodeError));
            yield* sql`INSERT INTO grok_bot_managed_turns
          (account_binding, bot_id, session_id, message_id, run_id, attempt_id, provider_turn_id, identity_json, state)
          VALUES(${valid.native.binding}, ${valid.native.botId}, ${valid.native.sessionId}, ${valid.messageId},
            ${valid.runId}, ${valid.attemptId}, ${valid.providerTurnId}, ${json}, 'prepared')`.pipe(
              Effect.mapError(queryError("GrokBotManagedStateStore.prepareTurn")),
            );
            return valid;
          }),
        )
        .pipe(Effect.mapError(queryError("GrokBotManagedStateStore.prepareTurnTransaction")));
    }),
    accepted: Effect.fn("GrokBotManagedStateStore.accepted")(function* (input) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* requireTurn(input.identity);
            if (row.state === "settled") return;
            if (
              (row.workflowId !== null &&
                input.workflowId !== undefined &&
                row.workflowId !== input.workflowId) ||
              (row.echoEntryId !== null &&
                input.echoEntryId !== undefined &&
                row.echoEntryId !== input.echoEntryId)
            )
              return yield* new ManagedStateConflict({ stage: "receipt" });
            yield* sql`UPDATE grok_bot_managed_turns SET state = 'accepted', delivery = ${input.delivery},
          workflow_id = COALESCE(${input.workflowId ?? null}, workflow_id),
          echo_entry_id = COALESCE(${input.echoEntryId ?? null}, echo_entry_id)
          WHERE account_binding = ${input.identity.native.binding} AND bot_id = ${input.identity.native.botId}
            AND session_id = ${input.identity.native.sessionId} AND message_id = ${input.identity.messageId}`.pipe(
              Effect.mapError(queryError("GrokBotManagedStateStore.accepted")),
            );
          }),
        )
        .pipe(Effect.mapError(queryError("GrokBotManagedStateStore.acceptedTransaction")));
    }),
    uncertain: Effect.fn("GrokBotManagedStateStore.uncertain")(function* (identity) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireTurn(identity);
            yield* sql`UPDATE grok_bot_managed_turns SET state = 'uncertain'
          WHERE account_binding = ${identity.native.binding} AND bot_id = ${identity.native.botId}
            AND session_id = ${identity.native.sessionId} AND message_id = ${identity.messageId} AND state = 'prepared'`.pipe(
              Effect.mapError(queryError("GrokBotManagedStateStore.uncertain")),
            );
          }),
        )
        .pipe(Effect.mapError(queryError("GrokBotManagedStateStore.uncertainTransaction")));
    }),
    lookupTranscriptTurn: Effect.fn("GrokBotManagedStateStore.lookupTranscriptTurn")(
      function* (native, messageId) {
        yield* requireOwner(native);
        const rows = yield* sql`SELECT identity_json AS "identity" FROM grok_bot_managed_turns
          WHERE account_binding = ${native.binding} AND bot_id = ${native.botId}
            AND session_id = ${native.sessionId} AND message_id = ${messageId}`.pipe(
          Effect.mapError(queryError("GrokBotManagedStateStore.lookupTranscriptTurn")),
        );
        if (rows[0] === undefined) return undefined;
        const decoded = yield* decodeIdentityRow(rows[0]).pipe(Effect.mapError(decodeError));
        return decoded.identity;
      },
    ),
    restoreManagedMessageIds: Effect.fn("GrokBotManagedStateStore.restoreManagedMessageIds")(
      function* (native) {
        yield* requireOwner(native);
        const rows = yield* sql`SELECT message_id AS "messageId" FROM grok_bot_managed_turns
        WHERE account_binding = ${native.binding} AND bot_id = ${native.botId} AND session_id = ${native.sessionId}
        ORDER BY rowid`.pipe(
          Effect.mapError(queryError("GrokBotManagedStateStore.restoreManagedMessageIds")),
        );
        return yield* Effect.forEach(rows, (row) =>
          decodeManagedMessageId(row).pipe(
            Effect.map((value) => value.messageId),
            Effect.mapError(decodeError),
          ),
        );
      },
    ),
    restoreTranscriptTurns: Effect.fn("GrokBotManagedStateStore.restoreTranscriptTurns")(
      function* (native) {
        yield* requireOwner(native);
        const rows = yield* sql`SELECT identity_json AS "identity" FROM grok_bot_managed_turns
          WHERE account_binding = ${native.binding} AND bot_id = ${native.botId} AND session_id = ${native.sessionId}
          ORDER BY rowid`.pipe(
          Effect.mapError(queryError("GrokBotManagedStateStore.restoreTranscriptTurns")),
        );
        return yield* Effect.forEach(rows, (row) =>
          decodeIdentityRow(row).pipe(
            Effect.map((value) => value.identity),
            Effect.mapError(decodeError),
          ),
        );
      },
    ),
    restoreTurns: Effect.fn("GrokBotManagedStateStore.restoreTurns")(function* (native) {
      yield* requireOwner(native);
      const rows = yield* sql`SELECT identity_json AS "identity" FROM grok_bot_managed_turns
        WHERE account_binding = ${native.binding} AND bot_id = ${native.botId} AND session_id = ${native.sessionId}
          AND state != 'settled' ORDER BY rowid`.pipe(
        Effect.mapError(queryError("GrokBotManagedStateStore.restoreTurns")),
      );
      return yield* Effect.forEach(rows, (row) =>
        decodeIdentityRow(row).pipe(
          Effect.map((value) => value.identity),
          Effect.mapError(decodeError),
        ),
      );
    }),
    commitSettlement: Effect.fn("GrokBotManagedStateStore.commitSettlement")(function* (input) {
      yield* decodeSettlementTime(input.settledAtMs).pipe(Effect.mapError(decodeError));
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* requireTurn(input.identity);
            if (row.state === "settled") {
              if (row.outcome !== input.outcome || row.settledAtMs !== input.settledAtMs)
                return yield* new ManagedStateConflict({ stage: "settlement" });
              return;
            }
            yield* sql`UPDATE grok_bot_managed_turns SET state = 'settled', outcome = ${input.outcome}, settled_at_ms = ${input.settledAtMs}
          WHERE account_binding = ${input.identity.native.binding} AND bot_id = ${input.identity.native.botId}
            AND session_id = ${input.identity.native.sessionId} AND message_id = ${input.identity.messageId}`.pipe(
              Effect.mapError(queryError("GrokBotManagedStateStore.commitSettlement")),
            );
          }),
        )
        .pipe(Effect.mapError(queryError("GrokBotManagedStateStore.commitSettlementTransaction")));
    }),
    commitCursor: Effect.fn("GrokBotManagedStateStore.commitCursor")(function* (native) {
      const valid = yield* decodeNative(native).pipe(Effect.mapError(decodeError));
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const previous = yield* requireOwner(valid);
            if (
              valid.generation < previous.generation ||
              (valid.generation === previous.generation &&
                BigInt(valid.afterUpdatedSeq) < BigInt(previous.afterUpdatedSeq))
            )
              return yield* new ManagedStateConflict({ stage: "cursor" });
            yield* sql`UPDATE grok_bot_managed_bindings SET generation = ${valid.generation}, after_updated_seq = ${valid.afterUpdatedSeq}
          WHERE account_binding = ${valid.binding} AND bot_id = ${valid.botId} AND session_id = ${valid.sessionId}`.pipe(
              Effect.mapError(queryError("GrokBotManagedStateStore.commitCursor")),
            );
          }),
        )
        .pipe(Effect.mapError(queryError("GrokBotManagedStateStore.commitCursorTransaction")));
    }),
  });
});

export const layer = Layer.effect(GrokBotManagedStateStore, make);
