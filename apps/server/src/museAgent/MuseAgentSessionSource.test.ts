// @effect-diagnostics nodeBuiltinImport:off -- Native SQLite fixtures exercise the readonly Chromium cookie boundary.
import { assert, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Source from "./MuseAgentSessionSource.ts";

it.effect(
  "reads schema-24 expiry integers through text and keeps only readable unexpired Muse cookies without source writes",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-cookies-"))),
      (directory) =>
        Effect.gen(function* () {
          const file = NodePath.join(directory, "Cookies");
          const db = new NodeSqlite.DatabaseSync(file);
          try {
            db.exec(
              "PRAGMA journal_mode=WAL; CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,is_persistent INTEGER)",
            );
            const now = 1_700_000_000_000;
            const future = BigInt(11_644_473_600 + now / 1000 + 3600) * 1_000_000n;
            const insert = db.prepare("INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?)");
            insert.run(".muse.ai", "fixture", "synthetic", "/", future, 1, 1, 1, 1);
            insert.run("muse.ai", "expired", "synthetic", "/", future - 7_200_000_000n, 1, 0, 2, 1);
            insert.run("login.muse.ai", "session", "synthetic", "/", 0, 1, 0, 0, 0);
            insert.run("muse.ai", "unspecified", "synthetic", "/", future, 1, 1, -1, 1);
            insert.run("muse.ai.attacker.invalid", "foreign", "synthetic", "/", future, 1, 0, 0, 1);
            insert.run("muse.ai", "encrypted-only", "", "/", future, 1, 0, 0, 1);
            const before = yield* Effect.promise(() => NodeFSP.readFile(file));
            const cookies = Source.readMuseSessionCookies(file, now);
            assert.deepStrictEqual(
              cookies.map((cookie) => [cookie.name, cookie.expires, cookie.sameSite]),
              [
                ["fixture", now / 1000 + 3600, "Lax"],
                ["session", -1, "None"],
                ["unspecified", now / 1000 + 3600, "Lax"],
              ],
            );
            assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(file)), before);
            assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM cookies").get()?.count, 6);
          } finally {
            db.close();
          }
        }),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    ),
);
