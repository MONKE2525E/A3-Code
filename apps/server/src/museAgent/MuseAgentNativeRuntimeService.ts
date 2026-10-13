import { MuseAgentProfile, type MuseAgentStatus } from "@t3tools/contracts/museAgent";
import { ChatAttachment, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { ProviderPromptNotSubmittedError } from "@t3tools/provider-core/server/ProviderAdapter";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Read bounded server-owned attachments at the native transport Promise boundary.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Canonical path checks constrain attachment reads to the server-owned store.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Source from "./MuseAgentSessionSource.ts";
import * as Transport from "./MuseAgentTransport.ts";
import * as Delivery from "./MuseAgentDeliveryStore.ts";
import type {
  MuseAgentDeliveryContext,
  MuseAgentDeliveryScope,
  MuseAgentHistoryOwnership,
  MuseAgentHistoryOwnershipScope,
  MuseAgentPendingDelivery,
  MuseAgentManagedMessageSnapshot,
} from "./MuseAgentDeliveryOwnership.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  prepareMuseAttachment,
  materializeMuseAttachment,
  museAttachmentContentIdentity,
  MUSE_ATTACHMENT_LIMITS,
  readMuseAttachment,
  type PreparedMuseAttachment,
} from "./MuseAgentAttachmentTransfer.ts";

export class MuseAgentRuntimeError extends Schema.TaggedError<MuseAgentRuntimeError>()(
  "MuseAgentRuntimeError",
  {
    kind: Schema.Literals(["account_changed", "protocol", "unsupported", "busy"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.kind) {
      case "account_changed":
        return "The selected Muse account or cloud workspace changed. Set up a new binding.";
      case "unsupported":
        return "This action is not supported by the verified Muse native protocol.";
      case "busy":
        return "Muse is already working in this session.";
      default:
        return "Muse returned an unsupported native protocol response.";
    }
  }
}
export type MuseAgentError =
  | MuseAgentRuntimeError
  | Transport.MuseAgentTransportError
  | Delivery.MuseAgentDeliveryError;

export const MuseAgentNativeSession = Schema.Struct({
  session_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  status: Schema.String,
  is_primary: Schema.Boolean,
  is_thread: Schema.Boolean,
  archived: Schema.optionalKey(Schema.Boolean),
  can_send_messages: Schema.optionalKey(Schema.Boolean),
  can_send_actions: Schema.optionalKey(Schema.Boolean),
  read_only_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type MuseAgentNativeSession = typeof MuseAgentNativeSession.Type;
const Sessions = Schema.Struct({ sessions: Schema.Array(MuseAgentNativeSession) });
const Admission = Schema.Struct({
  message_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  reply_to_message_id: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  ),
  session_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
const History = Schema.Struct({
  chat_events: Schema.Array(Schema.Unknown),
  has_more: Schema.optionalKey(Schema.Boolean),
});
const StreamHistory = Schema.Struct({ events: Schema.Array(Schema.Unknown) });
const Identity = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  creature: Schema.optionalKey(Schema.String),
  vibe: Schema.optionalKey(Schema.String),
  emoji: Schema.optionalKey(Schema.String),
  tagline: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  avatar: Schema.optionalKey(
    Schema.Struct({
      canonical_path: Schema.optionalKey(Schema.String),
      image_path: Schema.optionalKey(Schema.String),
      chat_theme_color: Schema.optionalKey(Schema.String),
      video_variants: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});
const safeText = (value: string | undefined, limit: number) =>
  // oxlint-disable-next-line no-control-regex -- Remove control characters from native identity display fields.
  value?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit);
const avatarPath = (value: string | undefined) =>
  value &&
  /^\/?workspace\/avatars\/[a-zA-Z0-9_./-]+$/.test(value) &&
  !value.split("/").includes("..")
    ? value.slice(0, 2048)
    : undefined;

export class MuseAgentNativeRuntimeService extends Context.Service<
  MuseAgentNativeRuntimeService,
  {
    /** Presence-only; does not launch a browser or make a network call. */
    readonly status: Effect.Effect<MuseAgentStatus>;
    /** Explicitly connects the server-owned headless page using the readonly native session. */
    readonly setup: Effect.Effect<MuseAgentStatus, MuseAgentError>;
    readonly accountBinding: Effect.Effect<string, MuseAgentError>;
    readonly profile: (binding: string) => Effect.Effect<MuseAgentProfile, MuseAgentError>;
    readonly sessions: (
      binding: string,
    ) => Effect.Effect<readonly MuseAgentNativeSession[], MuseAgentError>;
    readonly resolveSession: (
      binding: string,
      sessionId?: string,
    ) => Effect.Effect<MuseAgentNativeSession, MuseAgentError>;
    readonly read: (input: {
      readonly binding: string;
      readonly sessionId: string;
      readonly beforeSeq?: number;
    }) => Effect.Effect<
      { readonly events: readonly unknown[]; readonly hasMore: boolean },
      MuseAgentError
    >;
    readonly readAttachment: (input: {
      readonly binding: string;
      readonly sandboxPath: string;
      readonly maxBytes?: number;
    }) => Effect.Effect<{ readonly bytes: Uint8Array; readonly sha256: string }, MuseAgentError>;
    readonly send: (input: {
      readonly binding: string;
      readonly sessionId: string;
      readonly deliveryKey: string;
      readonly text: string;
      readonly clientId?: string;
      readonly context?: MuseAgentDeliveryContext;
      readonly attachments?: {
        readonly directory: string;
        readonly items: readonly ChatAttachment[];
      };
    }) => Effect.Effect<
      Delivery.MuseAgentReceipt & { readonly replayed?: boolean },
      MuseAgentError | ProviderPromptNotSubmittedError
    >;
    readonly replay: (input: {
      readonly binding: string;
      readonly receipt: Delivery.MuseAgentReceipt;
    }) => Effect.Effect<readonly unknown[], MuseAgentError>;
    readonly watch: (input: {
      readonly binding: string;
      readonly sessionId: string;
    }) => Effect.Effect<
      {
        readonly events: Stream.Stream<Transport.MuseAgentNativeEvent, MuseAgentError>;
        readonly close: Effect.Effect<void>;
      },
      MuseAgentError
    >;
    readonly settleDelivery: (deliveryKey: string) => Effect.Effect<void, MuseAgentError>;
    readonly historyOwnership: (
      scope: MuseAgentHistoryOwnershipScope,
      options?: {
        readonly awaitAdmissions?: boolean;
        readonly receiptsOnly?: boolean;
        readonly nativeMessageId?: string;
      },
    ) => Effect.Effect<MuseAgentHistoryOwnership, MuseAgentError>;
    readonly recordManagedMessage: (
      input: MuseAgentDeliveryScope & {
        readonly deliveryKey: string;
        readonly nativeMessageId: string;
        readonly snapshot: MuseAgentManagedMessageSnapshot;
      },
    ) => Effect.Effect<void, MuseAgentError>;
    readonly pendingDeliveries: (
      scope: MuseAgentDeliveryScope,
    ) => Effect.Effect<readonly MuseAgentPendingDelivery[], MuseAgentError>;
    readonly releaseLocalOwnership: (
      input: MuseAgentDeliveryScope & { readonly deliveryKey: string },
    ) => Effect.Effect<void, MuseAgentError>;
    readonly stop: (input: {
      readonly binding: string;
      readonly sessionId: string;
      readonly deliveryKey: string;
    }) => Effect.Effect<void, MuseAgentError>;
    readonly connectionId: (binding: string) => Effect.Effect<string, MuseAgentError>;
    readonly registerTools: (
      binding: string,
      input: Transport.MuseAgentToolRegistration,
    ) => Effect.Effect<
      { readonly accepted: number; readonly connectionId: string },
      MuseAgentError
    >;
    readonly unregisterTools: (binding: string, clientId: string) => Effect.Effect<void>;
  }
>()("t3/museAgent/MuseAgentNativeRuntimeService") {}

const make = Effect.gen(function* () {
  const source = yield* Source.MuseAgentSessionSource;
  const transport = yield* Transport.MuseAgentTransport;
  const deliveries = yield* Delivery.MuseAgentDeliveryStore;
  const admissions = new Set<{
    readonly binding: string;
    readonly sessionId: string;
    readonly context: MuseAgentDeliveryContext | undefined;
    readonly completed: Deferred.Deferred<void>;
  }>();
  let connectedBinding: string | undefined;
  const accountBinding = transport.connect.pipe(
    Effect.tap((binding) =>
      Effect.sync(() => {
        connectedBinding = binding;
      }),
    ),
  );
  const check = Effect.fnUntraced(function* (binding: string) {
    if ((yield* accountBinding) !== binding)
      return yield* new MuseAgentRuntimeError({ kind: "account_changed" });
  });
  const decode = <A>(value: unknown, codec: Schema.Codec<A, unknown>) =>
    Schema.decodeUnknownEffect(codec)(value).pipe(
      Effect.mapError((cause) => new MuseAgentRuntimeError({ kind: "protocol", cause })),
    );
  const sessions = Effect.fnUntraced(function* (binding: string) {
    yield* check(binding);
    const value = yield* transport.request(binding, "sessions.list", {
      include_peer_sidechats: true,
    });
    return (yield* decode(value, Sessions)).sessions;
  });
  const resolveSession = Effect.fnUntraced(function* (binding: string, sessionId?: string) {
    const list = yield* sessions(binding);
    const session = sessionId
      ? list.find((item) => item.session_id === sessionId)
      : list.find((item) => item.is_primary && !item.archived);
    if (
      !session ||
      session.archived ||
      session.can_send_messages === false ||
      session.read_only_reason
    )
      return yield* new MuseAgentRuntimeError({ kind: "unsupported" });
    return session;
  });
  return MuseAgentNativeRuntimeService.of({
    accountBinding,
    sessions,
    resolveSession,
    status: source.inspect.pipe(
      Effect.map((info) => ({
        ...info,
        ready: connectedBinding !== undefined && info.sessionPresent,
        message: connectedBinding
          ? "Muse is connected."
          : info.sessionPresent
            ? "Muse session detected. Connect Muse to verify its native account."
            : "Open Muse for Linux and sign in to detect your session.",
        ...(connectedBinding ? { accountBinding: connectedBinding } : {}),
      })),
      Effect.orElseSucceed(() => ({
        installed: false,
        sessionPresent: false,
        ready: false,
        message: "The local Muse session could not be inspected.",
      })),
    ),
    setup: Effect.gen(function* () {
      const binding = yield* accountBinding;
      yield* resolveSession(binding);
      return {
        installed: true,
        sessionPresent: true,
        ready: true,
        message: "Muse is connected.",
        accountBinding: binding,
      };
    }),
    profile: (binding) =>
      Effect.gen(function* () {
        yield* check(binding);
        const identity = yield* decode(yield* transport.request(binding, "identity", {}), Identity);
        const variants = Object.fromEntries(
          Object.entries(identity.avatar?.video_variants ?? {}).flatMap(([key, value]) => {
            const valuePath = avatarPath(value);
            return valuePath && /^[a-z_]{1,64}$/.test(key) ? [[key, valuePath]] : [];
          }),
        );
        const profile = {
          id: "muse" as const,
          name: safeText(identity.name, 128) || "Muse",
          creature: safeText(identity.creature, 256),
          vibe: safeText(identity.vibe, 256),
          emoji: safeText(identity.emoji, 32),
          tagline: safeText(identity.tagline, 1024),
          description: safeText(identity.description, 4096),
          avatarPath: avatarPath(identity.avatar?.canonical_path),
          avatarImagePath: avatarPath(identity.avatar?.image_path),
          avatarVideoVariants: variants,
          chatThemeColor:
            identity.avatar?.chat_theme_color &&
            /^#[0-9a-fA-F]{6}$/.test(identity.avatar.chat_theme_color)
              ? identity.avatar.chat_theme_color
              : undefined,
        };
        return yield* decode(
          Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined)),
          MuseAgentProfile,
        );
      }),
    read: (input) =>
      Effect.gen(function* () {
        yield* resolveSession(input.binding, input.sessionId);
        const value = yield* transport.request(input.binding, "chat.history", {
          session_id: input.sessionId,
          limit: 80,
          transcript_mode: "messages",
          ...(input.beforeSeq === undefined ? {} : { before_seq: input.beforeSeq }),
        });
        const history = yield* decode(value, History);
        return { events: history.chat_events, hasMore: history.has_more === true };
      }),
    readAttachment: (input) =>
      check(input.binding).pipe(
        Effect.andThen(
          readMuseAttachment(input).pipe(
            Effect.provideService(Transport.MuseAgentTransport, transport),
            Effect.mapError(
              (cause) =>
                new MuseAgentRuntimeError({
                  kind: cause.kind === "account_changed" ? "account_changed" : "protocol",
                  cause,
                }),
            ),
          ),
        ),
      ),
    send: (input) =>
      Effect.gen(function* () {
        const prepared = yield* Effect.gen(function* () {
          if (
            (!input.text.trim() && !input.attachments?.items.length) ||
            input.text.length > 262144
          )
            return yield* new MuseAgentRuntimeError({ kind: "unsupported" });
          yield* resolveSession(input.binding, input.sessionId);
          const prepared: PreparedMuseAttachment[] = [];
          if (input.attachments?.items.length) {
            const attachments = yield* decode(
              input.attachments.items,
              Schema.Array(ChatAttachment),
            );
            const imageBytes = attachments.reduce(
              (total, item) => total + (item.type === "image" ? item.sizeBytes : 0),
              0,
            );
            if (
              attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
              attachments.some(
                (item) =>
                  (item.type !== "image" && item.type !== "file") ||
                  !Number.isSafeInteger(item.sizeBytes) ||
                  item.sizeBytes <= 0 ||
                  item.sizeBytes > MUSE_ATTACHMENT_LIMITS.fileBytes,
              ) ||
              imageBytes > MUSE_ATTACHMENT_LIMITS.inlineBytes ||
              attachments.reduce((total, item) => total + item.sizeBytes, 0) >
                MUSE_ATTACHMENT_LIMITS.totalBytes
            )
              return yield* new MuseAgentRuntimeError({ kind: "unsupported" });
            const directory = input.attachments.directory;
            const snapshots = yield* Effect.tryPromise({
              try: async () => {
                const root = await NodeFSP.realpath(directory);
                const snapshots: Uint8Array[] = [];
                for (const attachment of attachments) {
                  const path = resolveAttachmentPath({ attachmentsDir: root, attachment });
                  if (!path) throw new Error("attachment_path_refused");
                  const canonical = await NodeFSP.realpath(path);
                  if (!canonical.startsWith(root + NodePath.sep))
                    throw new Error("attachment_path_refused");
                  const file = await NodeFSP.open(canonical, "r");
                  try {
                    const stat = await file.stat();
                    if (!stat.isFile() || stat.size !== attachment.sizeBytes)
                      throw new Error("attachment_size_changed");
                    const bytes = Buffer.alloc(attachment.sizeBytes + 1);
                    let bytesRead = 0;
                    while (bytesRead < bytes.length) {
                      const next = await file.read(
                        bytes,
                        bytesRead,
                        bytes.length - bytesRead,
                        bytesRead,
                      );
                      if (!next.bytesRead) break;
                      bytesRead += next.bytesRead;
                    }
                    if (bytesRead !== attachment.sizeBytes)
                      throw new Error("attachment_size_changed");
                    snapshots.push(bytes.subarray(0, bytesRead));
                  } finally {
                    await file.close();
                  }
                }
                return snapshots;
              },
              catch: (cause) => new MuseAgentRuntimeError({ kind: "unsupported", cause }),
            });
            // Reserve images first, since they have no file_ref fallback. Preserve item order.
            let fileBudget = MUSE_ATTACHMENT_LIMITS.inlineBytes - imageBytes;
            for (let index = 0; index < attachments.length; index++) {
              const attachment = attachments[index]!;
              const snapshot = yield* prepareMuseAttachment({
                attachment,
                bytes: snapshots[index]!,
                inlineBudget: attachment.type === "image" ? attachment.sizeBytes : fileBudget,
              });
              prepared.push(snapshot);
              if (attachment.type === "file" && snapshot._tag === "Inline")
                fileBudget -= snapshot.byteLength;
            }
          }
          return prepared;
        }).pipe(Effect.mapError((cause) => new ProviderPromptNotSubmittedError({ cause })));
        const attachmentIdentity = prepared.length
          ? museAttachmentContentIdentity(prepared)
          : undefined;
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const pending = {
              binding: input.binding,
              sessionId: input.sessionId,
              context: input.context,
              completed: Deferred.makeUnsafe<void>(),
            };
            admissions.add(pending);
            return pending;
          }),
          () =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const existing = yield* deliveries
                  .begin({
                    ...input,
                    ...(attachmentIdentity ? { attachmentIdentity } : {}),
                  })
                  .pipe(
                    Effect.catchTags({
                      MuseAgentDeliveryError: (cause) =>
                        cause.kind === "busy" || cause.kind === "conflict"
                          ? Effect.fail(new ProviderPromptNotSubmittedError({ cause }))
                          : Effect.fail(cause),
                    }),
                  );
                if (existing) return { ...existing, replayed: true };
                let promptAttempted = false;
                return yield* restore(
                  Effect.gen(function* () {
                    const items = yield* Effect.forEach(prepared, (attachment) =>
                      materializeMuseAttachment(input.binding, attachment).pipe(
                        Effect.provideService(Transport.MuseAgentTransport, transport),
                        Effect.mapError((cause) => new ProviderPromptNotSubmittedError({ cause })),
                      ),
                    );
                    // No cleanup may abandon the intent once the native chat write is attempted.
                    promptAttempted = true;
                    // Muse does not advertise idempotent native chat admission. A persisted intent is never replayed.
                    const response = yield* transport.request(
                      input.binding,
                      "chat.stream",
                      {
                        items: [
                          ...items,
                          ...(input.text.trim() ? [{ type: "text", text: input.text }] : []),
                        ],
                        session_id: input.sessionId,
                        ...(input.clientId ? { node_id: input.clientId } : {}),
                        capabilities: [
                          "chat_cancel",
                          "delta_stream",
                          "custom_reactions",
                          "custom_reactions_facebook_thumbs_up_v1",
                        ],
                      },
                      true,
                      input.deliveryKey,
                    );
                    const admission = yield* decode(response, Admission);
                    if (admission.session_id !== input.sessionId)
                      return yield* new MuseAgentRuntimeError({ kind: "protocol" });
                    const receipt = {
                      messageId: admission.message_id,
                      replyToMessageId: admission.reply_to_message_id ?? admission.message_id,
                      sessionId: admission.session_id,
                    };
                    yield* deliveries.accept(input.deliveryKey, receipt);
                    return { ...receipt, replayed: false };
                  }),
                ).pipe(
                  Effect.onExit((exit) =>
                    !promptAttempted && Exit.isFailure(exit)
                      ? deliveries.abandonBeforePrompt(input.deliveryKey)
                      : Effect.void,
                  ),
                  Effect.catchCause((cause) =>
                    promptAttempted
                      ? Effect.failCause(cause)
                      : Effect.fail(new ProviderPromptNotSubmittedError({ cause })),
                  ),
                );
              }),
            ),
          (pending) =>
            Effect.sync(() => {
              admissions.delete(pending);
            }).pipe(Effect.andThen(Deferred.succeed(pending.completed, undefined)), Effect.asVoid),
        );
      }),
    replay: (input) =>
      Effect.gen(function* () {
        yield* check(input.binding);
        const result = yield* decode(
          yield* transport.request(input.binding, "chat.stream_events", {
            reply_to_message_id: input.receipt.replyToMessageId,
            session_id: input.receipt.sessionId,
            stream_lane: "all",
            limit: 4096,
          }),
          StreamHistory,
        );
        return result.events;
      }),
    watch: (input) =>
      resolveSession(input.binding, input.sessionId).pipe(
        Effect.andThen(transport.watch(input.binding, input.sessionId)),
      ),
    settleDelivery: deliveries.settle,
    historyOwnership: (scope, options) =>
      Effect.gen(function* () {
        yield* check(scope.binding);
        if (options?.awaitAdmissions) {
          const pending = [...admissions].filter(
            (entry) =>
              entry.binding === scope.binding &&
              entry.sessionId === scope.sessionId &&
              entry.context?.threadId === scope.threadId &&
              entry.context.providerInstanceId === scope.providerInstanceId,
          );
          yield* Effect.forEach(pending, (entry) => Deferred.await(entry.completed), {
            discard: true,
          });
          yield* check(scope.binding);
        }
        return yield* deliveries.historyOwnership(scope, {
          receiptsOnly: options?.receiptsOnly ?? false,
          ...(options?.nativeMessageId === undefined
            ? {}
            : { nativeMessageId: options.nativeMessageId }),
        });
      }),
    recordManagedMessage: deliveries.recordManagedMessage,
    pendingDeliveries: (scope) =>
      check(scope.binding).pipe(Effect.andThen(deliveries.pendingDeliveries(scope))),
    releaseLocalOwnership: (input) =>
      Effect.gen(function* () {
        yield* resolveSession(input.binding, input.sessionId);
        const receipt = yield* deliveries.receipt(input.deliveryKey, input);
        yield* transport.releaseOwned(input.binding, {
          sessionId: input.sessionId,
          deliveryKey: input.deliveryKey,
          receipt,
        });
        yield* deliveries.releaseLocalOwnership(input);
      }),
    stop: (input) =>
      Effect.gen(function* () {
        yield* check(input.binding);
        const receipt = yield* deliveries.receipt(input.deliveryKey);
        if (!receipt || receipt.sessionId !== input.sessionId)
          return yield* new MuseAgentRuntimeError({ kind: "unsupported" });
        // The page checks the exact admission and connection generation immediately before
        // dispatch. Session-wide cancellation is refused after native ownership changes.
        yield* transport.cancelOwned(input.binding, receipt);
      }),
    connectionId: transport.connectionId,
    registerTools: transport.registerTools,
    unregisterTools: transport.unregisterTools,
  });
});

export const layer = Layer.effect(MuseAgentNativeRuntimeService, make);
