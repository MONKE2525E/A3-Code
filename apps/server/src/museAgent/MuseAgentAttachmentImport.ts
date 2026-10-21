// @effect-diagnostics nodeBuiltinImport:off -- Persist native attachment bytes only inside the server-owned attachment directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  attachmentFileExtension,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import {
  MUSE_ATTACHMENT_LIMITS,
  parseMuseSandboxAttachmentPath,
} from "./MuseAgentAttachmentTransfer.ts";
import type { MuseAgentNativeEvent } from "./MuseAgentTransport.ts";

const NativeId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const NativeMedia = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(4096)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  missing: Schema.optionalKey(Schema.Boolean),
  mime: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
});
const Gallery = Schema.Array(NativeMedia).check(Schema.isMinLength(1), Schema.isMaxLength(12));
const MediaPresentation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file"), data: Schema.Struct({ file: NativeMedia }) }),
  Schema.Struct({ kind: Schema.Literal("image"), data: Schema.Struct({ images: Gallery }) }),
  Schema.Struct({ kind: Schema.Literal("video"), data: Schema.Struct({ videos: Gallery }) }),
  Schema.Struct({ kind: Schema.Literal("audio"), data: Schema.Struct({ audio: NativeMedia }) }),
  Schema.Struct({
    kind: Schema.Literal("slides"),
    data: Schema.Struct({ deck: NativeMedia, slug: Schema.String.check(Schema.isMinLength(1)) }),
  }),
]);
const Presentation = Schema.Struct({
  session_id: NativeId,
  message_id: Schema.optionalKey(Schema.NullOr(NativeId)),
  host_message_id: Schema.optionalKey(Schema.NullOr(NativeId)),
  stream_lane: Schema.optionalKey(Schema.String),
  transcript_surface: Schema.optionalKey(Schema.String),
  kind: Schema.String,
  data: Schema.Unknown,
});
const decodePresentation = Schema.decodeUnknownOption(Presentation);
const decodeMedia = Schema.decodeUnknownOption(MediaPresentation);
const decodeData = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAttachment = Schema.decodeUnknownSync(ChatAttachment);

export interface ImportedMuseAttachments {
  readonly nativeMessageId: string;
  readonly attachments: readonly ChatAttachment[];
  readonly failed: boolean;
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  const prefix = Buffer.from(bytes.subarray(0, 12));
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(prefix.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
}
const fileMimes: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

/** Parse the official native presentations and commit files before returning public metadata. */
export const importMuseAttachmentPresentation = <E>(input: {
  readonly binding: string;
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly attachmentsDir: string;
  readonly frame: MuseAgentNativeEvent;
  readonly readAttachment: (request: {
    readonly binding: string;
    readonly sandboxPath: string;
    readonly maxBytes?: number;
  }) => Effect.Effect<{ readonly bytes: Uint8Array; readonly sha256: string }, E>;
}): Effect.Effect<ImportedMuseAttachments | null> =>
  Effect.gen(function* () {
    if (input.frame.event !== "delta.presentation") return null;
    const parsed = decodePresentation(input.frame.payload);
    if (parsed._tag === "None") return null;
    const payload = parsed.value;
    if (
      payload.session_id !== input.sessionId ||
      payload.stream_lane === "subagent" ||
      (payload.transcript_surface !== undefined && payload.transcript_surface !== "main_chat")
    )
      return null;
    const nativeMessageId = payload.host_message_id ?? payload.message_id;
    if (!nativeMessageId || !["file", "image", "video", "audio", "slides"].includes(payload.kind))
      return null;
    let data = payload.data;
    if (typeof data === "string") {
      if (data.length > 65536) return { nativeMessageId, attachments: [], failed: true };
      const decoded = decodeData(data);
      if (decoded._tag === "None") return { nativeMessageId, attachments: [], failed: true };
      data = decoded.value;
    }
    const media = decodeMedia({ kind: payload.kind, data });
    if (media._tag === "None") return { nativeMessageId, attachments: [], failed: true };
    const value = media.value;
    const items =
      value.kind === "image"
        ? value.data.images
        : value.kind === "video"
          ? value.data.videos
          : value.kind === "file"
            ? [value.data.file]
            : value.kind === "audio"
              ? [value.data.audio]
              : [value.data.deck];
    const attachments: ChatAttachment[] = [];
    let remaining = MUSE_ATTACHMENT_LIMITS.totalBytes;
    let failed = false;
    for (const item of items.slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS)) {
      const path = parseMuseSandboxAttachmentPath(item.path);
      if (!path || item.missing || remaining < 1) {
        failed = true;
        continue;
      }
      const downloaded = yield* input
        .readAttachment({
          binding: input.binding,
          sandboxPath: item.path,
          maxBytes: Math.min(remaining, MUSE_ATTACHMENT_LIMITS.fileBytes),
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(downloaded)) {
        failed = true;
        continue;
      }
      const content = downloaded.value;
      remaining -= content.bytes.length;
      const stored = yield* Effect.tryPromise({
        try: async () => {
          const snapshot = Buffer.from(content.bytes);
          if (
            content.bytes.length < 1 ||
            remaining < 0 ||
            content.bytes.length > MUSE_ATTACHMENT_LIMITS.fileBytes ||
            NodeCrypto.createHash("sha256").update(snapshot).digest("hex") !== content.sha256
          )
            throw new Error("attachment_content_refused");
          const imageMime = value.kind === "image" ? sniffImageMime(snapshot) : undefined;
          if (imageMime && content.bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
            throw new Error("attachment_image_limit");
          const extension = NodePath.posix.extname(path).toLowerCase();
          const label = item.label.trim().replace(/[\\/]/g, "_");
          const name = (
            !NodePath.posix.extname(label) && /^\.[a-z0-9]{1,10}$/.test(extension)
              ? label + extension
              : label
          ).slice(0, 255);
          const mimeType = imageMime ?? fileMimes[extension] ?? "application/octet-stream";
          const baseId = createDeterministicAttachmentId(
            input.threadId,
            encodeIdentity([input.binding, path, content.sha256]),
          );
          if (!baseId) throw new Error("attachment_identity_refused");
          const attachment = decodeAttachment({
            type: imageMime ? "image" : "file",
            id: imageMime ? baseId : `${baseId}-${attachmentFileExtension(name).slice(1)}`,
            name,
            mimeType,
            sizeBytes: content.bytes.length,
          });
          await NodeFSP.mkdir(input.attachmentsDir, { recursive: true, mode: 0o700 });
          const directory = await NodeFSP.realpath(input.attachmentsDir);
          const target = resolveAttachmentPath({ attachmentsDir: directory, attachment });
          if (!target || !target.startsWith(directory + NodePath.sep))
            throw new Error("attachment_path_refused");
          const existing = await NodeFSP.lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (existing && (!existing.isFile() || existing.isSymbolicLink()))
            throw new Error("attachment_path_refused");
          if (existing?.size === content.bytes.length) {
            const file = await NodeFSP.open(
              target,
              NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
            );
            try {
              const metadata = await file.stat();
              if (!metadata.isFile() || metadata.size !== snapshot.length)
                throw new Error("attachment_cache_changed");
              const bytes = Buffer.alloc(snapshot.length + 1);
              let length = 0;
              while (length < bytes.length) {
                const chunk = await file.read(bytes, length, bytes.length - length, length);
                if (!chunk.bytesRead) break;
                length += chunk.bytesRead;
              }
              if (
                length === snapshot.length &&
                NodeCrypto.createHash("sha256").update(bytes.subarray(0, length)).digest("hex") ===
                  content.sha256
              )
                return attachment;
            } finally {
              await file.close();
            }
          }
          const part = target + "." + NodeCrypto.randomUUID() + ".part";
          try {
            await NodeFSP.writeFile(part, snapshot, { flag: "wx", mode: 0o600 });
            await NodeFSP.rename(part, target);
          } finally {
            await NodeFSP.rm(part, { force: true });
          }
          return attachment;
        },
        catch: () => undefined,
      }).pipe(Effect.exit);
      if (Exit.isFailure(stored)) failed = true;
      else if (!attachments.some((attachment) => attachment.id === stored.value.id))
        attachments.push(stored.value);
    }
    return { nativeMessageId, attachments, failed };
  });
