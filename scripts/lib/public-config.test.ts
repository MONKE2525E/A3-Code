// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("keeps Connect available in a clean GrokBot build", () => {
    const config = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });
    expect(config.T3CODE_RELAY_URL).toBe("https://relay.t3.codes");
    expect(config.VITE_CLERK_PUBLISHABLE_KEY).toBe("pk_live_Y2xlcmsudDMuY29kZXMk");
    expect(config.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBe("t3-relay");
    expect(config.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID).toBe("hzxSgY2cH10sDU2r");
  });

  it("does not combine a private relay with production credentials", () => {
    const config = loadRepoEnv({
      baseEnv: { T3CODE_RELAY_URL: "https://private.example.test" },
      repoRoot: makeTemporaryDirectory(),
    });
    expect(config.T3CODE_RELAY_URL).toBe("https://private.example.test");
    expect(config.T3CODE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
  });

  it("can explicitly build without Connect", () => {
    const config = loadRepoEnv({
      baseEnv: { T3CODE_CONNECT_ENABLED: "0", VITE_CLERK_PUBLISHABLE_KEY: "pk_test_old" },
      repoRoot: makeTemporaryDirectory(),
    });
    expect(config.T3CODE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(config.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(config.T3CODE_RELAY_URL).toBeUndefined();
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
