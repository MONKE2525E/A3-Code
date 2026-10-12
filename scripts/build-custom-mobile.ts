// @effect-diagnostics nodeBuiltinImport:off - Standalone native build bootstrap uses synchronous tools before the app runtime exists.
// @effect-diagnostics globalConsole:off - Print the generated artifact path for the standalone CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { assertCustomMobileCloudConfig } from "./lib/custom-mobile-config.ts";
import { loadRepoEnv, resolvePublicConfig } from "./lib/public-config.ts";

const hostPlatform = Effect.runSync(HostProcessPlatform);
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const repoEnv = loadRepoEnv({ repoRoot: root });
assertCustomMobileCloudConfig(
  resolvePublicConfig(repoEnv),
  process.argv.includes("--offline-only"),
);
const mobile = NodePath.join(root, "apps/mobile");
const signingDir = NodePath.join(NodeOS.homedir(), ".local/share/t3-custom-mobile");
const keyPath = NodePath.join(signingDir, "release.keystore");
const passwordPath = NodePath.join(signingDir, "password");
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const buildNumber =
  process.env.T3CODE_MOBILE_BUILD_NUMBER ??
  String(Math.floor(Effect.runSync(Clock.currentTimeMillis) / 1000));
if (!sdk) throw new Error("Set ANDROID_HOME to your Android SDK directory.");
const env = {
  ...repoEnv,
  ...(process.env.JAVA_HOME
    ? {
        PATH: `${NodePath.join(process.env.JAVA_HOME, "bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      }
    : {}),
  T3CODE_ANDROID_CUSTOM: "1",
  T3CODE_MOBILE_BUILD_NUMBER: buildNumber,
  APP_VARIANT: "preview",
};
function run(command: string, args: string[], cwd = mobile) {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
if (!process.argv.includes("--sign-only")) {
  run("pnpm", ["exec", "expo", "prebuild", "--clean", "--platform", "android", "--no-install"]);
  run(
    hostPlatform === "win32" ? "gradlew.bat" : "./gradlew",
    [
      "assembleRelease",
      `-PreactNativeArchitectures=${process.argv.includes("--emulator") ? "arm64-v8a,x86_64" : "arm64-v8a"}`,
      "--max-workers=4",
      "--console=plain",
    ],
    NodePath.join(mobile, "android"),
  );
}
NodeFS.mkdirSync(signingDir, { recursive: true, mode: 0o700 });
if (!NodeFS.existsSync(keyPath)) {
  if (!NodeFS.existsSync(passwordPath))
    NodeFS.writeFileSync(passwordPath, NodeCrypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const keytool = process.env.JAVA_HOME
    ? NodePath.join(process.env.JAVA_HOME, "bin/keytool")
    : "keytool";
  run(
    keytool,
    [
      "-genkeypair",
      "-keystore",
      keyPath,
      "-storetype",
      "PKCS12",
      "-storepass:file",
      passwordPath,
      "-keypass:file",
      passwordPath,
      "-alias",
      "t3-custom",
      "-keyalg",
      "RSA",
      "-keysize",
      "3072",
      "-validity",
      "10000",
      "-dname",
      "CN=T3 Code Custom",
    ],
    signingDir,
  );
}
// Keep the signing key outside the checkout so later APKs update this installation.
if (!NodeFS.readFileSync(passwordPath, "utf8").trim())
  throw new Error("The signing password file is empty.");
const outputDir = NodePath.join(root, ".t3/artifacts");
NodeFS.mkdirSync(outputDir, { recursive: true });
const output = NodePath.join(outputDir, "T3-Code-Custom.apk");
run(NodePath.join(sdk, "build-tools/36.0.0/apksigner"), [
  "sign",
  "--ks",
  keyPath,
  "--ks-key-alias",
  "t3-custom",
  "--ks-pass",
  `file:${passwordPath}`,
  "--out",
  output,
  NodePath.join(mobile, "android/app/build/outputs/apk/release/app-release.apk"),
]);
run(NodePath.join(sdk, "build-tools/36.0.0/apksigner"), ["verify", "--verbose", output]);
console.log(`Custom APK: ${output}`);
if (!process.argv.includes("--sign-only")) {
  console.log(`Release tag: mobile-build-${buildNumber}`);
}
