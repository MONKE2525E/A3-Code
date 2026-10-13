import { describe, expect, it } from "vite-plus/test";

import { instanceFromDescriptor, pickVideoVariant } from "./useMuseAgentAvatar";

describe("instanceFromDescriptor", () => {
  it("reads the encoded provider instance from the server's descriptor path", () => {
    const url = `/api/ai-agents/muse/${encodeURIComponent("muse:work")}/avatar/image?revision=${"a".repeat(64)}`;
    expect(instanceFromDescriptor(url)).toBe("muse:work");
  });

  it("returns null for missing or foreign URLs", () => {
    expect(instanceFromDescriptor(undefined)).toBeNull();
    expect(instanceFromDescriptor("https://example.com/a.png")).toBeNull();
    expect(instanceFromDescriptor("/api/ai-agents/muse/%E0%A4%A/avatar/image")).toBeNull();
  });
});

describe("pickVideoVariant", () => {
  it("returns the variant key whose clip the avatar would play, preferring idle", () => {
    expect(pickVideoVariant({ talking: "/t", idle: "/i" })).toBe("idle");
    expect(pickVideoVariant({ talking: "/t" })).toBe("talking");
    expect(pickVideoVariant({})).toBeNull();
    expect(pickVideoVariant(undefined)).toBeNull();
  });
});
