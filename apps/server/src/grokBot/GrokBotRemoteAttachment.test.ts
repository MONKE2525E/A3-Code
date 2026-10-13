import { assert, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as Native from "./GrokBotNativeService.ts";

const fixture = Effect.gen(function* () {
  const hostPath = yield* Path.Path;
  const reads: unknown[] = [];
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const directories: string[] = [];
  const remote = {
    active: "fixture",
    switchAccountAfterRead: false,
    bytes: new TextEncoder().encode("abc"),
    totalSizes: [] as number[],
  };
  const filesystem = FileSystem.makeNoop({
    readFileString: () =>
      Effect.succeed(
        JSON.stringify({
          version: 1,
          "cursor-accounts": JSON.stringify({
            active: remote.active,
            accounts: {
              fixture: {
                "cursor-access-token":
                  "plaintext:v1:" + Buffer.from("fixture-token").toString("base64"),
              },
              other: {
                "cursor-access-token":
                  "plaintext:v1:" + Buffer.from("other-fixture-token").toString("base64"),
              },
            },
          }),
        }),
      ),
    makeDirectory: (path) =>
      Effect.sync(() => {
        directories.push(path);
      }),
    writeFile: (path, bytes) =>
      Effect.sync(() => {
        writes.push({ path, bytes });
      }),
    rename: () => Effect.void,
    remove: () => Effect.void,
  });
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected attachment request");
      const body = JSON.parse(new TextDecoder().decode(request.body.body)) as {
        path: string;
        offset: string;
        length: number;
      };
      reads.push(body);
      if (remote.switchAccountAfterRead) remote.active = "other";
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            totalSize: String(remote.totalSizes.shift() ?? remote.bytes.byteLength),
            data: Buffer.from(
              remote.bytes.subarray(Number(body.offset), Number(body.offset) + body.length),
            ).toString("base64"),
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
  const context = yield* Layer.build(
    Native.layer.pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, filesystem)),
      Layer.provide(Layer.succeed(Path.Path, hostPath)),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(
        Layer.mock(ProcessRunner.ProcessRunner)({ run: () => Effect.die("No native calls") }),
      ),
      Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
      Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "C:\\Users\\fixture")),
      Layer.provide(Layer.succeed(HostProcess.Environment, {})),
    ),
  );
  const service = Context.get(context, Native.GrokBotNativeService);
  const binding = yield* service.accountBinding;
  return { service, binding, hostPath, reads, writes, directories, remote };
});

it.effect("downloads a POSIX native attachment with an injected Windows host path service", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    const remote = "/home/box/agent-data/agents/bot-1/attachments/report.txt";
    // A rooted local fixture works with both path services; all filesystem operations are mocked.
    const attachments = yield* h.service.receiveAttachments({
      binding: h.binding,
      botId: "bot-1",
      threadId: "thread-1",
      entryId: "entry-1",
      attachmentsDir: "/fixture/attachments",
      attachments: [{ url: "file://" + remote, image: false }],
    });
    assert.equal(attachments[0]?.name, "report.txt");
    assert.equal(attachments[0]?.mimeType, "text/plain");
    assert.equal(attachments[0]?.sizeBytes, 3);
    assert.deepEqual(h.reads, [
      { path: remote, offset: "0", length: 0 },
      { path: remote, offset: "0", length: 3 },
    ]);
    assert.equal(new TextDecoder().decode(h.writes[0]?.bytes), "abc");
    assert.equal(h.directories[0], h.hostPath.dirname(h.writes[0]!.path));
  }).pipe(Effect.scoped, Effect.provide(NodePath.layerWin32)),
);

it.effect.each([
  "file:///home/box/agent-data/agents/other/attachments/report.txt",
  "file:///home/box/agent-data/agents/bot-1/attachments/nested%2Freport.txt",
  "file:///home/box/agent-data/agents/bot-1/attachments/%2E%2E%2Freport.txt",
  "https://fixture.invalid/report.txt",
])("refuses an out-of-scope remote attachment on a Windows host: %s", (url) =>
  Effect.gen(function* () {
    const h = yield* fixture;
    const result = yield* h.service
      .receiveAttachments({
        binding: h.binding,
        botId: "bot-1",
        threadId: "thread-1",
        entryId: "entry-1",
        attachmentsDir: "/fixture/attachments",
        attachments: [{ url, image: false }],
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.writes, []);
  }).pipe(Effect.scoped, Effect.provide(NodePath.layerWin32)),
);

it.effect.each(
  ["agent-data", "sand-data"].flatMap((root) =>
    ["attachments", "assets"].flatMap((directory) =>
      ["report.txt", "nested/report.txt", "nested/Report %231 %E2%98%83.txt"].map((name) => ({
        url: `file:///home/box/${root}/agents/bot-1/${directory}/${name}`,
        path: `/home/box/${root}/agents/bot-1/${directory}/${decodeURIComponent(name)}`,
      })),
    ),
  ),
)(
  "reads same-bot media under either native root with safe nested and encoded names: $url",
  ({ url, path }) =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const attachments = yield* h.service.receiveAttachments({
        binding: h.binding,
        botId: "bot-1",
        threadId: "thread-1",
        entryId: "entry-1",
        attachmentsDir: "/fixture/attachments",
        attachments: [{ url, image: false }],
      });
      assert.equal(attachments[0]?.name, path.slice(path.lastIndexOf("/") + 1));
      assert.equal(attachments[0]?.sizeBytes, 3);
      assert.deepEqual(h.reads, [
        { path, offset: "0", length: 0 },
        { path, offset: "0", length: 3 },
      ]);
      assert.equal(new TextDecoder().decode(h.writes[0]?.bytes), "abc");
    }).pipe(Effect.scoped, Effect.provide(NodePath.layerWin32)),
);

it.effect.each(["agent-data", "sand-data"])(
  "reads a shipped user-upload absolute POSIX path from %s without host filesystem reads",
  (root) =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const path = `/home/box/${root}/agents/bot-1/attachments/batch/My photo.png`;
      const attachments = yield* h.service.receiveAttachments({
        binding: h.binding,
        botId: "bot-1",
        threadId: "thread-1",
        entryId: "entry-1",
        attachmentsDir: "/fixture/attachments",
        attachments: [{ url: path, name: "Original photo.png", image: true }],
      });
      assert.equal(attachments[0]?.type, "image");
      assert.equal(attachments[0]?.mimeType, "image/png");
      assert.equal(attachments[0]?.name, "Original photo.png");
      assert.deepEqual(h.reads, [
        { path, offset: "0", length: 0 },
        { path, offset: "0", length: 3 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodePath.layerWin32)),
);

it.effect.each([
  "file:///home/box/sand-data/agents/other/assets/report.txt",
  "file:///home/box/sand-data/agents/bot-1/other/report.txt",
  "file:///home/box/other-data/agents/bot-1/assets/report.txt",
  "file:///etc/passwd",
  "/etc/passwd",
  "file:///home/box/sand-data/agents/bot-1/assets/../attachments/report.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/%2e%2e/attachments/report.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/%252e%252e/report.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/nested%252freport.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/nested%5creport.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/report%00.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/report%2500.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/report%0a.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/%zz.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/./report.txt",
  "file:///home/box/sand-data/agents/bot-1/assets//report.txt",
  "file:///home/box/sand-data/agents/bot-1/assets/",
  "file:///home/box/sand-data/agents/bot-1/assets",
  "file:///home/box/sand-data/agents/bot-1/assets/report.txt?download=1",
  "file:///home/box/sand-data/agents/bot-1/assets/report.txt#preview",
  "file://localhost/home/box/sand-data/agents/bot-1/assets/report.txt",
  "file://remote/home/box/sand-data/agents/bot-1/assets/report.txt",
  "file:////home/box/sand-data/agents/bot-1/assets/report.txt",
  "/home/box/sand-data/agents/bot-1/assets/../../other/assets/report.txt",
  "/home/box/sand-data/agents/bot-1/assets/nested/../../../other/assets/report.txt",
  "/home/box/sand-data/agents/bot-1/assets/%2e%2e/report.txt",
  "/home/box/sand-data/agents/bot-1/assets/nested\\report.txt",
  "/home/box/sand-data/agents/bot-1/assets/report\0.txt",
])("rejects root escapes and ambiguous native paths before any attachment read: %s", (url) =>
  Effect.gen(function* () {
    const h = yield* fixture;
    const result = yield* h.service
      .receiveAttachments({
        binding: h.binding,
        botId: "bot-1",
        threadId: "thread-1",
        entryId: "entry-1",
        attachmentsDir: "/fixture/attachments",
        attachments: [{ url, image: false }],
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.writes, []);
  }).pipe(Effect.scoped, Effect.provide(NodePath.layerWin32)),
);

it.effect.each(["before", "during"] as const)(
  "rejects a changed account %s media import without writing downloaded bytes",
  (when) =>
    Effect.gen(function* () {
      const h = yield* fixture;
      if (when === "before") h.remote.active = "other";
      else h.remote.switchAccountAfterRead = true;
      const result = yield* h.service
        .receiveAttachments({
          binding: h.binding,
          botId: "bot-1",
          threadId: "thread-1",
          entryId: "entry-1",
          attachmentsDir: "/fixture/attachments",
          attachments: [
            { url: "file:///home/box/sand-data/agents/bot-1/assets/report.txt", image: false },
          ],
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(h.reads.length, when === "before" ? 0 : 1);
      assert.deepEqual(h.writes, []);
    }).pipe(Effect.scoped, Effect.provide(NodePath.layerWin32)),
);

it.effect.each([{ totalSizes: [4, 4] }, { totalSizes: [3, 4] }])(
  "rejects incomplete chunks and changed total sizes without writing partial files: %s",
  ({ totalSizes }) =>
    Effect.gen(function* () {
      const h = yield* fixture;
      h.remote.totalSizes = [...totalSizes];
      const result = yield* h.service
        .receiveAttachments({
          binding: h.binding,
          botId: "bot-1",
          threadId: "thread-1",
          entryId: "entry-1",
          attachmentsDir: "/fixture/attachments",
          attachments: [
            { url: "file:///home/box/sand-data/agents/bot-1/assets/report.txt", image: false },
          ],
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(h.reads.length, 2);
      assert.deepEqual(h.writes, []);
    }).pipe(Effect.scoped, Effect.provide(NodePath.layerWin32)),
);
