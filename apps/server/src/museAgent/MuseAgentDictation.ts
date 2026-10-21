// @effect-diagnostics nodeBuiltinImport:off -- This boundary discovers the installed Linux speech helper and owns its private audio files and subprocess.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  MUSE_DICTATION_SAMPLE_RATE,
  MUSE_DICTATION_MAX_SECONDS,
  MUSE_DICTATION_MAX_BYTES,
  MuseAgentDictationLanguage,
  type MuseAgentDictationStatus,
} from "@t3tools/contracts/museAgentDictation";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const isLanguage = Schema.is(MuseAgentDictationLanguage);
const MODEL = {
  sizeBytes: 77_691_713,
  sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
};

export class MuseAgentDictationError extends Schema.TaggedError<MuseAgentDictationError>()(
  "MuseAgentDictationError",
  {
    kind: Schema.Literals([
      "unavailable",
      "invalid_audio",
      "busy",
      "timeout",
      "failed",
      "no_speech",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.kind) {
      case "unavailable":
        return "Open Muse for Linux and prepare its speech model to use local dictation.";
      case "invalid_audio":
        return "Dictation requires at most 60 seconds of 24 kHz mono PCM16 audio.";
      case "busy":
        return "Another dictation is still being transcribed.";
      case "timeout":
        return "Local speech recognition timed out. Try a shorter recording.";
      case "no_speech":
        return "No speech was detected in this recording.";
      case "failed":
        return "Local speech recognition failed. Try again.";
    }
  }
}

export class MuseAgentDictation extends Context.Service<
  MuseAgentDictation,
  {
    readonly status: Effect.Effect<MuseAgentDictationStatus>;
    /** Audio is supplied by an explicit client recording. This service never opens a microphone. */
    readonly transcribe: (input: {
      readonly pcm: Uint8Array;
      readonly language?: MuseAgentDictationLanguage;
    }) => Effect.Effect<{ readonly text: string }, MuseAgentDictationError>;
  }
>()("t3/museAgent/MuseAgentDictation") {}
const isDictationError = Schema.is(MuseAgentDictationError);

/** The companion's whisper helper consumes a 16 kHz mono WAV, while Muse captures at 24 kHz. */
export function museDictationWav(pcm: Uint8Array): Uint8Array {
  if (pcm.length < 6 || pcm.length % 2 !== 0 || pcm.length > MUSE_DICTATION_MAX_BYTES)
    throw new MuseAgentDictationError({ kind: "invalid_audio" });
  const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const sampleCount = Math.floor(((pcm.length / 2) * 2) / 3);
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + sampleCount * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index++) {
    const position = index * 1.5,
      left = Math.floor(position),
      fraction = position - left;
    const first = input.getInt16(left * 2, true),
      second = input.getInt16(Math.min(left + 1, pcm.length / 2 - 1) * 2, true);
    wav.writeInt16LE(Math.round(first * (1 - fraction) + second * fraction), 44 + index * 2);
  }
  return wav;
}

const identity = async (file: string) => {
  const realPath = await NodeFSP.realpath(file);
  const stat = await NodeFSP.stat(realPath, { bigint: true });
  if (!stat.isFile()) throw new Error("not_a_file");
  return {
    realPath,
    size: stat.size,
    key: [realPath, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"),
  };
};

/** Discovery overrides are host configuration, never accepted from an RPC or audio request. */
export const makeMuseAgentDictationLayer = (
  options: {
    readonly helperPath?: string;
    readonly modelPath?: string;
    readonly modelManifest?: { readonly sizeBytes: number; readonly sha256: string };
    readonly procRoot?: string;
    readonly timeoutMs?: number;
  } = {},
) =>
  Layer.effect(
    MuseAgentDictation,
    Effect.gen(function* () {
      const home = yield* HostProcess.HomeDirectory;
      const platform = yield* HostProcess.Platform;
      const host = yield* ProviderHost.ProviderHost;
      const manifest = options.modelManifest ?? MODEL;
      let verifiedModel: string | undefined;
      let busy = false;
      const helperCandidates = async () => {
        if (options.helperPath) return [options.helperPath];
        const candidates = new Set([
          NodePath.join(home, ".local/opt/muse-linux/resources/native/whisper-cli"),
          "/opt/Muse for Linux/resources/native/whisper-cli",
          "/opt/muse-linux/resources/native/whisper-cli",
        ]);
        const procRoot = options.procRoot ?? "/proc";
        for (const pid of (await NodeFSP.readdir(procRoot).catch(() => [])).filter((name) =>
          /^\d+$/.test(name),
        )) {
          const executable = await NodeFSP.readlink(NodePath.join(procRoot, pid, "exe")).catch(
            () => "",
          );
          if (NodePath.basename(executable) === "muse-linux")
            candidates.add(
              NodePath.join(NodePath.dirname(executable), "resources/native/whisper-cli"),
            );
        }
        return [...candidates];
      };
      const modelCandidates = async () => {
        if (options.modelPath) return [options.modelPath];
        const desktop = await NodeFSP.readFile(
          NodePath.join(home, ".local/share/applications/io.muse.linux.desktop"),
          "utf8",
        ).catch(() => "");
        const selected = desktop.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/);
        const configured = selected?.[1] ?? selected?.[2] ?? selected?.[3];
        return [
          ...new Set([
            ...(configured ? [NodePath.join(configured, "speech/ggml-tiny.bin")] : []),
            NodePath.join(home, ".config/muse-linux/speech/ggml-tiny.bin"),
            NodePath.join(home, ".config/muse-linux-dev/speech/ggml-tiny.bin"),
          ]),
        ];
      };
      const discover = async () => {
        let helper: Awaited<ReturnType<typeof identity>> | undefined;
        let model: Awaited<ReturnType<typeof identity>> | undefined;
        if (platform !== "linux") return { helper, model };
        for (const path of await helperCandidates()) {
          try {
            const found = await identity(path);
            await NodeFSP.access(found.realPath, NodeFS.constants.X_OK);
            helper = found;
            break;
          } catch {
            /* Optional installed candidates. */
          }
        }
        for (const path of await modelCandidates()) {
          try {
            const found = await identity(path);
            if (found.size !== BigInt(manifest.sizeBytes)) continue;
            if (verifiedModel !== found.key) {
              const hash = NodeCrypto.createHash("sha256");
              let bytes = 0;
              for await (const chunk of NodeFS.createReadStream(found.realPath)) {
                bytes += chunk.length;
                if (bytes > manifest.sizeBytes) throw new Error("model_size_changed");
                hash.update(chunk);
              }
              if (
                bytes !== manifest.sizeBytes ||
                hash.digest("hex") !== manifest.sha256 ||
                (await identity(found.realPath)).key !== found.key
              )
                continue;
              verifiedModel = found.key;
            }
            model = found;
            break;
          } catch {
            /* Missing or changed models are unavailable, never downloaded. */
          }
        }
        return { helper, model };
      };
      const status = Effect.promise(discover).pipe(
        Effect.map(
          ({ helper, model }) =>
            ({
              available: helper !== undefined && model !== undefined,
              engineDetected: helper !== undefined,
              modelDetected: model !== undefined,
              local: true as const,
              sampleRateHz: MUSE_DICTATION_SAMPLE_RATE,
              maxAudioSeconds: MUSE_DICTATION_MAX_SECONDS,
              reason:
                platform !== "linux"
                  ? ("unsupported_host" as const)
                  : !helper
                    ? ("engine_missing" as const)
                    : !model
                      ? ("model_missing" as const)
                      : ("ready" as const),
            }) satisfies MuseAgentDictationStatus,
        ),
      );
      const transcribe = (input: {
        readonly pcm: Uint8Array;
        readonly language?: MuseAgentDictationLanguage;
      }) =>
        Effect.suspend(() => {
          if (busy) return Effect.fail(new MuseAgentDictationError({ kind: "busy" }));
          busy = true;
          return Effect.gen(function* () {
            const wav = yield* Effect.try({
              try: () => museDictationWav(input.pcm),
              catch: (cause) => new MuseAgentDictationError({ kind: "invalid_audio", cause }),
            });
            const language = input.language ?? "auto";
            if (!isLanguage(language))
              return yield* new MuseAgentDictationError({ kind: "invalid_audio" });
            const { helper, model } = yield* Effect.tryPromise({
              try: discover,
              catch: (cause) => new MuseAgentDictationError({ kind: "unavailable", cause }),
            });
            if (!helper || !model)
              return yield* new MuseAgentDictationError({ kind: "unavailable" });
            return yield* Effect.acquireUseRelease(
              Effect.tryPromise({
                try: async () => {
                  const root = NodePath.join(host.paths.providerStatusCacheDir, "muse-dictation");
                  await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
                  return NodeFSP.mkdtemp(NodePath.join(root, "recording-"));
                },
                catch: (cause) => new MuseAgentDictationError({ kind: "failed", cause }),
              }),
              (directory) =>
                Effect.tryPromise({
                  try: async (signal) => {
                    const audio = NodePath.join(directory, "audio.wav"),
                      prefix = NodePath.join(directory, "transcript");
                    await NodeFSP.writeFile(audio, wav, { mode: 0o600 });
                    await new Promise<void>((resolve, reject) => {
                      NodeChildProcess.execFile(
                        helper.realPath,
                        [
                          "-m",
                          model.realPath,
                          "-f",
                          audio,
                          "-l",
                          language,
                          "-otxt",
                          "-of",
                          prefix,
                          "-nt",
                          "-np",
                          "--no-gpu",
                          "-t",
                          "4",
                        ],
                        {
                          timeout: options.timeoutMs ?? 30_000,
                          killSignal: "SIGKILL",
                          maxBuffer: 1024 * 1024,
                          signal,
                          windowsHide: true,
                        },
                        (error) => (error ? reject(error) : resolve()),
                      );
                    });
                    if (
                      (await identity(helper.realPath)).key !== helper.key ||
                      (await identity(model.realPath)).key !== model.key
                    )
                      throw new MuseAgentDictationError({ kind: "unavailable" });
                    const output = prefix + ".txt";
                    await NodeFSP.chmod(output, 0o600);
                    if ((await NodeFSP.stat(output)).size > 64_000)
                      throw new MuseAgentDictationError({ kind: "failed" });
                    const text = (await NodeFSP.readFile(output, "utf8")).trim().slice(0, 16_000);
                    if (!text || /^\[.*\]$/.test(text))
                      throw new MuseAgentDictationError({ kind: "no_speech" });
                    return { text };
                  },
                  catch: (cause) =>
                    isDictationError(cause)
                      ? cause
                      : new MuseAgentDictationError({
                          kind:
                            typeof cause === "object" &&
                            cause !== null &&
                            "killed" in cause &&
                            cause.killed === true
                              ? "timeout"
                              : "failed",
                          cause,
                        }),
                }),
              (directory) =>
                Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
            );
          }).pipe(
            Effect.timeoutOrElse({
              duration: options.timeoutMs ?? 30_000,
              orElse: () => Effect.fail(new MuseAgentDictationError({ kind: "timeout" })),
            }),
            Effect.ensuring(
              Effect.sync(() => {
                busy = false;
              }),
            ),
          );
        });
      return MuseAgentDictation.of({ status, transcribe });
    }),
  );

export const layer = makeMuseAgentDictationLayer();
