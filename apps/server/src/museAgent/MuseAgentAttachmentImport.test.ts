// @effect-diagnostics nodeBuiltinImport:off -- Real private fixture files prove metadata is published only after bounded persistence.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { importMuseAttachmentPresentation } from "./MuseAgentAttachmentImport.ts";
import { MUSE_ATTACHMENT_LIMITS } from "./MuseAgentAttachmentTransfer.ts";
import type { MuseAgentNativeEvent } from "./MuseAgentTransport.ts";

const binding = "a".repeat(64);
const threadId = ThreadId.make("muse-attachment-test");
const frame = (
  kind = "file",
  data: unknown = {
    file: { path: "sandbox://workspace/user/files/report.txt", label: "Report", missing: false },
  },
): MuseAgentNativeEvent => ({
  event: "delta.presentation",
  payload: {
    session_id: "primary",
    message_id: "presentation-1",
    host_message_id: "assistant-1",
    kind,
    data,
    transcript_surface: "main_chat",
  },
  meta: { seq: 3, ts_ms: 1234 },
});
const withDirectory = <A, E, R>(test: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-import-"))),
    test,
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
const fixture = (directory: string, nativeFrame = frame()) => {
  let bytes: Uint8Array = Buffer.from("synthetic report");
  const reads: { binding: string; sandboxPath: string; maxBytes?: number }[] = [];
  const input = {
    binding,
    threadId,
    sessionId: "primary",
    attachmentsDir: directory,
    frame: nativeFrame,
    readAttachment: (request: { binding: string; sandboxPath: string; maxBytes?: number }) =>
      Effect.sync(() => {
        reads.push(request);
        return { bytes, sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex") };
      }),
  };
  return {
    input,
    reads,
    setBytes: (next: Uint8Array) => {
      bytes = next;
    },
  };
};

it.effect("persists native files privately before exposing only T3 attachment metadata", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const f = fixture(directory);
      const result = yield* importMuseAttachmentPresentation(f.input);
      assert.ok(result);
      assert.strictEqual(result.nativeMessageId, "assistant-1");
      assert.strictEqual(result.failed, false);
      const attachment = result.attachments[0]!;
      assert.deepStrictEqual(Object.keys(attachment).sort(), [
        "id",
        "mimeType",
        "name",
        "sizeBytes",
        "type",
      ]);
      assert.strictEqual(attachment.type, "file");
      assert.strictEqual(attachment.name, "Report.txt");
      assert.strictEqual(attachment.mimeType, "text/plain");
      const path = resolveAttachmentPath({ attachmentsDir: directory, attachment });
      assert.ok(path);
      assert.strictEqual(
        yield* Effect.promise(() => NodeFSP.readFile(path, "utf8")),
        "synthetic report",
      );
      assert.strictEqual((yield* Effect.promise(() => NodeFSP.stat(path))).mode & 0o777, 0o600);
      assert.deepStrictEqual(f.reads, [
        {
          binding,
          sandboxPath: "sandbox://workspace/user/files/report.txt",
          maxBytes: MUSE_ATTACHMENT_LIMITS.fileBytes,
        },
      ]);
      assert.strictEqual(
        (yield* Effect.promise(() => NodeFSP.readdir(directory))).some((name) =>
          name.endsWith(".part"),
        ),
        false,
      );
    }),
  ),
);

it.effect(
  "reuses deterministic content IDs, repairs corrupted cache and distinguishes new bytes",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const f = fixture(directory);
        const first = yield* importMuseAttachmentPresentation(f.input);
        assert.ok(first);
        const again = yield* importMuseAttachmentPresentation(f.input);
        assert.deepStrictEqual(again?.attachments, first.attachments);
        const target = resolveAttachmentPath({
          attachmentsDir: directory,
          attachment: first.attachments[0]!,
        });
        assert.ok(target);
        yield* Effect.promise(() => NodeFSP.writeFile(target, "incorrect report"));
        const repaired = yield* importMuseAttachmentPresentation(f.input);
        assert.deepStrictEqual(repaired?.attachments, first.attachments);
        assert.strictEqual(
          yield* Effect.promise(() => NodeFSP.readFile(target, "utf8")),
          "synthetic report",
        );
        f.setBytes(Buffer.from("new report"));
        const changed = yield* importMuseAttachmentPresentation(f.input);
        assert.notStrictEqual(changed?.attachments[0]?.id, first.attachments[0]?.id);
      }),
    ),
);

it.effect("keeps symlink escapes unavailable without overwriting their foreign target", () =>
  withDirectory((root) =>
    Effect.gen(function* () {
      const directory = NodePath.join(root, "attachments");
      const f = fixture(directory);
      const first = yield* importMuseAttachmentPresentation(f.input);
      assert.ok(first);
      const target = resolveAttachmentPath({
        attachmentsDir: directory,
        attachment: first.attachments[0]!,
      });
      assert.ok(target);
      const outside = NodePath.join(root, "outside.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(outside, "foreign content"));
      yield* Effect.promise(() => NodeFSP.unlink(target));
      yield* Effect.promise(() => NodeFSP.symlink(outside, target));
      const result = yield* importMuseAttachmentPresentation(f.input);
      assert.strictEqual(result?.failed, true);
      assert.deepStrictEqual(result?.attachments, []);
      assert.strictEqual(
        yield* Effect.promise(() => NodeFSP.readFile(outside, "utf8")),
        "foreign content",
      );
    }),
  ),
);

it.effect("accepts only verified same-session main-chat media presentations", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      for (const nativeFrame of [
        { ...frame(), event: "message.assistant" },
        {
          ...frame(),
          payload: { ...(frame().payload as Record<string, unknown>), session_id: "foreign" },
        },
        {
          ...frame(),
          payload: { ...(frame().payload as Record<string, unknown>), stream_lane: "subagent" },
        },
        {
          ...frame(),
          payload: {
            ...(frame().payload as Record<string, unknown>),
            transcript_surface: "activity",
          },
        },
        {
          ...frame(),
          payload: {
            ...(frame().payload as Record<string, unknown>),
            message_id: null,
            host_message_id: null,
          },
        },
        frame("html", { html: "<p>ignored</p>" }),
      ]) {
        const f = fixture(directory, nativeFrame);
        assert.strictEqual(yield* importMuseAttachmentPresentation(f.input), null);
        assert.strictEqual(f.reads.length, 0);
      }
    }),
  ),
);

it.effect(
  "does not download missing or unsafe native paths and preserves other valid attachments",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const f = fixture(
          directory,
          frame("image", {
            images: [
              { path: "sandbox://workspace/a/../private", label: "Unsafe", missing: false },
              { path: "sandbox://workspace/missing.png", label: "Missing", missing: true },
              {
                path: "sandbox://workspace/user/files/report.txt",
                label: "Report",
                missing: false,
              },
            ],
          }),
        );
        const result = yield* importMuseAttachmentPresentation(f.input);
        assert.strictEqual(result?.failed, true);
        assert.strictEqual(result?.attachments.length, 1);
        assert.strictEqual(f.reads.length, 1);
      }),
    ),
);

it.effect("sniffs actual image bytes and treats active content as a downloadable file", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const f = fixture(
        directory,
        frame("image", {
          images: [
            {
              path: "sandbox://workspace/user/files/picture.png",
              label: "Picture.png",
              missing: false,
              mime: "image/png",
            },
          ],
        }),
      );
      f.setBytes(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWhUAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const image = yield* importMuseAttachmentPresentation(f.input);
      assert.strictEqual(image?.attachments[0]?.type, "image");
      assert.strictEqual(image?.attachments[0]?.mimeType, "image/png");
      const html = fixture(
        directory,
        frame("image", {
          images: [
            {
              path: "sandbox://workspace/user/files/image.svg",
              label: "Image.svg",
              missing: false,
              mime: "image/svg+xml",
            },
          ],
        }),
      );
      html.setBytes(Buffer.from("<svg><script>unsafe()</script></svg>"));
      const file = yield* importMuseAttachmentPresentation(html.input);
      assert.strictEqual(file?.attachments[0]?.type, "file");
      assert.strictEqual(file?.attachments[0]?.mimeType, "application/octet-stream");
    }),
  ),
);

it.effect(
  "imports exact native audio, video and slides schemas without guessing control payloads",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        for (const [kind, data, mime] of [
          [
            "audio",
            {
              audio: { path: "sandbox://workspace/user/audio.wav", label: "Audio", missing: false },
            },
            "audio/wav",
          ],
          [
            "video",
            {
              videos: [
                { path: "sandbox://workspace/user/video.mp4", label: "Video", missing: false },
              ],
            },
            "video/mp4",
          ],
          [
            "slides",
            {
              deck: { path: "sandbox://workspace/user/slides.json", label: "Deck", missing: false },
              slug: "deck",
            },
            "application/json",
          ],
        ] as const) {
          const f = fixture(directory, frame(kind, data));
          const result = yield* importMuseAttachmentPresentation(f.input);
          assert.strictEqual(result?.attachments[0]?.type, "file");
          assert.strictEqual(result?.attachments[0]?.mimeType, mime);
          assert.strictEqual(result?.failed, false);
        }
      }),
    ),
);

it.effect("keeps failed downloads unavailable and rejects a fabricated content digest", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const f = fixture(directory);
      const unavailable = yield* importMuseAttachmentPresentation({
        ...f.input,
        readAttachment: () => Effect.fail("synthetic account change"),
      });
      assert.strictEqual(unavailable?.failed, true);
      assert.deepStrictEqual(unavailable?.attachments, []);
      const invalid = yield* importMuseAttachmentPresentation({
        ...f.input,
        readAttachment: () =>
          Effect.succeed({ bytes: Buffer.from("synthetic"), sha256: "0".repeat(64) }),
      });
      assert.strictEqual(invalid?.failed, true);
      assert.deepStrictEqual(invalid?.attachments, []);
      assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(directory)), []);
    }),
  ),
);
