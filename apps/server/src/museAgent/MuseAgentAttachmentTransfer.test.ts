// @effect-diagnostics nodeBuiltinImport:off -- Synthetic native file responses use bounded byte buffers only.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Transfer from "./MuseAgentAttachmentTransfer.ts";
import * as Transport from "./MuseAgentTransport.ts";

const binding = "a".repeat(64);
const fixture = () => {
  const calls: { method: string; params: Record<string, unknown>; write: boolean }[] = [];
  const files = new Map<string, Buffer>();
  let authority = binding;
  let writes = 0;
  let failAppend = false;
  let changeAccount = false;
  let invalidSize = false;
  let uncertainRename: "published" | "not_published" | undefined;
  const transport = Transport.MuseAgentTransport.of({
    acquireTurn: () => Effect.succeed(Effect.void),
    releaseOwned: () => Effect.void,
    connect: Effect.sync(() => authority),
    request: (target, method, params, write = false) =>
      Effect.gen(function* () {
        if (target !== authority)
          return yield* new Transport.MuseAgentTransportError({ kind: "account_changed" });
        calls.push({ method, params, write });
        const path = String(params.path);
        if (method === "fs.write") {
          writes++;
          const bytes = Buffer.from(String(params.data_base64), "base64");
          files.set(
            path,
            params.append ? Buffer.concat([files.get(path) ?? Buffer.alloc(0), bytes]) : bytes,
          );
          if (changeAccount) authority = "b".repeat(64);
          if (failAppend && params.append)
            return yield* new Transport.MuseAgentTransportError({ kind: "uncertain" });
          return {};
        }
        if (method === "fs.stat") {
          const bytes = files.get(path);
          if (!bytes)
            return yield* new Transport.MuseAgentTransportError({
              kind: "disconnected",
              cause: { kind: "not_found" },
            });
          return { kind: "file", size: bytes.length + (invalidSize ? 1 : 0) };
        }
        if (method === "fs.read") {
          const bytes = files.get(path)!;
          const offset = Number(params.offset);
          const data = bytes.subarray(offset, offset + Number(params.len));
          if (changeAccount) authority = "b".repeat(64);
          return {
            data_base64: data.toString("base64"),
            len: data.length,
            eof: offset + data.length >= bytes.length,
          };
        }
        if (method === "fs.rename") {
          if (uncertainRename !== "not_published") {
            files.set(String(params.destination), files.get(String(params.source))!);
            files.delete(String(params.source));
          }
          if (uncertainRename)
            return yield* new Transport.MuseAgentTransportError({ kind: "uncertain" });
          return {};
        }
        if (method === "fs.delete") {
          files.delete(path);
          return {};
        }
        return {};
      }),
    watch: () => Effect.succeed({ events: Stream.never, close: Effect.void }),
    connectionId: () => Effect.succeed("synthetic-connection"),
    cancelOwned: () => Effect.void,
    readAvatar: () => Effect.fail(new Transport.MuseAgentTransportError({ kind: "unavailable" })),
    openComputerStream: () => Effect.die("unused openComputerStream"),
    readComputerPreview: () => Effect.die("unused readComputerPreview"),
    registerTools: () => Effect.succeed({ accepted: 0, connectionId: "synthetic-connection" }),
    unregisterTools: () => Effect.void,
  });
  return {
    calls,
    files,
    transport,
    writes: () => writes,
    failAppend: () => {
      failAppend = true;
    },
    changeAccount: () => {
      changeAccount = true;
    },
    invalidSize: () => {
      invalidSize = true;
    },
    uncertainRename: (value: "published" | "not_published") => {
      uncertainRename = value;
    },
  };
};
const prepare = (bytes: Uint8Array, filename = "example.txt", inlineBudget?: number) =>
  Transfer.prepareMuseAttachment({
    attachment: {
      type: "file",
      id: "synthetic",
      name: filename,
      mimeType: "text/plain",
      sizeBytes: bytes.length,
    },
    bytes,
    ...(inlineBudget === undefined ? {} : { inlineBudget }),
  });
const run = <A, E>(
  f: ReturnType<typeof fixture>,
  effect: Effect.Effect<A, E, Transport.MuseAgentTransport>,
) => effect.pipe(Effect.provideService(Transport.MuseAgentTransport, f.transport));

it.effect(
  "keeps small files inline without native writes and binds identity to immutable content",
  () =>
    Effect.gen(function* () {
      const bytes = Buffer.from("synthetic attachment");
      const first = yield* prepare(bytes);
      const identity = Transfer.museAttachmentContentIdentity([first]);
      bytes.fill(0);
      const f = fixture();
      assert.deepStrictEqual(yield* run(f, Transfer.materializeMuseAttachment(binding, first)), {
        type: "file",
        mime_type: "text/plain",
        filename: "example.txt",
        data_base64: Buffer.from("synthetic attachment").toString("base64"),
      });
      assert.strictEqual(f.calls.length, 0);
      assert.notStrictEqual(
        Transfer.museAttachmentContentIdentity([yield* prepare(bytes)]),
        identity,
      );
    }),
);

it.effect(
  "uploads large files in exact bounded chunks and publishes a file_ref after size validation",
  () =>
    Effect.gen(function* () {
      const bytes = Buffer.alloc(Transfer.MUSE_ATTACHMENT_LIMITS.inlineBytes + 1, 3);
      const f = fixture();
      const prepared = yield* prepare(bytes, "../Example name.txt");
      const item = yield* run(f, Transfer.materializeMuseAttachment(binding, prepared));
      assert.strictEqual(item.type, "file_ref");
      if (item.type !== "file_ref") return;
      assert.match(item.path, /^workspace\/uploads\/t3-muse\/[a-f0-9-]{36}\/_Example_name\.txt$/);
      assert.strictEqual(item.filename, "../Example name.txt");
      const temp = `/${item.path}.part`;
      const writes = f.calls.filter((call) => call.method === "fs.write");
      assert.strictEqual(writes.length, 21);
      for (const [index, call] of writes.entries()) {
        assert.deepStrictEqual(call.params, {
          path: temp,
          data_base64: bytes
            .subarray(
              index * Transfer.MUSE_ATTACHMENT_LIMITS.chunkBytes,
              (index + 1) * Transfer.MUSE_ATTACHMENT_LIMITS.chunkBytes,
            )
            .toString("base64"),
          overwrite: index === 0,
          append: index !== 0,
          create_parent: index === 0,
        });
        assert.strictEqual(call.write, true);
      }
      assert.deepStrictEqual(f.calls.at(-2), {
        method: "fs.stat",
        params: { path: temp },
        write: false,
      });
      assert.deepStrictEqual(f.calls.at(-1), {
        method: "fs.rename",
        params: {
          source: temp,
          destination: `/${item.path}`,
          create_parent: true,
          overwrite: true,
        },
        write: true,
      });
      assert.deepStrictEqual(f.files.get(`/${item.path}`), bytes);
      assert.strictEqual(f.files.has(temp), false);
      assert.strictEqual(f.calls.filter((call) => call.method === "fs.delete").length, 0);
    }),
);

it.effect("uses separate cloud paths for uploads while retaining the same content identity", () =>
  Effect.gen(function* () {
    const prepared = yield* prepare(Buffer.from("synthetic attachment"), "example.txt", 0);
    const identity = Transfer.museAttachmentContentIdentity([prepared]);
    const f = fixture();
    const first = yield* run(f, Transfer.materializeMuseAttachment(binding, prepared));
    const second = yield* run(f, Transfer.materializeMuseAttachment(binding, prepared));
    assert.notStrictEqual(JSON.stringify(first), JSON.stringify(second));
    assert.strictEqual(Transfer.museAttachmentContentIdentity([prepared]), identity);
  }),
);

it.effect("never repeats ambiguous append and removes only its owned upload paths", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.failAppend();
    f.files.set("/workspace/unrelated.txt", Buffer.from("keep"));
    const prepared = yield* prepare(
      Buffer.alloc(Transfer.MUSE_ATTACHMENT_LIMITS.chunkBytes + 1),
      "example.txt",
      0,
    );
    const error = yield* Effect.flip(run(f, Transfer.materializeMuseAttachment(binding, prepared)));
    assert.strictEqual(error.kind, "uncertain");
    assert.strictEqual(f.writes(), 2);
    assert.strictEqual(f.calls.filter((call) => call.method === "fs.rename").length, 0);
    const write = f.calls[0]!;
    assert.deepStrictEqual(f.calls.at(-1), {
      method: "fs.delete",
      params: { path: write.params.path, recursive: false },
      write: true,
    });
    assert.deepStrictEqual([...f.files.keys()], ["/workspace/unrelated.txt"]);
  }),
);

it.effect("cleans the owned partial file when an upload is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = fixture();
      const entered = yield* Deferred.make<void>();
      const transport = {
        ...f.transport,
        request: (target, method, params, write) =>
          Effect.gen(function* () {
            const result = yield* f.transport.request(target, method, params, write);
            if (method === "fs.write") {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }
            return result;
          }),
      } satisfies Transport.MuseAgentTransport["Service"];
      const prepared = yield* prepare(Buffer.from("synthetic"), "example.txt", 0);
      const uploading = yield* Transfer.materializeMuseAttachment(binding, prepared).pipe(
        Effect.provideService(Transport.MuseAgentTransport, transport),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(uploading);
      assert.strictEqual(f.writes(), 1);
      assert.strictEqual(f.files.size, 0);
      assert.deepStrictEqual(f.calls.at(-1), {
        method: "fs.delete",
        params: { path: f.calls[0]?.params.path, recursive: false },
        write: true,
      });
    }),
  ),
);

it.effect("removes a published upload if interrupted before receiving its rename response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = fixture();
      f.files.set("/workspace/unrelated.txt", Buffer.from("keep"));
      const published = yield* Deferred.make<void>();
      const transport = {
        ...f.transport,
        request: (target, method, params, write) =>
          Effect.gen(function* () {
            const result = yield* f.transport.request(target, method, params, write);
            if (method === "fs.rename") {
              yield* Deferred.succeed(published, undefined);
              return yield* Effect.never;
            }
            return result;
          }),
      } satisfies Transport.MuseAgentTransport["Service"];
      const prepared = yield* prepare(Buffer.from("synthetic"), "example.txt", 0);
      const uploading = yield* Transfer.materializeMuseAttachment(binding, prepared).pipe(
        Effect.provideService(Transport.MuseAgentTransport, transport),
        Effect.forkScoped,
      );
      yield* Deferred.await(published);
      assert.strictEqual(f.files.size, 2);
      yield* Fiber.interrupt(uploading);
      assert.deepStrictEqual([...f.files.keys()], ["/workspace/unrelated.txt"]);
      const rename = f.calls.find((call) => call.method === "fs.rename")!;
      assert.deepStrictEqual(
        f.calls.filter((call) => call.method === "fs.delete").map((call) => call.params.path),
        [rename.params.destination, rename.params.source],
      );
      assert.strictEqual(f.calls.filter((call) => call.method === "fs.rename").length, 1);
    }),
  ),
);

it.effect("refuses publication on mismatched stage size", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.invalidSize();
    const prepared = yield* prepare(Buffer.from("synthetic"), "example.txt", 0);
    assert.strictEqual(
      (yield* Effect.flip(run(f, Transfer.materializeMuseAttachment(binding, prepared)))).kind,
      "size_mismatch",
    );
    assert.strictEqual(
      f.calls.some((call) => call.method === "fs.rename"),
      false,
    );
    assert.strictEqual(f.files.size, 0);
  }),
);

it.effect("does not append, rename or clean up in a replacement account", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.changeAccount();
    const prepared = yield* prepare(
      Buffer.alloc(Transfer.MUSE_ATTACHMENT_LIMITS.chunkBytes + 1),
      "example.txt",
      0,
    );
    assert.strictEqual(
      (yield* Effect.flip(run(f, Transfer.materializeMuseAttachment(binding, prepared)))).kind,
      "account_changed",
    );
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0]?.method, "fs.write");
  }),
);

it.effect(
  "recovers an ambiguous rename only when the stage is absent and destination size is exact",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.uncertainRename("published");
      const prepared = yield* prepare(Buffer.from("synthetic"), "example.txt", 0);
      const item = yield* run(f, Transfer.materializeMuseAttachment(binding, prepared));
      assert.strictEqual(item.type, "file_ref");
      assert.strictEqual(f.calls.filter((call) => call.method === "fs.rename").length, 1);
      assert.strictEqual(f.calls.filter((call) => call.method === "fs.delete").length, 0);
    }),
);

it.effect("does not replay a rename when its uncertain result left the stage present", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.uncertainRename("not_published");
    const prepared = yield* prepare(Buffer.from("synthetic"), "example.txt", 0);
    assert.strictEqual(
      (yield* Effect.flip(run(f, Transfer.materializeMuseAttachment(binding, prepared)))).kind,
      "uncertain",
    );
    assert.strictEqual(f.calls.filter((call) => call.method === "fs.rename").length, 1);
    assert.strictEqual(f.files.size, 0);
  }),
);

it.effect(
  "enforces explicit image/file limits and exact local byte counts before cloud writes",
  () =>
    Effect.gen(function* () {
      const image = Buffer.alloc(Transfer.MUSE_ATTACHMENT_LIMITS.inlineBytes + 1);
      const error = yield* Effect.flip(
        Transfer.prepareMuseAttachment({
          attachment: {
            type: "image",
            id: "image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: image.length,
          },
          bytes: image,
        }),
      );
      assert.strictEqual(error.kind, "invalid_attachment");
      assert.strictEqual(
        (yield* Effect.flip(
          Transfer.prepareMuseAttachment({
            attachment: {
              type: "file",
              id: "file",
              name: "file.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
            },
            bytes: Buffer.from("different size"),
          }),
        )).kind,
        "invalid_attachment",
      );
      assert.strictEqual(
        (yield* Effect.flip(prepare(Buffer.alloc(Transfer.MUSE_ATTACHMENT_LIMITS.fileBytes + 1))))
          .kind,
        "invalid_attachment",
      );
    }),
);

it.effect("decodes only safe literal sandbox workspace paths", () =>
  Effect.sync(() => {
    assert.strictEqual(
      Transfer.parseMuseSandboxAttachmentPath("sandbox://workspace/user/files/report%20one.pdf"),
      "workspace/user/files/report one.pdf",
    );
    for (const path of [
      "https://workspace/file",
      "sandbox://other/file",
      "sandbox://workspace/",
      "sandbox://workspace/a//b",
      "sandbox://workspace/a/../b",
      "sandbox://workspace/%2e%2e/b",
      "sandbox://workspace/%252e%252e/b",
      "sandbox://workspace/a%2Fb",
      "sandbox://workspace/a%5cb",
      "sandbox://workspace/file%00",
      "sandbox://workspace/file?secret=1",
      "sandbox://workspace/%zz",
    ])
      assert.strictEqual(Transfer.parseMuseSandboxAttachmentPath(path), null, path);
  }),
);

it.effect("downloads native received bytes with exact ranged reads and a content digest", () =>
  Effect.gen(function* () {
    const f = fixture();
    const bytes = Buffer.alloc(Transfer.MUSE_ATTACHMENT_LIMITS.chunkBytes + 3, 7);
    f.files.set("workspace/user/files/report one.pdf", bytes);
    const result = yield* run(
      f,
      Transfer.readMuseAttachment({
        binding,
        sandboxPath: "sandbox://workspace/user/files/report%20one.pdf",
      }),
    );
    assert.deepStrictEqual(result.bytes, bytes);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(f.calls, [
      { method: "fs.stat", params: { path: "workspace/user/files/report one.pdf" }, write: false },
      {
        method: "fs.read",
        params: {
          path: "workspace/user/files/report one.pdf",
          offset: 0,
          len: Transfer.MUSE_ATTACHMENT_LIMITS.chunkBytes,
        },
        write: false,
      },
      {
        method: "fs.read",
        params: {
          path: "workspace/user/files/report one.pdf",
          offset: Transfer.MUSE_ATTACHMENT_LIMITS.chunkBytes,
          len: 3,
        },
        write: false,
      },
    ]);
  }),
);

it.effect("refuses changed received file size or account before returning any attachment", () =>
  Effect.gen(function* () {
    for (const scenario of ["size", "account"] as const) {
      const f = fixture();
      f.files.set(
        "workspace/user/files/report.txt",
        Buffer.alloc(Transfer.MUSE_ATTACHMENT_LIMITS.chunkBytes + 1),
      );
      if (scenario === "size") f.invalidSize();
      else f.changeAccount();
      const error = yield* Effect.flip(
        run(
          f,
          Transfer.readMuseAttachment({
            binding,
            sandboxPath: "sandbox://workspace/user/files/report.txt",
          }),
        ),
      );
      assert.strictEqual(error.kind, scenario === "size" ? "size_mismatch" : "account_changed");
      assert.strictEqual(
        f.calls.every((call) => !call.write),
        true,
      );
    }
  }),
);

it.effect("rejects oversized received stat and unsafe paths before reading content", () =>
  Effect.gen(function* () {
    const f = fixture();
    assert.strictEqual(
      (yield* Effect.flip(
        run(
          f,
          Transfer.readMuseAttachment({ binding, sandboxPath: "sandbox://workspace/../private" }),
        ),
      )).kind,
      "invalid_attachment",
    );
    assert.strictEqual(f.calls.length, 0);
    const transport = {
      ...f.transport,
      request: () =>
        Effect.succeed({ kind: "file", size: Transfer.MUSE_ATTACHMENT_LIMITS.fileBytes + 1 }),
    };
    assert.strictEqual(
      (yield* Effect.flip(
        Transfer.readMuseAttachment({
          binding,
          sandboxPath: "sandbox://workspace/user/files/large",
        }).pipe(Effect.provideService(Transport.MuseAgentTransport, transport)),
      )).kind,
      "size_mismatch",
    );
  }),
);

it.effect("rejects dishonest base64 length, premature EOF and empty nonterminal chunks", () =>
  Effect.gen(function* () {
    for (const response of [
      { data_base64: Buffer.from("x").toString("base64"), len: 2, eof: true },
      { data_base64: Buffer.from("x").toString("base64"), len: 1, eof: true },
      { data_base64: "", len: 0, eof: false },
      { data_base64: "not base64!", len: 1, eof: true },
    ]) {
      const f = fixture();
      const transport = {
        ...f.transport,
        request: (_, method) =>
          Effect.succeed(method === "fs.stat" ? { kind: "file", size: 2 } : response),
      } satisfies Transport.MuseAgentTransport["Service"];
      yield* Effect.flip(
        Transfer.readMuseAttachment({
          binding,
          sandboxPath: "sandbox://workspace/user/files/report",
        }).pipe(Effect.provideService(Transport.MuseAgentTransport, transport)),
      );
    }
  }),
);

it.effect(
  "bounds received request count when a native reader returns tiny nonterminal chunks",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      let reads = 0;
      const transport = {
        ...f.transport,
        request: (_, method) =>
          Effect.sync(() => {
            if (method === "fs.stat") return { kind: "file", size: 1024 };
            reads++;
            return { data_base64: "eA==", len: 1, eof: false };
          }),
      } satisfies Transport.MuseAgentTransport["Service"];
      assert.strictEqual(
        (yield* Effect.flip(
          Transfer.readMuseAttachment({
            binding,
            sandboxPath: "sandbox://workspace/user/files/report",
          }).pipe(Effect.provideService(Transport.MuseAgentTransport, transport)),
        )).kind,
        "transfer_failed",
      );
      assert.strictEqual(reads, Transfer.MUSE_ATTACHMENT_LIMITS.reads);
    }),
);
