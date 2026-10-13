import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  GrokBotNativeRuntimeService,
  type RuntimeFrame,
} from "../../grokBot/GrokBotNativeRuntimeService.ts";
import { createGrokBotAdapterV2, makeGrokBotTranscriptProjection } from "./GrokBotAdapterV2.ts";
import { GrokBotManagedBinding, GrokBotBindingError } from "./GrokBotManagedBinding.ts";
import { grokBotTurnIdentity } from "./GrokBotSettlementProjection.ts";
import {
  makeBindings,
  makeNative,
  makeTurn,
  nativeSession,
  options,
  policy,
  providerSessionId,
  selection,
  threadId,
} from "./GrokBotProvider.testkit.ts";

const frame = (
  entries: readonly { seq: string; updatedSeq: string; value: unknown }[],
): Extract<RuntimeFrame, { _tag: "Rows" }> => ({
  _tag: "Rows",
  generation: nativeSession.generation,
  entries,
  deletes: [],
  replay: true,
});
const upload = (
  seq: string,
  filePath: string,
  fileName: string,
  clientNonce = "native-upload",
) => ({
  seq,
  updatedSeq: seq,
  value: {
    kind: "user-attachment",
    id: `native-upload-${seq}`,
    file_path: filePath,
    file_name: fileName,
    clientNonce,
    byteSize: 50,
    batchId: `${clientNonce}:batch`,
    replyTo: "native-earlier-message",
    timestampMs: 1234,
  },
});

const makeImporter = () => {
  const imported: { entryId: string; url: string; name?: string; image: boolean }[] = [];
  const ids = new Map<string, string>();
  const importAttachments = (
    entryId: string,
    attachments: readonly { url: string; name?: string; image: boolean }[],
  ) =>
    Effect.sync(() =>
      attachments.map((attachment) => {
        imported.push({ entryId, ...attachment });
        if (!ids.has(attachment.url)) ids.set(attachment.url, `fixture-attachment-${ids.size}`);
        return {
          type: attachment.image ? ("image" as const) : ("file" as const),
          id: ids.get(attachment.url)!,
          name: attachment.name ?? "image.png",
          mimeType: attachment.image ? "image/png" : "application/pdf",
          sizeBytes: 50,
        };
      }),
    );
  return { imported, importAttachments };
};

it.effect("imports the shipped user-attachment shape as attachment-only user messages", () =>
  Effect.gen(function* () {
    const importer = makeImporter();
    const projection = makeGrokBotTranscriptProjection({
      native: nativeSession,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      importAttachments: importer.importAttachments,
    });
    const entries = [
      upload("1", "/home/box/agent-data/agents/bot-1/attachments/photo.png", "My photo.png"),
      upload("2", "/home/box/sand-data/agents/bot-1/assets/docs/report.pdf", "Report.pdf"),
    ];
    const events = yield* projection.project(frame(entries));
    assert.deepEqual(
      projection.messages().map((message) => ({
        role: message.role,
        createdBy: message.createdBy,
        text: message.text,
        type: message.attachments[0]?.type,
        name: message.attachments[0]?.name,
      })),
      [
        { role: "user", createdBy: "user", text: "", type: "image", name: "My photo.png" },
        { role: "user", createdBy: "user", text: "", type: "file", name: "Report.pdf" },
      ],
    );
    const items = events.filter((event) => event.type === "turn_item.updated");
    assert.deepEqual(
      items.map((event) => event.turnItem.type),
      ["user_message", "user_message"],
    );
    assert.deepEqual(
      items.map((event) =>
        event.turnItem.type === "user_message" ? event.turnItem.attachments : undefined,
      ),
      projection.messages().map((message) => message.attachments),
    );
    assert.equal(importer.imported.length, 2);
    assert.deepEqual(yield* projection.project(frame(entries)), []);
    assert.equal(importer.imported.length, 2);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "retains top-level images, text and peer attribution and deduplicates each row's URLs",
  () =>
    Effect.gen(function* () {
      const importer = makeImporter();
      const projection = makeGrokBotTranscriptProjection({
        native: nativeSession,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        importAttachments: importer.importAttachments,
      });
      const url = "file:///home/box/agent-data/agents/bot-1/assets/screenshot.png";
      yield* projection.project(
        frame([
          {
            seq: "1",
            updatedSeq: "1",
            value: {
              id: "user-images",
              kind: "message",
              role: "user",
              content: "Look at this",
              images: [{ url }, { url: ` ${url} ` }],
            },
          },
          {
            seq: "2",
            updatedSeq: "2",
            value: {
              id: "peer-images",
              kind: "message",
              role: "user",
              fromAgent: { id: "peer-bot", name: "Research Bot" },
              images: [{ url }],
            },
          },
          {
            seq: "3",
            updatedSeq: "3",
            value: {
              id: "assistant-images",
              kind: "message",
              role: "assistant",
              images: [{ url }],
            },
          },
        ]),
      );
      const [user, peer, assistant] = projection.messages();
      assert.equal(user?.text, "Look at this");
      assert.equal(user?.role, "user");
      assert.equal(user?.attachments.length, 1);
      assert.equal(peer?.text, "");
      assert.equal(peer?.role, "assistant");
      assert.equal(peer?.createdBy, "agent");
      assert.deepEqual(peer?.grokBotPeer, {
        botId: "peer-bot",
        name: "Research Bot",
        direction: "from",
      });
      assert.equal(peer?.attachments.length, 1);
      assert.equal(assistant?.text, "");
      assert.equal(assistant?.role, "assistant");
      assert.equal(assistant?.attachments.length, 1);
      assert.equal(importer.imported.length, 3);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each(["registered", "restored"] as const)(
  "suppresses managed T3 upload echoes with %s ownership before media import",
  (ownership) =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const importer = makeImporter();
      const lookedUp: string[] = [];
      const projection = makeGrokBotTranscriptProjection({
        native: nativeSession,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        importAttachments: importer.importAttachments,
        existingMessage: () => Effect.die("Upload echoes must not replace the original T3 message"),
        lookupTranscriptTurn: (nonce) =>
          Effect.sync(() => {
            lookedUp.push(nonce);
            return nonce === turn.messageId ? grokBotTurnIdentity(turn) : undefined;
          }),
      });
      if (ownership === "registered") projection.registerManagedMessageId(turn.messageId);
      const row = upload(
        "1",
        "/home/box/agent-data/agents/bot-1/attachments/file.pdf",
        "file.pdf",
        turn.messageId,
      );
      assert.deepEqual(yield* projection.project(frame([row])), []);
      assert.deepEqual(yield* projection.project(frame([{ ...row, updatedSeq: "5" }])), []);
      assert.deepEqual(importer.imported, []);
      assert.deepEqual(projection.messages(), []);
      assert.deepEqual(lookedUp, ownership === "restored" ? [turn.messageId] : []);
      // Matching nonces never claim a native peer's upload.
      yield* projection.project(
        frame([{ ...row, value: { ...row.value, fromAgent: { id: "peer-bot", name: "Peer" } } }]),
      );
      assert.equal(projection.messages()[0]?.role, "assistant");
      assert.equal(projection.messages()[0]?.grokBotPeer?.botId, "peer-bot");
      assert.equal(importer.imported.length, 1);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each(["user-attachment", "message", "send-message"] as const)(
  "retries unavailable %s media and applies newer versions to the same message and turn item",
  (kind) =>
    Effect.gen(function* () {
      const importer = makeImporter();
      let available = false;
      const projection = makeGrokBotTranscriptProjection({
        native: nativeSession,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        importAttachments: (entryId, media) =>
          available
            ? importer.importAttachments(entryId, media)
            : Effect.fail(new GrokBotBindingError({ reason: "Fixture attachment unavailable." })),
      });
      const makeRow = (updatedSeq: string, filename: string) => {
        const url = `file:///home/box/sand-data/agents/bot-1/assets/${filename}`;
        return {
          seq: "1",
          updatedSeq,
          value: {
            id: "native-row",
            kind,
            role: "user",
            timestampMs: 1234,
            ...(kind === "user-attachment"
              ? { file_path: url, file_name: filename }
              : kind === "message"
                ? { images: [{ url }] }
                : { message: { type: "text", images: [{ url }] } }),
          },
        };
      };
      const original = frame([makeRow("1", "first.png")]);
      const failed = yield* projection.project(original);
      const first = projection.messages()[0]!;
      assert.equal(first.text, "1 attachment is temporarily unavailable.");
      assert.deepEqual(first.attachments, []);
      available = true;
      const retried = yield* projection.project(original);
      assert.equal(projection.messages()[0]?.id, first.id);
      assert.equal(projection.messages()[0]?.text, "");
      assert.equal(projection.messages()[0]?.attachments.length, 1);
      assert.deepEqual(yield* projection.project(original), []);
      const updated = yield* projection.project(frame([makeRow("2", "second.png")]));
      assert.equal(projection.messages()[0]?.id, first.id);
      assert.equal(projection.messages()[0]?.createdAt, first.createdAt);
      assert.equal(importer.imported.length, 2);
      assert.deepEqual(
        [failed, retried, updated].map(
          (events) => events.find((event) => event.type === "turn_item.updated")?.turnItem.id,
        ),
        Array(3).fill(failed.find((event) => event.type === "turn_item.updated")?.turnItem.id),
      );
      assert.deepEqual(yield* projection.project(original), []);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "imports external uploads through the observer after restoring managed echo ownership",
  () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn;
      const importer = makeImporter();
      const host = yield* ProviderHost.ProviderHost;
      const replay = frame([
        upload(
          "1",
          "/home/box/agent-data/agents/bot-1/attachments/owned.png",
          "owned.png",
          turn.messageId,
        ),
        upload("2", "/home/box/sand-data/agents/bot-1/assets/external.png", "external.png"),
      ]);
      const adapter = yield* createGrokBotAdapterV2(options).pipe(
        Effect.provideService(
          GrokBotNativeRuntimeService,
          makeNative({
            watch: () => Stream.succeed(replay).pipe(Stream.concat(Stream.never)),
            receiveAttachments: (input) => {
              assert.equal(input.binding, nativeSession.binding);
              assert.equal(input.botId, nativeSession.botId);
              assert.equal(input.threadId, threadId);
              assert.equal(input.attachmentsDir, host.paths.attachmentsDir);
              return importer.importAttachments(input.entryId, input.attachments);
            },
          }),
        ),
        Effect.provideService(
          GrokBotManagedBinding,
          makeBindings(turn, { restoreManagedMessageIds: () => Effect.succeed([turn.messageId]) }),
        ),
      );
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection: selection,
        runtimePolicy: policy,
      });
      const events = yield* session.events.pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(
        events.map((event) => event.type),
        ["message.updated", "turn_item.updated"],
      );
      const event = events[0];
      assert.ok(event?.type === "message.updated");
      assert.equal(event.message.role, "user");
      assert.equal(event.message.text, "");
      assert.equal(event.message.attachments[0]?.name, "external.png");
      assert.equal(importer.imported.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide([
        IdAllocator.layer,
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      ]),
    ),
);
