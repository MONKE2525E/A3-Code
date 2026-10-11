// @effect-diagnostics nodeBuiltinImport:off - standalone installer CLI uses Node files and syntax-check subprocesses at its application boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  createGrokBotAvatarModule,
  extractGrokBotAvatarRenderer,
} from "./lib/grokBotAvatarEngine.ts";

// Reads the unpacked platform bundle or an extracted renderer; never launches the installer or app.
const { values } = NodeUtil.parseArgs({
  options: {
    source: { type: "string" },
    bundle: { type: "string" },
    version: { type: "string" },
    "home-dir": { type: "string" },
    installer: { type: "string" },
  },
});
if (
  (!values.source && !values.bundle) ||
  (values.source && values.bundle) ||
  !values.version ||
  !values["home-dir"] ||
  !/^[\w.-]{1,64}$/.test(values.version)
) {
  throw new Error(
    "Usage: node scripts/install-grok-bot-avatar-engine.ts (--bundle <index.eager-platform-*.js> | --source <extracted-renderer.js>) --version <version> --home-dir <isolated-t3-home> [--installer <installer-file>]",
  );
}
const sourcePath = NodePath.resolve((values.bundle ?? values.source)!);
if ((await NodeFSP.stat(sourcePath)).size > (values.bundle ? 10 : 2) * 1024 * 1024)
  throw new Error("Renderer input exceeds the size limit.");
const original = await NodeFSP.readFile(sourcePath);
const renderer = values.bundle
  ? extractGrokBotAvatarRenderer(original.toString("utf8"), values.version)
  : original.toString("utf8");
const module = createGrokBotAvatarModule(renderer);
if (Buffer.byteLength(module) > 2 * 1024 * 1024)
  throw new Error("Renderer exceeds the 2 MiB limit.");
const sha256 = NodeCrypto.createHash("sha256").update(module).digest("hex");
const directory = NodePath.join(NodePath.resolve(values["home-dir"]), "integrations", "grokbot");
await NodeFSP.mkdir(directory, { recursive: true });
const temporaryModule = NodePath.join(directory, `${sha256}.tmp.mjs`);
try {
  await NodeFSP.writeFile(temporaryModule, module, { mode: 0o600 });
  // Syntax checking parses the module without executing its contents.
  NodeChildProcess.execFileSync(process.execPath, ["--check", temporaryModule], {
    stdio: "pipe",
    timeout: 10_000,
  });
  await NodeFSP.rename(temporaryModule, NodePath.join(directory, `${sha256}.mjs`));
} finally {
  await NodeFSP.rm(temporaryModule, { force: true });
}
const manifest = {
  apiVersion: 1,
  version: values.version,
  sha256,
  provenance: {
    sourcePath,
    sourceSha256: NodeCrypto.createHash("sha256").update(original).digest("hex"),
    ...(values.installer
      ? {
          installerPath: NodePath.resolve(values.installer),
          installerSha256: NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(values.installer))
            .digest("hex"),
        }
      : {}),
  },
};
const temporaryManifest = NodePath.join(directory, "manifest.tmp.json");
await NodeFSP.writeFile(temporaryManifest, JSON.stringify(manifest, null, 2), { mode: 0o600 });
await NodeFSP.rename(temporaryManifest, NodePath.join(directory, "manifest.json"));
process.stdout.write(
  `Installed local avatar engine ${values.version} (${sha256}) in ${directory}\n`,
);
