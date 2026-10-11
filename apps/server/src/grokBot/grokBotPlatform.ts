/**
 * Platform-specific wording for Grok Bot bridge setup. The bridge is installed with `npm`, which
 * the process runner resolves to `npm.cmd` on Windows, so the only platform differences are what
 * the user must do when Node.js or the registry is not reachable.
 */

type HostPlatform = NodeJS.Platform;

const installNode = (platform: HostPlatform) =>
  platform === "win32"
    ? "Install Node.js LTS from nodejs.org (or run `winget install OpenJS.NodeJS.LTS`)"
    : platform === "darwin"
      ? "Install Node.js from nodejs.org (or run `brew install node`)"
      : "Install Node.js and npm with your package manager (for example `sudo apt install nodejs npm` or `sudo pacman -S nodejs npm`)";

export type SetupFailure =
  | { readonly kind: "npm_missing" }
  | { readonly kind: "timeout" }
  | { readonly kind: "install_failed"; readonly code: number }
  | { readonly kind: "unreadable" };

/** An actionable sentence for a failed bridge install; at most the contract's 500 characters. */
export function setupFailureDetail(platform: HostPlatform, failure: SetupFailure): string {
  switch (failure.kind) {
    case "npm_missing":
      return `npm was not found. ${installNode(platform)}, restart T3 Code so it sees the new PATH, then retry.`;
    case "timeout":
      return "Installing the Grok Bot bridge timed out. Check your network connection and npm registry access, then retry.";
    case "install_failed":
      return `npm could not install the Grok Bot bridge (exit ${failure.code}). Check your network connection and npm registry access, then retry.`;
    case "unreadable":
      return "The Grok Bot bridge was installed but could not be started. Retry the setup; if it persists, remove the integrations/grokbot folder in the T3 data directory first.";
  }
}
