import { describe, expect, it } from "vite-plus/test";

import { assertCustomMobileCloudConfig } from "./custom-mobile-config.ts";
import { resolvePublicConfig } from "./public-config.ts";

const configured = {
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_example",
  T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
  T3CODE_RELAY_URL: "https://relay.example.test",
};

describe("custom mobile cloud configuration", () => {
  it("rejects each missing setting before building an APK", () => {
    for (const key of Object.keys(configured)) {
      expect(() =>
        assertCustomMobileCloudConfig(resolvePublicConfig({ ...configured, [key]: "" }), false),
      ).toThrow("Custom APK cloud configuration is missing");
    }
  });

  it("accepts configured cloud builds", () => {
    expect(() =>
      assertCustomMobileCloudConfig(resolvePublicConfig(configured), false),
    ).not.toThrow();
  });

  it("requires an explicit offline-only choice for an unconfigured build", () => {
    expect(() => assertCustomMobileCloudConfig(resolvePublicConfig({}), true)).not.toThrow();
  });
});
