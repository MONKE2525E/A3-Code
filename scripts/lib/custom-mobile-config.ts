import type { T3CodePublicConfig } from "./public-config.ts";

/** Cloud routes must remain usable unless the builder explicitly requests a LAN-only APK. */
export function assertCustomMobileCloudConfig(
  config: T3CodePublicConfig,
  offlineOnly: boolean,
): void {
  if (offlineOnly) return;
  if (!config.clerkPublishableKey || !config.clerkJwtTemplate || !config.relayUrl) {
    throw new Error(
      "Custom APK cloud configuration is missing. Configure the Clerk publishable key, JWT template, and relay URL in the root .env before building. Use --offline-only only for a build without T3 Connect.",
    );
  }
}
