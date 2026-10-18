// @effect-diagnostics nodeBuiltinImport:off -- Native SQLite fixtures exercise the readonly Chromium cookie boundary.
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Integration from "../preview/IntegrationBrowser.ts";
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
              "PRAGMA journal_mode=WAL; CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB DEFAULT X'',path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,is_persistent INTEGER)",
            );
            const now = 1_700_000_000_000;
            const future = BigInt(11_644_473_600 + now / 1000 + 3600) * 1_000_000n;
            const insert = db.prepare(
              "INSERT INTO cookies(host_key,name,value,path,expires_utc,is_secure,is_httponly,samesite,is_persistent) VALUES(?,?,?,?,?,?,?,?,?)",
            );
            insert.run(".muse.ai", "fixture", "synthetic", "/", future, 1, 1, 1, 1);
            insert.run("muse.ai", "expired", "synthetic", "/", future - 7_200_000_000n, 1, 0, 2, 1);
            insert.run("login.muse.ai", "session", "synthetic", "/", 0, 1, 0, 0, 0);
            insert.run("muse.ai", "unspecified", "synthetic", "/", future, 1, 1, -1, 1);
            insert.run("muse.ai.attacker.invalid", "foreign", "synthetic", "/", future, 1, 0, 0, 1);
            insert.run("muse.ai", "encrypted-only", "", "/", future, 1, 0, 0, 1);
            const before = yield* Effect.promise(() => NodeFSP.readFile(file));
            const cookies = Source.readMuseSessionCookies(file, now, "linux");
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

it.effect("uses the private T3 browser session without an installed Muse companion", () =>
  Effect.gen(function* () {
    const source = yield* Source.MuseAgentSessionSource;
    assert.deepStrictEqual(yield* source.inspect, { installed: true, sessionPresent: true });
    const session = yield* source.read;
    assert.equal(session.source, "t3-browser");
    assert.equal(session.profilePath, "");
    assert.equal(session.cookies[0]?.value, "synthetic-browser-cookie");
    assert.match(session.fingerprint, /^[a-f0-9]{64}$/);
  }).pipe(
    Effect.provide(
      Source.makeMuseAgentSessionSourceLayer({ homeDir: "/nonexistent-synthetic-muse-home" }).pipe(
        Layer.provide(
          Layer.mock(Integration.IntegrationBrowser)({
            museCookies: Effect.succeed([
              {
                name: "session",
                value: "synthetic-browser-cookie",
                domain: "muse.ai",
                path: "/",
                expires: -1,
                httpOnly: true,
                secure: true,
                sameSite: "Lax",
              },
            ]),
          }),
        ),
      ),
    ),
  ),
);

it.effect.each(["current", "legacy", "both"] as const)(
  "discovers %s Muse cookie jars and prefers the current Chromium location",
  (layout) =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-profile-"))),
      (profilePath) =>
        Effect.gen(function* () {
          const paths =
            layout === "both"
              ? ["Cookies", "Network/Cookies"]
              : [layout === "current" ? "Network/Cookies" : "Cookies"];
          for (const relativePath of paths) {
            const file = NodePath.join(profilePath, "Partitions/muse", relativePath);
            yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(file), { recursive: true }));
            const db = new NodeSqlite.DatabaseSync(file);
            try {
              db.exec(
                "CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB DEFAULT X'',path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,is_persistent INTEGER)",
              );
              db.prepare(
                "INSERT INTO cookies(host_key,name,value,path,expires_utc,is_secure,is_httponly,samesite,is_persistent) VALUES(?,?,?,?,?,?,?,?,?)",
              ).run("muse.ai", "session", relativePath, "/", 0, 1, 1, 1, 0);
            } finally {
              db.close();
            }
          }
          yield* Effect.gen(function* () {
            const source = yield* Source.MuseAgentSessionSource;
            assert.deepStrictEqual(yield* source.inspect, {
              installed: true,
              sessionPresent: true,
            });
            const session = yield* source.read;
            assert.equal(
              session.profilePath,
              yield* Effect.promise(() => NodeFSP.realpath(profilePath)),
            );
            assert.equal(
              session.cookies[0]?.value,
              layout === "legacy" ? "Cookies" : "Network/Cookies",
            );
          }).pipe(Effect.provide(Source.makeMuseAgentSessionSourceLayer({ profilePath })));
        }),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    ),
);

it.effect.each([23, 24])("reads encrypted Linux basic-store cookies at schema %s", (version) =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-encrypted-cookies-")),
    ),
    (directory) =>
      Effect.gen(function* () {
        const file = NodePath.join(directory, "Cookies");
        const db = new NodeSqlite.DatabaseSync(file);
        try {
          db.exec(
            "CREATE TABLE meta(key TEXT,value TEXT); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,is_persistent INTEGER)",
          );
          db.prepare("INSERT INTO meta VALUES('version',?)").run(String(version));
          const encrypt = (value: string | Uint8Array, host: string, passphrase = "peanuts") => {
            const contents = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
            const key = NodeCrypto.pbkdf2Sync(passphrase, "saltysalt", 1, 16, "sha1");
            const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
            const plaintext =
              version >= 24
                ? Buffer.concat([NodeCrypto.createHash("sha256").update(host).digest(), contents])
                : contents;
            return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
          };
          const insert = db.prepare("INSERT INTO cookies VALUES('muse.ai',?,?,?,'/',0,1,1,1,0)");
          insert.run("encrypted", "", encrypt("synthetic-encrypted", "muse.ai"));
          insert.run("empty-fallback", "", encrypt("synthetic-empty-key", "muse.ai", ""));
          insert.run("keyring", "stale-plaintext", Buffer.from("v11unavailable-keyring"));
          insert.run("corrupt", "", Buffer.from("v10corrupt"));
          insert.run("invalid-utf8", "", encrypt(new Uint8Array([0xff, 0xff]), "muse.ai"));
          if (version >= 24)
            insert.run("wrong-domain", "", encrypt("synthetic-foreign", "foreign.invalid"));
          const before = yield* Effect.promise(() => NodeFSP.readFile(file));
          assert.deepStrictEqual(
            Source.readMuseSessionCookies(file, 1_700_000_000_000, "linux").map(
              ({ name, value }) => [name, value],
            ),
            [
              ["encrypted", "synthetic-encrypted"],
              ["empty-fallback", "synthetic-empty-key"],
            ],
          );
          assert.deepStrictEqual(
            Source.readMuseSessionCookies(file, 1_700_000_000_000, "win32"),
            [],
          );
          assert.deepStrictEqual(
            Source.readMuseSessionCookies(file, 1_700_000_000_000, "darwin"),
            [],
          );
          assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readFile(file)), before);
          for (const invalidVersion of ["invalid", null, "", "  "]) {
            db.prepare("UPDATE meta SET value=? WHERE key='version'").run(invalidVersion);
            assert.deepStrictEqual(
              Source.readMuseSessionCookies(file, 1_700_000_000_000, "linux"),
              [],
            );
          }
          db.exec("DROP TABLE meta");
          assert.deepStrictEqual(
            Source.readMuseSessionCookies(file, 1_700_000_000_000, "linux"),
            [],
          );
        } finally {
          db.close();
        }
      }),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  ),
);
