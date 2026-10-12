import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["linux", "darwin", "win32"] as const)(
  "uses independent browser profiles on %s without reading official credentials",
  (platform) =>
    Effect.gen(function* () {
      const inspected: string[] = [];
      const fs = FileSystem.makeNoop({
        exists: (path) =>
          Effect.sync(() => {
            inspected.push(path);
            return false;
          }),
        readFileString: () => Effect.die("Official credentials must never be copied"),
      });
      const production = yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment: false,
        platform,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const development = yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment: true,
        platform,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      assert.equal(production, "/profiles/t3code-grokbot");
      assert.equal(development, "/profiles/t3code-grokbot-dev");
      assert.deepEqual(inspected, [production, development]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
