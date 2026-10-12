import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";

import * as ServerConfig from "../config.ts";

const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const Manifest = Schema.Struct({
  apiVersion: Schema.Literal(1),
  version: Schema.String.check(Schema.isPattern(/^[\w.-]{1,64}$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));

export class GrokBotAvatarEngineMissingError extends Schema.TaggedError<GrokBotAvatarEngineMissingError>()(
  "GrokBotAvatarEngineMissingError",
  {},
) {
  override get message(): string {
    return "The local Grok Bot avatar engine is not installed.";
  }
}

export class GrokBotAvatarEngineReadError extends Schema.TaggedError<GrokBotAvatarEngineReadError>()(
  "GrokBotAvatarEngineReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The local Grok Bot avatar engine could not be read.";
  }
}

export class GrokBotAvatarEngine extends Context.Service<
  GrokBotAvatarEngine,
  {
    readonly read: (
      sha256?: string,
    ) => Effect.Effect<
      { readonly version: string; readonly sha256: string; readonly source: string },
      GrokBotAvatarEngineMissingError | GrokBotAvatarEngineReadError
    >;
  }
>()("t3/grokBot/GrokBotAvatarEngine") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  // Installer-owned assets live outside the web and server build inputs.
  const directory = path.join(config.baseDir, "integrations", "grokbot");
  const readBounded = Effect.fnUntraced(function* (filePath: string, maxBytes: number) {
    const info = yield* fs.stat(filePath);
    if (Number(info.size) > maxBytes || info.type !== "File") {
      return yield* new GrokBotAvatarEngineReadError({
        cause: new Error("Invalid asset size or type"),
      });
    }
    const bytes = yield* fs.readFile(filePath);
    if (bytes.byteLength > maxBytes) {
      return yield* new GrokBotAvatarEngineReadError({
        cause: new Error("Asset exceeds size limit"),
      });
    }
    return bytes;
  });
  const read = Effect.fn("GrokBotAvatarEngine.read")(
    function* (sha256?: string) {
      const manifestBytes = yield* readBounded(path.join(directory, "manifest.json"), 16 * 1024);
      const manifest = yield* decodeManifest(new TextDecoder().decode(manifestBytes)).pipe(
        Effect.mapError((cause) => new GrokBotAvatarEngineReadError({ cause })),
      );
      if (sha256 !== undefined && sha256 !== manifest.sha256) {
        return yield* new GrokBotAvatarEngineMissingError({});
      }
      const bytes = yield* readBounded(
        path.join(directory, `${manifest.sha256}.mjs`),
        MAX_MODULE_BYTES,
      );
      const digest = yield* crypto.digest("SHA-256", bytes).pipe(
        Effect.map(Hex.encode),
        Effect.mapError((cause) => new GrokBotAvatarEngineReadError({ cause })),
      );
      if (digest !== manifest.sha256) {
        return yield* new GrokBotAvatarEngineReadError({
          cause: new Error("Asset digest mismatch"),
        });
      }
      return {
        version: manifest.version,
        sha256: manifest.sha256,
        source: new TextDecoder().decode(bytes),
      };
    },
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.fail(new GrokBotAvatarEngineMissingError({}))
          : Effect.fail(new GrokBotAvatarEngineReadError({ cause })),
    }),
  );
  return GrokBotAvatarEngine.of({ read });
});

export const layer = Layer.effect(GrokBotAvatarEngine, make);
