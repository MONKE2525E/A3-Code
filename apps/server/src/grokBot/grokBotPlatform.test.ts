import { assert, it } from "@effect/vitest";
import { setupFailureDetail } from "./grokBotPlatform.ts";

it("names the install route for each platform when npm is missing", () => {
  const detail = (platform: NodeJS.Platform) =>
    setupFailureDetail(platform, { kind: "npm_missing" });
  assert.include(detail("win32"), "winget install OpenJS.NodeJS.LTS");
  assert.include(detail("darwin"), "brew install node");
  assert.include(detail("linux"), "package manager");
  for (const platform of ["win32", "darwin", "linux"] as const) {
    assert.isAtMost(detail(platform).length, 500);
    assert.include(detail(platform), "retry");
  }
});

it("keeps the registry and exit code guidance bounded", () => {
  assert.include(setupFailureDetail("linux", { kind: "install_failed", code: 1 }), "exit 1");
  assert.include(setupFailureDetail("win32", { kind: "timeout" }), "timed out");
  assert.isAtMost(setupFailureDetail("linux", { kind: "unreadable" }).length, 500);
});
