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
  const filesystem = FileSystem.makeNoop({
    readFileString: () =>
      Effect.succeed(
        JSON.stringify({
          version: 1,
          "cursor-accounts": JSON.stringify({
            active: "fixture",
            accounts: {
              fixture: {
                "cursor-access-token":
                  "plaintext:v1:" + Buffer.from("fixture-token").toString("base64"),
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
      const body: unknown = JSON.parse(new TextDecoder().decode(request.body.body));
      reads.push(body);
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({ totalSize: "3", data: Buffer.from("abc").toString("base64") }),
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
  return { service, binding, hostPath, reads, writes, directories };
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
