import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build Chromium Safe Storage fixtures for the native adapter.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Connect from "./ConnectJsonStream.ts";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpClientError from "effect/http/HttpClientError";
import * as ProcessRunner from "../processRunner.ts";
import * as Native from "./GrokBotNativeService.ts";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import type { ChatFileAttachment } from "@t3tools/contracts";

const encodeSecret = (value: string) => {
  const cipher = NodeCrypto.createCipheriv(
    "aes-128-cbc",
    NodeCrypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"),
    Buffer.alloc(16, 32),
  );
  return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]).toString(
    "base64",
  );
};
const fixture = Effect.gen(function* () {
  const isolated = (yield* HostProcess.Environment).T3CODE_TEST_ISOLATED_PROFILE === "1";
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-native-test-" });
  const appData = `${root}/.config/Grok Bot`;
  yield* fs.makeDirectory(appData, { recursive: true });
  const secretFile = `${appData}/sand-secrets.json`;
  const secrets = {
    version: 1,
    "cursor-accounts": JSON.stringify({
      active: "selected",
      accounts: {
        selected: { "cursor-access-token": encodeSecret("selected-token") },
        other: { "cursor-access-token": encodeSecret("other-token") },
      },
    }),
  };
  yield* fs.writeFileString(secretFile, JSON.stringify(secrets));
  const requests: {
    method: string;
    body: unknown;
    authorization: string | undefined;
    url: string;
  }[] = [];
  const remote = {
    roster: {
      agents: [
        {
          id: "profile-record-1",
          agentId: "bot-1",
          name: "Builder",
          ownerDisplayName: "private profile",
        },
      ],
    } as unknown,
    statuses: { statuses: [{ agentId: "bot-1" }] } as unknown,
    transcript: { entries: [] } as unknown,
    status: 200,
    failTransport: false,
    watchStatus: 200,
    attempts: 0,
    rawBody: undefined as string | undefined,
    accountAfterResponse: undefined as "other" | "signed_out" | undefined,
    responses: {} as Record<string, unknown>,
    uploadReceipts: [] as unknown[],
    attachmentBytes: new Uint8Array(),
    attachmentTotalSize: undefined as number | undefined,
    stream: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    streamSource: undefined as Stream.Stream<Uint8Array<ArrayBufferLike>> | undefined,
    cancelled: false,
  };
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      remote.attempts++;
      if (remote.failTransport)
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("private selected-token"),
            }),
          }),
        );
      if (remote.accountAfterResponse !== undefined) {
        const active = remote.accountAfterResponse === "signed_out" ? null : "other";
        remote.accountAfterResponse = undefined;
        yield* fs
          .writeFileString(
            secretFile,
            JSON.stringify({
              version: 1,
              "cursor-accounts": JSON.stringify({
                active,
                accounts: {
                  other: { "cursor-access-token": encodeSecret("other-token") },
                },
              }),
            }),
          )
          .pipe(Effect.orDie);
      }
      const streamBody =
        remote.streamSource === undefined
          ? undefined
          : yield* Stream.toReadableStreamEffect(remote.streamSource);
      return yield* Effect.sync(() => {
        const method = request.url.split("/").at(-1) ?? "";
        requests.push({
          method,
          url: request.url,
          authorization: request.headers.authorization,
          body:
            request.body._tag === "Uint8Array"
              ? (JSON.parse(
                  new TextDecoder().decode(
                    method === "WatchGrokBotTranscripts"
                      ? request.body.body.subarray(5)
                      : request.body.body,
                  ),
                ) as unknown)
              : null,
        });
        const downloadInput = requests.at(-1)?.body as
          | { offset?: string; length?: number }
          | undefined;
        const body =
          method === "ReadGrokBotAgentAttachmentChunk"
            ? {
                data: Buffer.from(
                  remote.attachmentBytes.subarray(
                    Number(downloadInput?.offset ?? 0),
                    Number(downloadInput?.offset ?? 0) + (downloadInput?.length ?? 0),
                  ),
                ).toString("base64"),
                totalSize: String(remote.attachmentTotalSize ?? remote.attachmentBytes.byteLength),
              }
            : method === "UploadGrokBotAgentAttachmentChunk" && remote.uploadReceipts.length > 0
              ? remote.uploadReceipts.shift()
              : method in remote.responses
                ? remote.responses[method]
                : method === "ListGrokBotAgents"
                  ? remote.roster
                  : method === "ListGrokBotAgentStatuses"
                    ? remote.statuses
                    : remote.transcript;
        if (method === "WatchGrokBotTranscripts" || method === "events") {
          let emitted = false;
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              streamBody ??
                new ReadableStream({
                  pull(controller) {
                    if (!emitted) {
                      emitted = true;
                      controller.enqueue(remote.stream);
                    }
                  },
                  cancel() {
                    remote.cancelled = true;
                  },
                }),
              {
                status: remote.watchStatus,
                headers: {
                  "content-type":
                    method === "events" ? "text/event-stream" : "application/connect+json",
                },
              },
            ),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(remote.rawBody ?? JSON.stringify(body), {
            status: remote.status,
            headers: { "content-type": "application/json" },
          }),
        );
      });
    }),
  );
  const layer = Native.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(
      Layer.mock(ProcessRunner.ProcessRunner)({
        run: () => Effect.die("Linux v10 must not request a keychain"),
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, root)),
    Layer.provide(
      Layer.succeed(
        HostProcess.Environment,
        isolated
          ? {
              XDG_CONFIG_HOME: `${root}/isolated-config`,
              T3CODE_GROK_BOT_APP_DATA_DIR: appData,
            }
          : {},
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
  );
  const service = Context.get(yield* Layer.build(layer), Native.GrokBotNativeService);
  return { service, requests, remote, fs, secretFile, secrets, root };
});

it.layer(NodeServices.layer)("Independent desktop profile", (it) => {
  it.effect("reads the existing Grok Bot account without sharing the T3 profile", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture.pipe(
        Effect.provideService(HostProcess.Environment, { T3CODE_TEST_ISOLATED_PROFILE: "1" }),
      );
      const binding = yield* service.accountBinding;
      assert.isString(binding);
      assert.equal((yield* service.listForBinding(binding))[0]?.id, "bot-1");
    }).pipe(Effect.scoped),
  );
});

const attachmentFixture = Effect.gen(function* () {
  const test = yield* fixture;
  const binding = yield* test.service.accountBinding;
  const attachment: ChatFileAttachment = {
    type: "file",
    id: createAttachmentId("upload-test", "txt")!,
    name: "proof.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
  };
  const filePath = resolveAttachmentPath({ attachmentsDir: test.root, attachment })!;
  yield* test.fs.writeFileString(filePath, "proof");
  return {
    ...test,
    filePath,
    input: {
      binding,
      botId: "bot-1",
      sessionId: "",
      messageId: "message-1",
      attachmentsDir: test.root,
      attachments: [attachment],
    },
  };
});

it.layer(NodeServices.layer)("Native attachment delivery", (it) => {
  it.effect("uploads bytes and reuses the content-bound upload identity on retry", () =>
    Effect.gen(function* () {
      const test = yield* attachmentFixture;
      test.remote.responses.UploadGrokBotAgentAttachmentChunk = {
        receivedBytes: "5",
        path: "/uploads/proof.txt",
      };
      assert.deepEqual(yield* test.service.uploadAttachments(test.input), {
        paths: ["/uploads/proof.txt"],
        names: ["proof.txt"],
      });
      yield* test.service.uploadAttachments(test.input);
      const first = test.requests[0]!.body;
      assert.deepEqual(test.requests[1]!.body, first);
      assert.equal(test.requests[0]!.method, "UploadGrokBotAgentAttachmentChunk");
      assert.include(first, {
        data: Buffer.from("proof").toString("base64"),
        offset: "0",
        totalSize: "5",
        fileName: "proof.txt",
      });
    }),
  );
  it.effect("splits files into bounded ordered chunks and waits for the final path", () =>
    Effect.gen(function* () {
      const test = yield* attachmentFixture;
      const bytes = new Uint8Array(512 * 1024 + 3).fill(42);
      yield* test.fs.writeFile(test.filePath, bytes);
      test.remote.uploadReceipts = [
        { receivedBytes: "524288" },
        { receivedBytes: String(bytes.length), path: "/uploads/large.txt" },
      ];
      const input = {
        ...test.input,
        attachments: [{ ...test.input.attachments[0]!, sizeBytes: bytes.length }],
      };
      assert.deepEqual(yield* test.service.uploadAttachments(input), {
        paths: ["/uploads/large.txt"],
        names: ["proof.txt"],
      });
      assert.equal(test.requests.length, 2);
      assert.include(test.requests[0]!.body, {
        offset: "0",
        data: Buffer.from(bytes.subarray(0, 512 * 1024)).toString("base64"),
      });
      assert.include(test.requests[1]!.body, {
        offset: "524288",
        data: Buffer.from(bytes.subarray(512 * 1024)).toString("base64"),
      });
    }),
  );
  it.effect("preflights every file before uploading when a later file is missing", () =>
    Effect.gen(function* () {
      const test = yield* attachmentFixture;
      const missing = {
        ...test.input.attachments[0]!,
        id: createAttachmentId("upload-test", "txt")!,
      };
      const result = yield* Effect.result(
        test.service.uploadAttachments({
          ...test.input,
          attachments: [...test.input.attachments, missing],
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "missing");
      assert.equal(test.requests.length, 0);
    }),
  );
  it.effect("rejects changed bytes and an oversized real file before upload", () =>
    Effect.gen(function* () {
      const test = yield* attachmentFixture;
      yield* test.fs.writeFileString(test.filePath, "changed");
      const changed = yield* Effect.result(test.service.uploadAttachments(test.input));
      if (changed._tag === "Failure") assert.equal(changed.failure.reason, "changed");
      else assert.fail("changed file was accepted");
      yield* test.fs.truncate(test.filePath, 50 * 1024 * 1024 + 1);
      const large = yield* Effect.result(test.service.uploadAttachments(test.input));
      if (large._tag === "Failure") assert.equal(large.failure.reason, "too_large");
      else assert.fail("oversized file was accepted");
      assert.equal(test.requests.length, 0);
    }),
  );
  it.effect("fails closed on invalid receipts and native upload rejection", () =>
    Effect.gen(function* () {
      const test = yield* attachmentFixture;
      test.remote.responses.UploadGrokBotAgentAttachmentChunk = {
        receivedBytes: "3",
        path: "/uploads/proof.txt",
      };
      const receipt = yield* Effect.result(test.service.uploadAttachments(test.input));
      if (receipt._tag === "Failure") assert.equal(receipt.failure.reason, "invalid_receipt");
      else assert.fail("incomplete receipt was accepted");
      test.remote.status = 413;
      const rejected = yield* Effect.result(test.service.uploadAttachments(test.input));
      if (rejected._tag === "Failure") assert.equal(rejected.failure.reason, "too_large");
      else assert.fail("native rejection was accepted");
    }),
  );
  it.effect("stops when the account changes during an upload", () =>
    Effect.gen(function* () {
      const test = yield* attachmentFixture;
      test.remote.responses.UploadGrokBotAgentAttachmentChunk = {
        receivedBytes: "5",
        path: "/uploads/proof.txt",
      };
      test.remote.accountAfterResponse = "other";
      const result = yield* Effect.result(test.service.uploadAttachments(test.input));
      assert.equal(result._tag, "Failure");
      assert.equal(test.requests.length, 1);
    }),
  );
});

it.layer(NodeServices.layer)("Direct Grok Bot read transport", (it) => {
  it.effect("classifies watch transport loss separately from malformed Connect frames", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      const binding = yield* service.accountBinding;
      remote.failTransport = true;
      const transport = yield* service
        .watchTranscripts(binding, {})
        .pipe(Stream.runDrain, Effect.flip);
      assert.equal(transport._tag, "GrokBotNativeReadError");
      if (transport._tag === "GrokBotNativeReadError") assert.equal(transport.transient, true);
      remote.failTransport = false;
      remote.stream = new Uint8Array([255, 0, 0, 0, 0]);
      const malformed = yield* service
        .watchTranscripts(binding, {})
        .pipe(Stream.runDrain, Effect.flip);
      assert.equal(malformed._tag, "GrokBotNativeReadError");
      if (malformed._tag === "GrokBotNativeReadError") assert.notEqual(malformed.transient, true);
      for (const status of [403, 503]) {
        remote.watchStatus = status;
        const error = yield* service
          .watchTranscripts(binding, {})
          .pipe(Stream.runDrain, Effect.flip);
        assert.equal(error._tag, "GrokBotNativeReadError");
        if (error._tag === "GrokBotNativeReadError") assert.equal(error.transient, status === 503);
      }
    }),
  );
  it.effect("keeps a silent transcript watch open until a later frame arrives", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      const binding = yield* service.accountBinding;
      const waiting = yield* Deferred.make<void>();
      const next = yield* Deferred.make<void>();
      remote.streamSource = Stream.fromEffect(
        Effect.gen(function* () {
          yield* Deferred.succeed(waiting, undefined);
          yield* Deferred.await(next);
          return Connect.encodeMessage({ heartbeat: {} });
        }),
      );
      const result = yield* service
        .watchTranscripts(binding, {})
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* Deferred.await(waiting);
      yield* TestClock.adjust("2 minutes");
      yield* Deferred.succeed(next, undefined);
      const frames = yield* Fiber.join(result);
      assert.deepEqual(frames, [{ heartbeat: {} }]);
    }),
  );

  it.effect("reads account email and plan through the selected dashboard account", () =>
    Effect.gen(function* () {
      const { service, remote, requests } = yield* fixture;
      const binding = yield* service.accountBinding;
      remote.responses.GetMe = { email: "fixture@example.test" };
      remote.responses.GetSandUsageStatus = { grokPlanLabel: "SuperGrok Heavy" };
      assert.deepEqual(yield* service.accountInfo(binding), {
        email: "fixture@example.test",
        plan: "SuperGrok Heavy",
      });
      assert.deepEqual(requests.map((request) => request.url).sort(), [
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe",
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus",
      ]);
    }),
  );
  it.effect(
    "reads weekly quota from the selected native account on the official dashboard route",
    () =>
      Effect.gen(function* () {
        const { service, requests, remote } = yield* fixture;
        const binding = yield* service.accountBinding;
        remote.responses.GetSandUsageStatus = {
          usagePercent: 23.5,
          nextResetTimestampUtc: "2026-10-12T00:00:00Z",
        };
        const limits = yield* service.usageLimits(binding, "2026-10-10T00:00:00.000Z");
        assert.equal(limits.windows[0]?.usedPercent, 23.5);
        assert.equal(limits.credentialFingerprint, binding);
        assert.equal(limits.windows[0]?.resetsAt, "2026-10-12T00:00:00.000Z");
        assert.equal(
          requests[0]?.url,
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus",
        );
        assert.deepEqual(requests[0]?.body, {});
        assert.equal(requests[0]?.authorization, "Bearer selected-token");
      }),
  );
  it.effect("keeps quota identity across token rotation and separates teams", () =>
    Effect.gen(function* () {
      const { service, remote, fs, secretFile } = yield* fixture;
      const binding = yield* service.accountBinding;
      const checkedAt = "2026-10-10T00:00:00.000Z";
      remote.responses.GetSandUsageStatus = { usagePercent: 23.5 };
      yield* fs.writeFileString(
        secretFile,
        JSON.stringify({
          version: 1,
          "cursor-accounts": JSON.stringify({
            active: "selected",
            accounts: { selected: { "cursor-access-token": encodeSecret("rotated-token") } },
          }),
        }),
      );
      const rotated = yield* service.usageLimits(binding, checkedAt);
      assert.equal(rotated.credentialFingerprint, binding);
      yield* fs.writeFileString(
        secretFile,
        JSON.stringify({
          version: 1,
          "cursor-accounts": JSON.stringify({
            active: "selected",
            accounts: {
              selected: {
                "cursor-access-token": encodeSecret("rotated-token"),
                "cursor-selected-team-id": encodeSecret("42"),
              },
            },
          }),
        }),
      );
      const teamBinding = yield* service.accountBinding;
      const team = yield* service.usageLimits(teamBinding, checkedAt);
      assert.equal(team.credentialFingerprint, teamBinding);
      assert.notEqual(team.credentialFingerprint, rotated.credentialFingerprint);
      assert.equal(JSON.stringify(team).includes("rotated-token"), false);
      assert.equal(JSON.stringify(team).includes("selected"), false);
    }),
  );
  it.effect(
    "rejects quota reads for another binding and discards an account switch during the read",
    () =>
      Effect.gen(function* () {
        const { service, remote } = yield* fixture;
        const binding = yield* service.accountBinding;
        const checkedAt = "2026-10-10T00:00:00.000Z";
        const wrong = yield* service.usageLimits("0".repeat(64), checkedAt).pipe(Effect.flip);
        assert.equal("stage" in wrong && wrong.stage, "session");
        assert.equal(remote.attempts, 0);
        remote.responses.GetSandUsageStatus = { usagePercent: 23.5 };
        remote.accountAfterResponse = "other";
        const switched = yield* service.usageLimits(binding, checkedAt).pipe(Effect.flip);
        assert.equal("stage" in switched && switched.stage, "response");
        assert.equal(remote.attempts, 1);
      }),
  );
  it.effect("keeps quota response failures sanitized", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      const binding = yield* service.accountBinding;
      remote.responses.GetSandUsageStatus = { usagePercent: "selected-token" };
      const error = yield* service
        .usageLimits(binding, "2026-10-10T00:00:00.000Z")
        .pipe(Effect.flip);
      assert.equal("stage" in error && error.stage, "response");
      assert.equal(JSON.stringify(error).includes("selected-token"), false);
    }),
  );
  it.effect("reads the native MCP catalog on fixed official routes with config redaction", () =>
    Effect.gen(function* () {
      const { service, requests, remote } = yield* fixture;
      const binding = yield* service.accountBinding;
      remote.responses.GetAvailableMcpServers = { servers: [{ name: "t3" }] };
      assert.deepEqual(
        yield* service.readMcp(binding, {
          method: "GetAvailableMcpServers",
          input: { grokBotAgentId: "bot-1" },
        }),
        { servers: [{ name: "t3" }] },
      );
      yield* service.readMcp(binding, {
        method: "GetMcpConfig",
        input: { teamScope: false, teamId: 0 },
      });
      yield* service.readMcp(binding, {
        method: "ListSandMcpTools",
        input: { serverIdentifiers: ["t3"] },
      });
      yield* service.readMcp(binding, { method: "GetGrokBotUserMcpSettings", input: {} });
      assert.deepEqual(
        requests.map(({ url }) => url),
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAvailableMcpServers",
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetMcpConfig",
          "https://api2.cursor.sh/aiserver.v1.DashboardService/ListSandMcpTools",
          "https://api2.cursor.sh/aiserver.v1.GrokBotService/GetGrokBotUserMcpSettings",
        ],
      );
      assert.deepEqual(requests[1]?.body, { teamScope: false, teamId: 0, redactSecrets: true });
    }),
  );
  it.effect("rejects MCP reads before a request and after an account switch", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      const binding = yield* service.accountBinding;
      const read = { method: "GetGrokBotUserMcpSettings", input: {} } as const;
      const wrongAccount = yield* service
        .readMcp("0".repeat(64), read)
        .pipe(Effect.asVoid, Effect.flip);
      assert.strictEqual("stage" in wrongAccount && wrongAccount.stage, "session");
      assert.strictEqual(remote.attempts, 0);
      remote.accountAfterResponse = "other";
      const switched = yield* service.readMcp(binding, read).pipe(Effect.asVoid, Effect.flip);
      assert.strictEqual("stage" in switched && switched.stage, "response");
      assert.strictEqual(remote.attempts, 1);
    }),
  );
  it.effect("rejects a different account before reading a bound roster", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      const binding = yield* service.accountBinding;
      remote.accountAfterResponse = "other";
      yield* service
        .runtimeRequest(binding, "ListGrokBotAgents", {})
        .pipe(Effect.asVoid, Effect.flip);
      const before = remote.attempts;
      const error = yield* service.listForBinding(binding).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GrokBotNativeReadError");
      assert.strictEqual("stage" in error && error.stage, "session");
      assert.strictEqual(remote.attempts, before);
    }),
  );
  it.effect("reads the bound roster and rejects account changes during its response", () =>
    Effect.gen(function* () {
      const { service, remote, requests } = yield* fixture;
      const binding = yield* service.accountBinding;
      const roster = yield* service.listForBinding(binding);
      assert.strictEqual(roster[0]?.nativeProfileId, "profile-record-1");
      remote.accountAfterResponse = "other";
      const before = requests.length;
      const error = yield* service.listForBinding(binding).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GrokBotNativeReadError");
      assert.strictEqual("stage" in error && error.stage, "session");
      assert.strictEqual(requests.length, before + 2);
      assert.strictEqual(
        requests.every((request) => request.authorization === "Bearer selected-token"),
        true,
      );
    }),
  );
  it.effect("observes native avatar photo precedence without exposing versions or URLs", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      const binding = yield* service.accountBinding;
      for (const [photo, expected] of [
        [{}, false],
        [{ avatarVersion: "", avatarUrl: "" }, false],
        [{ avatarVersion: null, avatarUrl: null }, false],
        [{ avatarVersion: "photo-revision" }, true],
        [{ avatarUrl: "https://private-avatar.example/photo" }, true],
      ] as const) {
        remote.roster = {
          agents: [{ id: "profile-record-1", agentId: "bot-1", avatarShape: "heart", ...photo }],
        };
        const [bot] = yield* service.listForBinding(binding);
        assert.strictEqual(bot?.hasAvatarPhoto, expected);
        assert.strictEqual(bot?.avatarShape, "heart");
        assert.strictEqual("avatarVersion" in (bot ?? {}), false);
        assert.strictEqual("avatarUrl" in (bot ?? {}), false);
      }
    }),
  );
  it.effect("does not return a roster after the selected account changes during its read", () =>
    Effect.gen(function* () {
      const { service, remote, requests } = yield* fixture;
      remote.accountAfterResponse = "other";
      const error = yield* service.list.pipe(Effect.flip);
      assert.strictEqual(error._tag, "GrokBotNativeReadError");
      assert.strictEqual("stage" in error && error.stage, "session");
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(
        requests.every((request) => request.authorization === "Bearer selected-token"),
        true,
      );
    }),
  );
  it.effect("marks post-write account changes and sign-out as uncertain responses", () =>
    Effect.gen(function* () {
      for (const next of ["other", "signed_out"] as const) {
        const { service, remote } = yield* fixture;
        const binding = yield* service.accountBinding;
        remote.accountAfterResponse = next;
        const error = yield* service
          .runtimeRequest(binding, "UpdateGrokBotAgent", {
            id: "profile-record-1",
            partialUpdate: true,
            avatarShape: "heart",
          })
          .pipe(Effect.asVoid, Effect.flip);
        assert.strictEqual(error._tag, "GrokBotNativeReadError");
        assert.strictEqual("stage" in error && error.stage, "response");
        assert.strictEqual(remote.attempts, 1);
      }
    }),
  );
  it.effect("keeps native profile rejection status bounded and makes only one request", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      const binding = yield* service.accountBinding;
      remote.rawBody = '{"message":"private selected-token authorization"}';
      for (const status of [401, 403, 404]) {
        remote.status = status;
        const before = remote.attempts;
        const failure = yield* service
          .runtimeRequest(binding, "UpdateGrokBotAgent", {
            id: "profile-record-1",
            partialUpdate: true,
            avatarShape: "heart",
          })
          .pipe(Effect.asVoid, Effect.flip);
        assert.strictEqual(failure._tag, "GrokBotNativeReadError");
        assert.strictEqual("status" in failure && failure.status, status);
        assert.strictEqual(remote.attempts, before + 1);
        assert.strictEqual("cause" in failure, false);
        assert.strictEqual(JSON.stringify(failure).includes("selected-token"), false);
        assert.strictEqual(JSON.stringify(failure).includes("authorization"), false);
      }
    }),
  );
  it.effect(
    "distinguishes an invalid profile response from transport failure without retries",
    () =>
      Effect.gen(function* () {
        const { service, remote } = yield* fixture;
        const binding = yield* service.accountBinding;
        const input = { id: "profile-record-1", partialUpdate: true, avatarShape: "heart" };
        remote.rawBody = "invalid private selected-token";
        const responseFailure = yield* service
          .runtimeRequest(binding, "UpdateGrokBotAgent", input)
          .pipe(Effect.asVoid, Effect.flip);
        assert.strictEqual(responseFailure._tag, "GrokBotNativeReadError");
        assert.strictEqual("stage" in responseFailure && responseFailure.stage, "response");
        remote.failTransport = true;
        const transportFailure = yield* service
          .runtimeRequest(binding, "UpdateGrokBotAgent", input)
          .pipe(Effect.asVoid, Effect.flip);
        assert.strictEqual(transportFailure._tag, "GrokBotNativeReadError");
        assert.strictEqual("stage" in transportFailure && transportFailure.stage, "request");
        assert.strictEqual(remote.attempts, 2);
        assert.strictEqual(JSON.stringify(responseFailure).includes("selected-token"), false);
        assert.strictEqual(JSON.stringify(transportFailure).includes("selected-token"), false);
      }),
  );
  it.effect(
    "binds runtime operations to selected account/team and never retries uncertain writes",
    () =>
      Effect.gen(function* () {
        const { service, remote, requests, fs, secretFile } = yield* fixture;
        const binding = yield* service.accountBinding;
        assert.match(binding, /^[0-9a-f]{64}$/);
        remote.responses.SendGrokBotUserMessage = {
          delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL",
        };
        const input = {
          agentId: "bot-1",
          sessionId: "s1",
          messageId: "nonce",
          text: "hello",
          sentAtMs: "1",
          mcpConfigJson: "private run-secret",
        };
        yield* service.runtimeRequest(binding, "SendGrokBotUserMessage", input);
        assert.deepStrictEqual(requests[0]?.body, input);
        assert.strictEqual(requests[0]?.authorization, "Bearer selected-token");
        remote.failTransport = true;
        const error = yield* service
          .runtimeRequest(binding, "SendGrokBotUserMessage", input)
          .pipe(Effect.asVoid, Effect.flip);
        assert.strictEqual(error._tag, "GrokBotNativeReadError");
        assert.strictEqual(JSON.stringify(error).includes("run-secret"), false);
        remote.failTransport = false;
        yield* fs.writeFileString(
          secretFile,
          JSON.stringify({
            version: 1,
            "cursor-accounts": JSON.stringify({
              active: "other",
              accounts: { other: { "cursor-access-token": encodeSecret("other-token") } },
            }),
          }),
        );
        const before = requests.length;
        assert.strictEqual(
          (yield* service
            .runtimeRequest(binding, "InterruptGrokBotAgentRun", { agentId: "bot-1" })
            .pipe(Effect.asVoid, Effect.flip))._tag,
          "GrokBotNativeReadError",
        );
        assert.strictEqual(requests.length, before);
      }),
  );
  it.effect(
    "uses Connect streaming framing and releases the response when its consumer cancels",
    () =>
      Effect.gen(function* () {
        const { service, remote, requests } = yield* fixture;
        const binding = yield* service.accountBinding;
        remote.stream = Connect.encodeMessage({ heartbeat: { serverTimeMs: "1" } });
        const input = {
          cursors: [{ agentId: "bot-1", sessionId: "s1", generation: 2, afterUpdatedSeq: "5" }],
          inlineBodyMaxBytes: 1048576,
        };
        const frames = yield* service
          .watchTranscripts(binding, input)
          .pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(frames, [{ heartbeat: { serverTimeMs: "1" } }]);
        assert.deepStrictEqual(requests[0]?.body, input);
        assert.strictEqual(remote.cancelled, true);
      }),
  );
  it.effect(
    "describes the awake gateway without waking and reads authoritative settlement/events with only gateway credentials",
    () =>
      Effect.gen(function* () {
        const { service, remote, requests } = yield* fixture;
        const binding = yield* service.accountBinding;
        remote.responses.EnsureSandBox = {
          gatewayUrl: "https://fixture.cursorvm.com",
          gatewayToken: "gateway-token",
          networkToken: "network-token",
          runState: "SAND_BOX_RUN_STATE_RUNNING",
        };
        remote.responses.listAgents = [
          {
            id: "bot-1",
            lastTurnSettlement: { clientNonce: "nonce", outcome: "success", settledAtMs: 10 },
          },
        ];
        const roster = yield* service.gatewayRoster(binding);
        assert.deepStrictEqual(roster, remote.responses.listAgents);
        remote.stream = new TextEncoder().encode(
          'data: {"channel":"agents","payload":{"agents":[]}}\n\n',
        );
        let ready = false;
        const events = yield* service
          .gatewayEvents(
            binding,
            Effect.sync(() => {
              ready = true;
            }),
          )
          .pipe(Stream.take(1), Stream.runCollect);
        assert.strictEqual(ready, true);
        assert.strictEqual(events[0]?.channel, "agents");
        assert.strictEqual(remote.cancelled, true);
        assert.strictEqual(
          requests
            .filter((request) => request.method === "EnsureSandBox")
            .every((request) => JSON.stringify(request.body) === '{"wake":false}'),
          true,
        );
        assert.strictEqual(
          requests
            .filter((request) => request.method === "listAgents" || request.method === "events")
            .every((request) => request.authorization === "Bearer gateway-token"),
          true,
        );
        remote.responses.EnsureSandBox = {
          gatewayUrl: "https://outside.invalid",
          gatewayToken: "gateway-token",
          runState: 3,
        };
        const before = requests.filter((request) => request.method === "listAgents").length;
        yield* service.gatewayRoster(binding).pipe(Effect.asVoid, Effect.flip);
        assert.strictEqual(
          requests.filter((request) => request.method === "listAgents").length,
          before,
        );
      }),
  );
  it.effect("reads the native bot computer without waking and only wakes on explicit start", () =>
    Effect.gen(function* () {
      const { service, remote, requests } = yield* fixture;
      const binding = yield* service.accountBinding;
      remote.responses.EnsureSandBox = {
        gatewayUrl: "https://fixture.cursorvm.com",
        gatewayToken: "gateway-token",
        networkToken: "network",
        vncUrl: "https://fixture-6080.cursorvm.com/vnc.html?network_token=network",
        runState: 3,
      };
      remote.responses.getForeverBoxStatus = {
        state: "running",
        vncUrl: "http://localhost:6080/vnc.html",
      };
      const read = yield* service.computer(binding, "bot-1", false);
      assert.strictEqual(read.state, "running");
      assert.strictEqual(new URL(read.socketUrl!).hostname, "fixture-6080.cursorvm.com");
      assert.deepStrictEqual(requests.findLast((r) => r.method === "EnsureSandBox")?.body, {
        wake: false,
      });
      assert.deepStrictEqual(requests.findLast((r) => r.method === "getForeverBoxStatus")?.body, {
        id: "bot-1",
      });
      remote.responses.ensureForeverBox = { state: "starting" };
      const start = yield* service.computer(binding, "bot-1", true);
      assert.deepStrictEqual(start, { state: "starting" });
      assert.deepStrictEqual(requests.findLast((r) => r.method === "EnsureSandBox")?.body, {
        wake: true,
      });
      assert.strictEqual(
        requests.findLast((r) => r.method === "ensureForeverBox")?.authorization,
        "Bearer gateway-token",
      );
    }),
  );
  it.effect("posts voice presence and the call record to the bound gateway", () =>
    Effect.gen(function* () {
      const { service, remote, requests } = yield* fixture;
      const binding = yield* service.accountBinding;
      remote.responses.EnsureSandBox = {
        gatewayUrl: "https://fixture.cursorvm.com",
        gatewayToken: "gateway-token",
        runState: 3,
      };
      remote.responses.setVoiceCallPresence = null;
      remote.responses.recordVoiceCall = null;
      const presence = { id: "bot-1", callId: "call-1", isOnTheLine: true };
      yield* service.voiceGateway(binding, { method: "setVoiceCallPresence", args: presence });
      const record = { callId: "call-1", agentId: "bot-1", turns: [] };
      yield* service.voiceGateway(binding, { method: "recordVoiceCall", args: { record } });
      assert.deepStrictEqual(
        requests.findLast((r) => r.method === "setVoiceCallPresence")?.body,
        presence,
      );
      const recorded = requests.findLast((r) => r.method === "recordVoiceCall");
      assert.deepStrictEqual(recorded?.body, { record });
      assert.strictEqual(recorded?.authorization, "Bearer gateway-token");
      remote.accountAfterResponse = "other";
      const error = yield* service
        .voiceGateway(binding, { method: "recordVoiceCall", args: { record } })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "GrokBotNativeReadError");
    }),
  );
  it.effect("reads, starts, saves, and discards native teaching through the bound gateway", () =>
    Effect.gen(function* () {
      const { service, remote, requests } = yield* fixture;
      const binding = yield* service.accountBinding;
      remote.responses.EnsureSandBox = {
        gatewayUrl: "https://fixture.cursorvm.com",
        gatewayToken: "gateway-token",
        runState: 3,
      };
      const idle = {
        state: "idle" as const,
        agentId: null,
        startedAtMs: null,
        maxDurationMs: 600000,
      };
      const recording = {
        ...idle,
        state: "recording" as const,
        agentId: "bot-1",
        startedAtMs: 1234,
      };
      remote.responses.getTeachRecordingStatus = idle;
      assert.deepStrictEqual(
        yield* service.teachRecording(binding, { method: "getTeachRecordingStatus", args: {} }),
        idle,
      );
      remote.responses.startTeachRecording = recording;
      const args = { agentId: "bot-1", entryPoint: "fullscreen_title_bar" };
      assert.deepStrictEqual(
        yield* service.teachRecording(binding, { method: "startTeachRecording", args }),
        recording,
      );
      assert.deepStrictEqual(
        requests.findLast((r) => r.method === "startTeachRecording")?.body,
        args,
      );
      assert.strictEqual(
        requests.findLast((r) => r.method === "startTeachRecording")?.authorization,
        "Bearer gateway-token",
      );
      remote.responses.stopTeachRecording = idle;
      for (const save of [true, false]) {
        const args = { agentId: "bot-1", save };
        assert.deepStrictEqual(
          yield* service.teachRecording(binding, { method: "stopTeachRecording", args }),
          idle,
        );
        assert.deepStrictEqual(
          requests.findLast((r) => r.method === "stopTeachRecording")?.body,
          args,
        );
      }
      remote.responses.getTeachRecordingStatus = { ...recording, startedAtMs: "invalid" };
      assert.strictEqual(
        (yield* service
          .teachRecording(binding, { method: "getTeachRecordingStatus", args: {} })
          .pipe(Effect.flip))._tag,
        "GrokBotNativeReadError",
      );
      remote.responses.getTeachRecordingStatus = recording;
      remote.accountAfterResponse = "other";
      yield* service
        .teachRecording(binding, { method: "getTeachRecordingStatus", args: {} })
        .pipe(Effect.asVoid, Effect.flip);
    }),
  );
  it.effect("revokes a connected native watch after selected account sign-out", () =>
    Effect.gen(function* () {
      const { service, remote, fs, secretFile } = yield* fixture;
      const binding = yield* service.accountBinding;
      const signedOut = yield* Deferred.make<void>();
      remote.stream = Connect.encodeMessage({ heartbeat: {} });
      // The timeout stream can read ahead. Send the next chunk only after sign-out,
      // so it cannot already have been authorized when the consumer sees frame one.
      remote.streamSource = Stream.make(remote.stream).pipe(
        Stream.concat(Stream.fromEffect(Deferred.await(signedOut).pipe(Effect.as(remote.stream)))),
      );
      yield* fs.writeFileString(
        secretFile + ".signed-out",
        JSON.stringify({
          version: 1,
          "cursor-accounts": JSON.stringify({ active: null, accounts: {} }),
        }),
      );
      let frames = 0;
      const error = yield* service.watchTranscripts(binding, {}).pipe(
        Stream.mapEffect((frame) =>
          Effect.gen(function* () {
            frames++;
            yield* fs.rename(secretFile + ".signed-out", secretFile);
            yield* Deferred.succeed(signedOut, undefined);
            return frame;
          }),
        ),
        Stream.runCollect,
        Effect.flip,
      );
      assert.strictEqual(frames, 1);
      assert.strictEqual(error._tag, "GrokBotNativeSignedOutError");
    }),
  );
  it.effect("removes credential-bearing transport causes before errors leave the adapter", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      remote.failTransport = true;
      const error = yield* service.list.pipe(Effect.flip);
      assert.strictEqual(error._tag, "GrokBotNativeReadError");
      assert.strictEqual("cause" in error, false);
      assert.strictEqual(JSON.stringify(error).includes("selected-token"), false);
      assert.strictEqual(JSON.stringify(error).includes("authorization"), false);
    }),
  );
  it.effect(
    "uses only the selected desktop token and maps native state without exposing account data",
    () =>
      Effect.gen(function* () {
        const { service, remote, requests, fs, secretFile } = yield* fixture;
        const before = yield* fs.readFileString(secretFile);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        remote.statuses = {
          statuses: [
            {
              agentId: "bot-1",
              live: {
                isRunning: true,
                isComposingMessage: false,
                updatedAtMs: String(now),
                staleAfterMs: "90000",
                activity: { kind: "tool", tool: "Shell", detail: "private command" },
                awaiting: { reason: "permission", sinceMs: String(now) },
              },
              client: { notifyOnUpdatesEnabled: false, hiddenFromSidebar: true },
            },
          ],
        };
        const [bot] = yield* service.list;
        assert.strictEqual(bot?.id, "bot-1");
        assert.strictEqual(bot?.nativeProfileId, "profile-record-1");
        assert.strictEqual(bot?.runtimeActivity?.isRunning, true);
        assert.strictEqual(bot?.runtimeActivity?.awaitingUserResponse?.reason, "permission");
        assert.deepStrictEqual(bot?.runtimeActivity?.currentActivity, {
          kind: "tool",
          tool: "Shell",
          hasDetail: true,
        });
        assert.strictEqual(bot?.notifyOnAgentUpdates, false);
        assert.strictEqual(bot?.hiddenFromSidebar, true);
        assert.strictEqual(JSON.stringify(bot).includes("private"), false);
        assert.strictEqual(JSON.stringify(bot).includes("token"), false);
        assert.strictEqual(
          requests.every((request) => request.authorization === "Bearer selected-token"),
          true,
        );
        assert.strictEqual(
          requests.every((request) =>
            request.url.startsWith("https://api2.cursor.sh/aiserver.v1.GrokBotService/"),
          ),
          true,
        );
        assert.strictEqual(yield* fs.readFileString(secretFile), before);
      }),
  );
  it.effect("does not borrow another saved account after sign-out", () =>
    Effect.gen(function* () {
      const { service, secrets, fs, secretFile, requests } = yield* fixture;
      secrets["cursor-accounts"] = JSON.stringify({
        active: null,
        accounts: { other: { "cursor-access-token": encodeSecret("other-token") } },
      });
      yield* fs.writeFileString(secretFile, JSON.stringify(secrets));
      const error = yield* service.list.pipe(Effect.flip);
      assert.strictEqual(error._tag, "GrokBotNativeSignedOutError");
      assert.strictEqual(requests.length, 0);
    }),
  );
  it.effect("drops expired live activity and preserves composing and subagent facts", () =>
    Effect.gen(function* () {
      const { service, remote } = yield* fixture;
      yield* TestClock.adjust("200 seconds");
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      remote.statuses = {
        statuses: [
          {
            agentId: "bot-1",
            live: {
              isRunning: true,
              isComposingMessage: true,
              updatedAtMs: String(now - 100000),
              staleAfterMs: "90000",
              activity: { kind: "tool", tool: "WebSearch" },
              awaiting: { reason: "permission" },
            },
          },
        ],
      };
      const [stale] = yield* service.list;
      assert.strictEqual(stale?.runtimeActivity?.isRunning, false);
      assert.strictEqual(stale?.runtimeActivity?.isComposingMessage, false);
      assert.strictEqual(stale?.runtimeActivity?.currentActivity, undefined);
      assert.strictEqual(stale?.runtimeActivity?.awaitingUserResponse, null);
      remote.statuses = {
        statuses: [
          { agentId: "bot-1", live: { hasRunningSubagents: true, isComposingMessage: true } },
        ],
      };
      const [subagent] = yield* service.list;
      assert.strictEqual(subagent?.runtimeActivity?.isRunning, true);
      assert.strictEqual(subagent?.runtimeActivity?.isComposingMessage, false);
      remote.statuses = {
        statuses: [{ agentId: "bot-1", live: { isRunning: true, isComposingMessage: true } }],
      };
      assert.strictEqual((yield* service.list)[0]?.runtimeActivity?.isComposingMessage, true);
    }),
  );
  it.effect(
    "decodes inline transcript bodies in chat order and requests bounded tail/status reads",
    () =>
      Effect.gen(function* () {
        const { service, remote, requests } = yield* fixture;
        const first = { id: "u1", kind: "message", role: "user", content: "hello" };
        const second = {
          id: "a1",
          kind: "send-message",
          message: { type: "text", content: "reply" },
          isStreaming: true,
        };
        remote.transcript = {
          entries: [
            { seq: "2", body: Buffer.from(JSON.stringify(second)).toString("base64") },
            { seq: "1", body: Buffer.from(JSON.stringify(first)).toString("base64") },
          ],
        };
        const tail = yield* service.read("bot-1");
        assert.deepStrictEqual(tail.entries, [first, second]);
        assert.strictEqual(tail.runtimeActivity?.source, "native");
        assert.deepStrictEqual(
          requests.find((request) => request.method === "ListGrokBotTranscriptEntries")?.body,
          { agentId: "bot-1", sessionId: "", limit: 200 },
        );
        assert.deepStrictEqual(
          requests.find((request) => request.method === "ListGrokBotAgentStatuses")?.body,
          { agentIds: ["bot-1"] },
        );
      }),
  );
  it.effect(
    "rejects partial/malformed transcript snapshots and remote failures without retry",
    () =>
      Effect.gen(function* () {
        const { service, remote, requests } = yield* fixture;
        remote.transcript = { entries: [{ seq: "1", blobHash: "omitted" }] };
        assert.strictEqual(
          (yield* service.read("bot-1").pipe(Effect.flip))._tag,
          "GrokBotNativeReadError",
        );
        remote.transcript = {
          entries: [{ seq: "1", body: Buffer.from("invalid json").toString("base64") }],
        };
        assert.strictEqual(
          (yield* service.read("bot-1").pipe(Effect.flip))._tag,
          "GrokBotNativeReadError",
        );
        remote.status = 401;
        const before = requests.length;
        assert.strictEqual((yield* service.list.pipe(Effect.flip))._tag, "GrokBotNativeReadError");
        assert.strictEqual(requests.length - before, 1);
      }),
  );
});

const receivedFixture = Effect.gen(function* () {
  const test = yield* fixture;
  const binding = yield* test.service.accountBinding;
  return {
    ...test,
    input: {
      binding,
      botId: "bot-1",
      threadId: "received-test",
      entryId: "native-entry",
      attachmentsDir: test.root,
      attachments: [
        {
          url: "file:///home/box/agent-data/agents/bot-1/attachments/test.txt",
          name: "poteto.txt",
          image: false,
        },
      ],
    },
  };
});

it.effect(
  "downloads native files in bounded authenticated chunks and reuses their stable local attachment",
  () =>
    Effect.gen(function* () {
      const test = yield* receivedFixture;
      test.remote.attachmentBytes = new Uint8Array(300_000).fill(65);
      const first = yield* test.service.receiveAttachments(test.input);
      assert.equal(first.length, 1);
      assert.equal(first[0]?.name, "poteto.txt");
      assert.equal(first[0]?.type, "file");
      assert.equal(first[0]?.sizeBytes, 300_000);
      assert.equal(test.requests.length, 3);
      assert(
        test.requests.every(
          (request) =>
            request.method === "ReadGrokBotAgentAttachmentChunk" &&
            request.authorization === "Bearer selected-token",
        ),
      );
      assert.deepEqual(
        test.requests.map((request) => request.body),
        [
          {
            path: "/home/box/agent-data/agents/bot-1/attachments/test.txt",
            offset: "0",
            length: 0,
          },
          {
            path: "/home/box/agent-data/agents/bot-1/attachments/test.txt",
            offset: "0",
            length: 262144,
          },
          {
            path: "/home/box/agent-data/agents/bot-1/attachments/test.txt",
            offset: "262144",
            length: 37856,
          },
        ],
      );
      const saved = yield* test.fs.readFile(
        resolveAttachmentPath({ attachmentsDir: test.root, attachment: first[0]! })!,
      );
      assert.deepEqual(saved, test.remote.attachmentBytes);
      assert.deepEqual(yield* test.service.receiveAttachments(test.input), first);
      assert.equal(test.requests.length, 3);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects cross-bot paths and incomplete downloads without persisting attachments", () =>
  Effect.gen(function* () {
    const test = yield* receivedFixture;
    const crossBot = yield* Effect.result(
      test.service.receiveAttachments({
        ...test.input,
        attachments: [
          { url: "file:///home/box/agent-data/agents/bot-2/attachments/test.txt", image: false },
        ],
      }),
    );
    assert.equal(crossBot._tag, "Failure");
    assert.equal(test.requests.length, 0);
    test.remote.attachmentBytes = new Uint8Array(10);
    test.remote.attachmentTotalSize = 20;
    const incomplete = yield* Effect.result(test.service.receiveAttachments(test.input));
    assert.equal(incomplete._tag, "Failure");
    assert.deepEqual(yield* test.fs.readDirectory(test.root), [".config"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
