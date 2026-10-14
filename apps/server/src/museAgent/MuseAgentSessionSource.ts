// @effect-diagnostics-next-line nodeBuiltinImport:off -- Cookie fingerprints require synchronous hashing at the native SQLite boundary.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Profile discovery stays in the readonly Node cookie-source boundary.
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native profile paths are resolved in the same Node Promise boundary.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Cookie } from "playwright-core";

export class MuseAgentSessionSourceError extends Schema.TaggedError<MuseAgentSessionSourceError>()(
  "MuseAgentSessionSourceError",
  { stage: Schema.Literals(["detect", "read"]), cause: Schema.Defect() },
) {
  override get message() {
    return "The local Muse session could not be read. Open Muse and sign in again.";
  }
}

export type MuseAgentCookie = Omit<Cookie, "sameSite"> & { readonly sameSite: Cookie["sameSite"] };
export interface MuseAgentSessionSnapshot {
  readonly profilePath: string;
  readonly cookies: readonly MuseAgentCookie[];
  /** Private transport fingerprint; do not expose through status, logs, or RPC. */
  readonly fingerprint: string;
}

export class MuseAgentSessionSource extends Context.Service<
  MuseAgentSessionSource,
  {
    readonly inspect: Effect.Effect<
      { readonly installed: boolean; readonly sessionPresent: boolean },
      MuseAgentSessionSourceError
    >;
    readonly read: Effect.Effect<MuseAgentSessionSnapshot, MuseAgentSessionSourceError>;
  }
>()("t3/museAgent/MuseAgentSessionSource") {}

function museCookieDomain(host: string): boolean {
  const domain = host.replace(/^\./, "").toLowerCase();
  return domain === "muse.ai" || domain.endsWith(".muse.ai");
}

/** Opens the source readonly, including its WAL. No copies, checkpoints, or keychain writes. */
export function readMuseSessionCookies(cookiePath: string, nowMs: number): MuseAgentCookie[] {
  const db = new NodeSqlite.DatabaseSync(cookiePath, { readOnly: true });
  try {
    const statement = db.prepare(
      "SELECT host_key, name, value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite, is_persistent FROM cookies",
    );
    const rows = statement.all();
    return rows.flatMap((row) => {
      if (
        typeof row.host_key !== "string" ||
        !museCookieDomain(row.host_key) ||
        typeof row.name !== "string" ||
        typeof row.value !== "string" ||
        !row.value
      )
        return [];
      const expires = Number(row.expires_utc) / 1_000_000 - 11_644_473_600;
      if (!Number.isFinite(expires) || (row.is_persistent === 1 && expires <= nowMs / 1000))
        return [];
      return [
        {
          name: row.name,
          value: row.value,
          domain: row.host_key,
          path: typeof row.path === "string" && row.path.startsWith("/") ? row.path : "/",
          expires: row.is_persistent === 1 ? expires : -1,
          httpOnly: row.is_httponly === 1,
          secure: row.is_secure === 1,
          sameSite:
            row.samesite === 2
              ? ("Strict" as const)
              : row.samesite === 0
                ? ("None" as const)
                : ("Lax" as const),
        },
      ];
    });
  } finally {
    db.close();
  }
}

const exists = (file: string) =>
  NodeFSP.access(file).then(
    () => true,
    () => false,
  );

const makeMuseAgentSessionSourceLayer = (
  options: {
    readonly homeDir?: string;
    readonly profilePath?: string;
  } = {},
) =>
  Layer.effect(
    MuseAgentSessionSource,
    Effect.gen(function* () {
      const home = options.homeDir ?? (yield* HostProcess.HomeDirectory);
      const detect = async () => {
        const desktop = NodePath.join(home, ".local/share/applications/io.muse.linux.desktop");
        const contents = await NodeFSP.readFile(desktop, "utf8").catch(() => "");
        const selected = contents.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/);
        const configured = options.profilePath ?? selected?.[1] ?? selected?.[2] ?? selected?.[3];
        const candidates = configured
          ? [configured]
          : [
              NodePath.join(home, ".config/muse-linux"),
              NodePath.join(home, ".config/muse-linux-dev"),
            ];
        for (const candidate of candidates) {
          const cookiePath = NodePath.join(candidate, "Partitions/muse/Cookies");
          if (await exists(cookiePath))
            return { installed: true, profilePath: await NodeFSP.realpath(candidate), cookiePath };
        }
        return { installed: contents.length > 0, profilePath: null, cookiePath: null };
      };
      const read = Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          Effect.tryPromise({
            try: async () => {
              const source = await detect();
              if (!source.cookiePath || !source.profilePath) throw new Error("missing_session");
              const cookies = readMuseSessionCookies(source.cookiePath, nowMs);
              if (!cookies.length) throw new Error("missing_readable_session");
              const hash = NodeCrypto.createHash("sha256");
              for (const cookie of [...cookies].sort((a, b) =>
                `${a.domain}/${a.name}`.localeCompare(`${b.domain}/${b.name}`),
              )) {
                for (const field of [cookie.domain, cookie.name, cookie.path, cookie.value])
                  hash.update(field).update("\0");
              }
              const fingerprint = hash.digest("hex");
              return { profilePath: source.profilePath, cookies, fingerprint };
            },
            catch: (cause) => new MuseAgentSessionSourceError({ stage: "read", cause }),
          }),
        ),
      );
      return MuseAgentSessionSource.of({
        read,
        inspect: Clock.currentTimeMillis.pipe(
          Effect.flatMap((nowMs) =>
            Effect.tryPromise({
              try: async () => {
                const source = await detect();
                return {
                  installed: source.installed,
                  sessionPresent:
                    source.cookiePath !== null &&
                    readMuseSessionCookies(source.cookiePath, nowMs).length > 0,
                };
              },
              catch: (cause) => new MuseAgentSessionSourceError({ stage: "detect", cause }),
            }),
          ),
        ),
      });
    }),
  );

export const layer = makeMuseAgentSessionSourceLayer();
