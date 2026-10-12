export const FORK_RELEASES_URL = "https://github.com/MONKE2525E/t3code/releases";
export const FORK_RELEASES_API =
  "https://api.github.com/repos/MONKE2525E/t3code/releases?per_page=100";
export const FORK_APK_NAME = "T3-Code-Custom.apk";

export interface ForkReleaseUpdate {
  readonly build: number;
  readonly tag: string;
  readonly downloadUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Native version codes and release tags share the same increasing build number. */
export function selectForkReleaseUpdate(releases: unknown, installedBuild: number) {
  if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid release list.");
  let update: ForkReleaseUpdate | null = null;
  for (const release of releases) {
    if (!isRecord(release) || release.draft !== false || typeof release.tag_name !== "string")
      continue;
    const match = /^mobile-build-([1-9]\d*)$/.exec(release.tag_name);
    const build = Number(match?.[1]);
    if (
      !Number.isSafeInteger(build) ||
      build > 2_100_000_000 ||
      build <= installedBuild ||
      build <= (update?.build ?? 0)
    )
      continue;
    if (!Array.isArray(release.assets)) continue;
    const asset = release.assets.find(
      (value: unknown) =>
        isRecord(value) &&
        value.name === FORK_APK_NAME &&
        value.state === "uploaded" &&
        value.browser_download_url ===
          `${FORK_RELEASES_URL}/download/${release.tag_name}/${FORK_APK_NAME}`,
    );
    if (!isRecord(asset) || typeof asset.browser_download_url !== "string") continue;
    update = { build, tag: release.tag_name, downloadUrl: asset.browser_download_url };
  }
  return update;
}

export async function checkForkReleaseUpdate(
  installedBuild: number,
  request: typeof fetch = fetch,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await request(FORK_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Could not check GitHub releases (${response.status}). Try again later.`);
    return selectForkReleaseUpdate(await response.json(), installedBuild);
  } finally {
    clearTimeout(timeout);
  }
}
