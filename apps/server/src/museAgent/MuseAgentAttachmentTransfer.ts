// @effect-diagnostics nodeBuiltinImport:off -- Snapshot and hash bounded attachment bytes at the native transfer boundary.
import * as NodeCrypto from "node:crypto";
import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Transport from "./MuseAgentTransport.ts";

export const MUSE_ATTACHMENT_LIMITS = {
  inlineBytes: 10 * 1024 * 1024,
  fileBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  totalBytes: 128 * 1024 * 1024,
  chunkBytes: 512 * 1024,
  reads: 256,
} as const;

export class MuseAgentAttachmentTransferError extends Schema.TaggedError<MuseAgentAttachmentTransferError>()(
  "MuseAgentAttachmentTransferError",
  {
    kind: Schema.Literals([
      "invalid_attachment",
      "size_mismatch",
      "account_changed",
      "transfer_failed",
      "uncertain",
    ]),
  },
) {
  override get message() {
    if (this.kind === "account_changed")
      return "The Muse account changed during attachment transfer.";
    if (this.kind === "uncertain")
      return "Muse attachment transfer is uncertain. The upload was not repeated.";
    if (this.kind === "size_mismatch") return "The Muse attachment size changed during transfer.";
    if (this.kind === "invalid_attachment")
      return "Muse accepts images up to 10 MiB and files up to 50 MiB in this integration.";
    return "The Muse attachment could not be transferred.";
  }
}

export const MuseNativeAttachmentItem = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["image", "file"]),
    mime_type: Schema.String,
    filename: Schema.String,
    data_base64: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("file_ref"),
    mime_type: Schema.String,
    filename: Schema.String,
    path: Schema.String,
  }),
]);
export type MuseNativeAttachmentItem = typeof MuseNativeAttachmentItem.Type;
type InlineItem = Extract<MuseNativeAttachmentItem, { readonly data_base64: string }>;
export type PreparedMuseAttachment =
  | {
      readonly _tag: "Inline";
      readonly identity: string;
      readonly byteLength: number;
      readonly item: InlineItem;
    }
  | {
      readonly _tag: "Upload";
      readonly identity: string;
      readonly byteLength: number;
      readonly bytes: Uint8Array;
      readonly filename: string;
      readonly mimeType: string;
    };

const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const encodeContentIdentity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.Number, Schema.String]),
  ),
);
const encodeContentIdentities = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const invalid = () => new MuseAgentAttachmentTransferError({ kind: "invalid_attachment" });
const mapTransportError = (error: Transport.MuseAgentTransportError) =>
  new MuseAgentAttachmentTransferError({
    kind:
      error.kind === "account_changed"
        ? "account_changed"
        : error.kind === "uncertain"
          ? "uncertain"
          : "transfer_failed",
  });
const FileStat = Schema.Struct({
  kind: Schema.Literal("file"),
  size: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MUSE_ATTACHMENT_LIMITS.fileBytes }),
  ),
});
const NativeNotFound = Schema.Struct({ kind: Schema.Literal("not_found") });
const isNotFound = Schema.is(NativeNotFound);
const decodeStat = Schema.decodeUnknownEffect(FileStat);

/** Prepare immutable content and its delivery identity without writing to Muse. */
export const prepareMuseAttachment = (input: {
  readonly attachment: ChatAttachment;
  readonly bytes: Uint8Array;
  readonly inlineBudget?: number;
}): Effect.Effect<PreparedMuseAttachment, MuseAgentAttachmentTransferError> =>
  Effect.try({
    try: () => {
      const { attachment } = input;
      const budget = input.inlineBudget ?? MUSE_ATTACHMENT_LIMITS.inlineBytes;
      if (
        (attachment.type !== "image" && attachment.type !== "file") ||
        !Number.isSafeInteger(attachment.sizeBytes) ||
        attachment.sizeBytes <= 0 ||
        attachment.sizeBytes !== input.bytes.byteLength ||
        attachment.sizeBytes > MUSE_ATTACHMENT_LIMITS.fileBytes ||
        !Number.isSafeInteger(budget) ||
        budget < 0 ||
        budget > MUSE_ATTACHMENT_LIMITS.inlineBytes ||
        !attachment.name ||
        attachment.name.length > 4096 ||
        // eslint-disable-next-line no-control-regex -- Native filenames must not contain control characters.
        /[\u0000-\u001f\u007f]/.test(attachment.name) ||
        !/^[\x20-\x7e]{1,128}$/.test(attachment.mimeType) ||
        (attachment.type === "image" &&
          (!isProviderSendTurnSupportedImageMimeType(attachment.mimeType) ||
            attachment.sizeBytes > budget))
      )
        throw invalid();
      // The caller cannot mutate bytes between the content hash and chunk dispatch.
      const bytes = Buffer.from(input.bytes);
      const identity = digest(
        encodeContentIdentity([
          attachment.type,
          attachment.name,
          attachment.mimeType,
          bytes.length,
          digest(bytes),
        ]),
      );
      if (bytes.length <= budget)
        return {
          _tag: "Inline" as const,
          identity,
          byteLength: bytes.length,
          item: {
            type: attachment.type === "image" ? ("image" as const) : ("file" as const),
            mime_type: attachment.mimeType,
            filename: attachment.name,
            data_base64: bytes.toString("base64"),
          },
        };
      return {
        _tag: "Upload" as const,
        identity,
        byteLength: bytes.length,
        bytes,
        filename: attachment.name,
        mimeType: attachment.mimeType,
      };
    },
    catch: () => invalid(),
  });

/** Random cloud destinations never participate in durable delivery identity. */
export const museAttachmentContentIdentity = (attachments: readonly PreparedMuseAttachment[]) =>
  digest(encodeContentIdentities(attachments.map((attachment) => attachment.identity)));

const safeFilename = (filename: string) =>
  filename
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 128) || "attachment.bin";

/** Publish staged bytes once. Ambiguous append/write operations are never retried. */
export const materializeMuseAttachment = Effect.fn(
  "MuseAgentAttachmentTransfer.materializeMuseAttachment",
)(function* (binding: string, attachment: PreparedMuseAttachment) {
  if (attachment._tag === "Inline") return attachment.item;
  const transport = yield* Transport.MuseAgentTransport;
  const path = `workspace/uploads/t3-muse/${NodeCrypto.randomUUID()}/${safeFilename(attachment.filename)}`;
  const destination = `/${path}`;
  const temp = `${destination}.part`;
  const stat = (path: string) =>
    transport
      .request(binding, "fs.stat", { path })
      .pipe(
        Effect.flatMap((value) =>
          decodeStat(value).pipe(
            Effect.mapError(() => new MuseAgentAttachmentTransferError({ kind: "size_mismatch" })),
          ),
        ),
      );
  const exact = (value: typeof FileStat.Type) =>
    value.size === attachment.byteLength
      ? Effect.void
      : Effect.fail(new MuseAgentAttachmentTransferError({ kind: "size_mismatch" }));
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        for (
          let offset = 0;
          offset < attachment.byteLength;
          offset += MUSE_ATTACHMENT_LIMITS.chunkBytes
        ) {
          yield* transport.request(
            binding,
            "fs.write",
            {
              path: temp,
              data_base64: Buffer.from(
                attachment.bytes.subarray(offset, offset + MUSE_ATTACHMENT_LIMITS.chunkBytes),
              ).toString("base64"),
              overwrite: offset === 0,
              append: offset !== 0,
              create_parent: offset === 0,
            },
            true,
          );
        }
        yield* exact(yield* stat(temp));
        yield* transport
          .request(
            binding,
            "fs.rename",
            { source: temp, destination, create_parent: true, overwrite: true },
            true,
          )
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (error.kind !== "uncertain") return yield* error;
                // Official recovery requires the stage to be absent and the published file to have exact size.
                const staged = yield* transport
                  .request(binding, "fs.stat", { path: temp })
                  .pipe(Effect.exit);
                if (Exit.isSuccess(staged)) return yield* error;
                const failure = Cause.findErrorOption(staged.cause);
                if (Option.isNone(failure) || !isNotFound(failure.value.cause)) return yield* error;
                yield* exact(yield* stat(destination));
              }),
            ),
          );
        return {
          type: "file_ref" as const,
          mime_type: attachment.mimeType,
          filename: attachment.filename,
          path,
        };
      }),
    (_, exit) =>
      Exit.isFailure(exit)
        ? Effect.forEach([destination, temp], (path) =>
            transport
              .request(binding, "fs.delete", { path, recursive: false }, true)
              .pipe(Effect.ignore),
          )
        : Effect.void,
  ).pipe(
    Effect.catchTags({
      MuseAgentTransportError: (error) => Effect.fail(mapTransportError(error)),
    }),
  );
});

/** Accept only one decoded workspace segment sequence; URLs never become native filesystem paths. */
export const parseMuseSandboxAttachmentPath = (value: string): string | null => {
  if (!value.startsWith("sandbox://workspace/") || value.length > 4096) return null;
  const segments = value.slice("sandbox://workspace/".length).split("/");
  try {
    const decoded = segments.map((segment) => decodeURIComponent(segment));
    if (
      decoded.some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          // eslint-disable-next-line no-control-regex -- Reject controls at the sandbox URI boundary.
          /[\\/%?#\u0000-\u001f\u007f]/.test(segment),
      )
    )
      return null;
    return `workspace/${decoded.join("/")}`;
  } catch {
    return null;
  }
};

const ReadChunk = Schema.Struct({
  data_base64: Schema.String.check(
    Schema.isMaxLength(Math.ceil(MUSE_ATTACHMENT_LIMITS.chunkBytes / 3) * 4),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
  len: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MUSE_ATTACHMENT_LIMITS.chunkBytes }),
  ),
  eof: Schema.Boolean,
});
const decodeReadChunk = Schema.decodeUnknownEffect(ReadChunk);

/** Download into bounded memory; the caller commits bytes to the existing T3 attachment store. */
export const readMuseAttachment = Effect.fn("MuseAgentAttachmentTransfer.readMuseAttachment")(
  function* (input: {
    readonly binding: string;
    readonly sandboxPath: string;
    readonly maxBytes?: number;
  }) {
    const path = parseMuseSandboxAttachmentPath(input.sandboxPath);
    const limit = input.maxBytes ?? MUSE_ATTACHMENT_LIMITS.fileBytes;
    if (
      !path ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MUSE_ATTACHMENT_LIMITS.fileBytes
    )
      return yield* invalid();
    const transport = yield* Transport.MuseAgentTransport;
    const stat = yield* transport
      .request(input.binding, "fs.stat", { path })
      .pipe(
        Effect.flatMap((value) =>
          decodeStat(value).pipe(
            Effect.mapError(() => new MuseAgentAttachmentTransferError({ kind: "size_mismatch" })),
          ),
        ),
      );
    if (stat.size > limit)
      return yield* new MuseAgentAttachmentTransferError({ kind: "size_mismatch" });
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    let reads = 0;
    for (;;) {
      if (++reads > MUSE_ATTACHMENT_LIMITS.reads)
        return yield* new MuseAgentAttachmentTransferError({ kind: "transfer_failed" });
      // A final one-byte probe proves EOF when the native service didn't mark its last full chunk.
      const len = Math.min(MUSE_ATTACHMENT_LIMITS.chunkBytes, Math.max(1, stat.size - offset));
      const response = yield* transport.request(input.binding, "fs.read", { path, offset, len });
      const chunk = yield* decodeReadChunk(response).pipe(
        Effect.mapError(() => new MuseAgentAttachmentTransferError({ kind: "transfer_failed" })),
      );
      const decoded = Buffer.from(chunk.data_base64, "base64");
      if (
        decoded.length !== chunk.len ||
        decoded.length > len ||
        offset + decoded.length > stat.size ||
        decoded.toString("base64") !== chunk.data_base64 ||
        (!chunk.eof && chunk.len === 0)
      )
        return yield* new MuseAgentAttachmentTransferError({ kind: "size_mismatch" });
      bytes.set(decoded, offset);
      offset += decoded.length;
      if (chunk.eof) {
        if (offset !== stat.size)
          return yield* new MuseAgentAttachmentTransferError({ kind: "size_mismatch" });
        return { bytes, sha256: digest(bytes) };
      }
    }
  },
  Effect.catchTags({ MuseAgentTransportError: (error) => Effect.fail(mapTransportError(error)) }),
);
