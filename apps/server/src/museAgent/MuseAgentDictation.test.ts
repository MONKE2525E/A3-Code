// @effect-diagnostics nodeBuiltinImport:off -- Fixtures own their executable, model, audio directory, and local synchronization socket.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { MUSE_DICTATION_MAX_BYTES } from "@t3tools/contracts/museAgentDictation";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Dictation from "./MuseAgentDictation.ts";
import { host } from "../orchestration-v2/Adapters/MuseAgentAdapterV2.testkit.ts";

const pcm = Buffer.alloc(12);
[0, 1_000, 2_000, 3_000, 4_000, 5_000].forEach((sample, index) =>
  pcm.writeInt16LE(sample, index * 2),
);
const model = Buffer.from("synthetic-whisper-model");
const modelManifest = {
  sizeBytes: model.length,
  sha256: NodeCrypto.createHash("sha256").update(model).digest("hex"),
};
const helperSource = (extra: string, transcript = "Synthetic dictation") => `#!/usr/bin/env node
const fs=require('node:fs'),assert=require('node:assert/strict');
const args=process.argv.slice(2),arg=(name)=>args[args.indexOf(name)+1];
assert.deepEqual(args.filter((x)=>['-otxt','-nt','-np','--no-gpu'].includes(x)),['-otxt','-nt','-np','--no-gpu']);
assert.equal(arg('-t'),'4');assert.equal(arg('-l'),'auto');
const audio=fs.readFileSync(arg('-f'));
assert.equal(audio.toString('ascii',0,4),'RIFF');assert.equal(audio.readUInt32LE(24),16000);
assert.equal(audio.readUInt16LE(22),1);assert.equal(audio.readUInt16LE(34),16);
assert.equal(fs.statSync(arg('-f')).mode&511,384);
const finish=()=>fs.writeFileSync(arg('-of')+'.txt',${JSON.stringify(transcript)});
${extra || "finish();"}
`;

const withFixture = <A, E, R>(
  test: (fixture: {
    readonly root: string;
    readonly helper: string;
    readonly model: string;
    readonly scratch: string;
    readonly layer: Layer.Layer<Dictation.MuseAgentDictation>;
    readonly configure: (
      source: string,
      options?: Parameters<typeof Dictation.makeMuseAgentDictationLayer>[0],
    ) => Promise<Layer.Layer<Dictation.MuseAgentDictation>>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-dictation-test-"));
      const helper = NodePath.join(root, "whisper-cli"),
        modelPath = NodePath.join(root, "ggml-tiny.bin"),
        scratch = NodePath.join(root, "scratch");
      await NodeFSP.writeFile(modelPath, model, { mode: 0o600 });
      const configure = async (
        source: string,
        options: Parameters<typeof Dictation.makeMuseAgentDictationLayer>[0] = {},
      ) => {
        await NodeFSP.writeFile(helper, source, { mode: 0o700 });
        return Dictation.makeMuseAgentDictationLayer({
          helperPath: helper,
          modelPath,
          modelManifest,
          ...options,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProviderHost.ProviderHost, {
                ...host,
                paths: { ...host.paths, providerStatusCacheDir: scratch },
              }),
              Layer.succeed(HostProcess.HomeDirectory, root),
              Layer.succeed(HostProcess.Platform, "linux"),
            ),
          ),
        );
      };
      return {
        root,
        helper,
        model: modelPath,
        scratch,
        configure,
        layer: await configure(helperSource("")),
      };
    }),
    test,
    (fixture) => Effect.promise(() => NodeFSP.rm(fixture.root, { recursive: true, force: true })),
  );

it("resamples bounded PCM24 into the companion's mono PCM16 WAV", () => {
  const wav = Buffer.from(Dictation.museDictationWav(pcm));
  assert.strictEqual(wav.length, 52);
  assert.strictEqual(wav.readUInt32LE(4), 44);
  assert.strictEqual(wav.readUInt32LE(40), 8);
  assert.deepStrictEqual(
    [0, 1, 2, 3].map((index) => wav.readInt16LE(44 + index * 2)),
    [0, 1_500, 3_000, 4_500],
  );
  for (const invalid of [
    new Uint8Array(0),
    new Uint8Array(7),
    new Uint8Array(MUSE_DICTATION_MAX_BYTES + 2),
  ])
    assert.throws(() => Dictation.museDictationWav(invalid));
});

it.effect(
  "detects verified speech assets without launching the helper, then transcribes into private cleaned scratch",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const dictation = yield* Dictation.MuseAgentDictation;
        assert.deepStrictEqual(yield* dictation.status, {
          available: true,
          engineDetected: true,
          modelDetected: true,
          local: true,
          sampleRateHz: 24_000,
          maxAudioSeconds: 60,
          reason: "ready",
        });
        assert.strictEqual(
          yield* Effect.promise(() =>
            NodeFSP.access(f.scratch).then(
              () => true,
              () => false,
            ),
          ),
          false,
        );
        assert.deepStrictEqual(yield* dictation.transcribe({ pcm }), {
          text: "Synthetic dictation",
        });
        assert.deepStrictEqual(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(f.scratch, "muse-dictation"))),
          [],
        );
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect(
  "invalidates a cached model when its content changes and never downloads a replacement",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const dictation = yield* Dictation.MuseAgentDictation;
        assert.strictEqual((yield* dictation.status).available, true);
        yield* Effect.promise(() => NodeFSP.writeFile(f.model, Buffer.alloc(model.length, 88)));
        assert.strictEqual((yield* dictation.status).reason, "model_missing");
        assert.strictEqual((yield* Effect.flip(dictation.transcribe({ pcm }))).kind, "unavailable");
        assert.strictEqual(
          yield* Effect.promise(() =>
            NodeFSP.access(f.scratch).then(
              () => true,
              () => false,
            ),
          ),
          false,
        );
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect.each([
  { label: "silence", source: helperSource("", "[noise]"), kind: "no_speech" },
  { label: "bounded transcript", source: helperSource("", "X".repeat(64_001)), kind: "failed" },
  { label: "helper deadline", source: helperSource("setInterval(()=>{},1000);"), kind: "timeout" },
  {
    label: "model changes during recognition",
    source: helperSource("fs.appendFileSync(arg('-m'),'changed');finish();"),
    kind: "unavailable",
  },
] as const)(
  "handles $label with a safe error and removes recorded audio",
  ({ label, source, kind }) =>
    withFixture((f) =>
      Effect.gen(function* () {
        const layer = yield* Effect.promise(() =>
          f.configure(source, { timeoutMs: label === "helper deadline" ? 50 : 30_000 }),
        );
        yield* Effect.gen(function* () {
          const dictation = yield* Dictation.MuseAgentDictation;
          const error = yield* Effect.flip(dictation.transcribe({ pcm }));
          assert.strictEqual(error.kind, kind);
          assert.ok(!error.message.includes(f.root));
          assert.deepStrictEqual(
            yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(f.scratch, "muse-dictation")),
            ),
            [],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "cancels only its owned helper on interruption and rejects concurrent transcription",
  () =>
    withFixture((f) =>
      Effect.scoped(
        Effect.gen(function* () {
          const socketPath = NodePath.join(f.root, "started.sock");
          let connected: (socket: NodeNet.Socket) => void = () => {};
          const connection = new Promise<NodeNet.Socket>((resolve) => {
            connected = resolve;
          });
          const server = NodeNet.createServer((socket) => connected(socket));
          yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  server.once("error", reject);
                  server.listen(socketPath, resolve);
                }),
            ),
            () =>
              Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
          );
          const layer = yield* Effect.promise(() =>
            f.configure(
              helperSource(
                `const net=require('node:net');const socket=net.connect(${JSON.stringify(socketPath)});socket.on('data',()=>{finish();socket.end();});`,
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const dictation = yield* Dictation.MuseAgentDictation;
            const running = yield* dictation.transcribe({ pcm }).pipe(Effect.forkScoped);
            const socket = yield* Effect.promise(() => connection);
            const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
            assert.strictEqual((yield* Effect.flip(dictation.transcribe({ pcm }))).kind, "busy");
            yield* Fiber.interrupt(running);
            yield* Effect.promise(() => closed);
            assert.deepStrictEqual(
              yield* Effect.promise(() =>
                NodeFSP.readdir(NodePath.join(f.scratch, "muse-dictation")),
              ),
              [],
            );
          }).pipe(Effect.provide(layer));
        }),
      ),
    ),
);
