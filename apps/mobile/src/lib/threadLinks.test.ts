import { describe, expect, it } from "vite-plus/test";

import { parseThreadLink, resolveThreadLink } from "./threadLinks";

const target = { environmentId: "ENV", threadId: "THREAD" };

describe("parseThreadLink", () => {
  it.each([
    "https://example.ts.net:37668/ENV/THREAD",
    "https://example.ts.net/ENV/THREAD/",
    "https://monkespc-1.tail1e2217.ts.net:443/ENV/THREAD?source=indicator#thread",
    "t3code://thread/ENV/THREAD",
    "t3code-custom://thread/ENV/THREAD/",
    "t3code-dev://thread/ENV/THREAD",
    "t3code-preview://thread/ENV/THREAD",
  ])("reads %s", (url) => {
    expect(parseThreadLink(url)).toEqual({ kind: "thread", target });
  });

  it("decodes each ID exactly once, preserving encoded slashes, percent signs and spaces", () => {
    expect(
      parseThreadLink("https://example.ts.net:1234/env%20one%2Ftwo/thread%2F%2520%2B%E2%9C%93"),
    ).toEqual({
      kind: "thread",
      target: { environmentId: "env one/two", threadId: "thread/%20+✓" },
    });
  });

  it.each([
    "https://example.ts.net",
    "https://example.ts.net/ENV",
    "https://example.ts.net/ENV/THREAD/extra",
    "https://example.ts.net//THREAD",
    "https://example.ts.net/ENV//",
    "https://example.ts.net/ENV/THREAD//",
    "https://example.ts.net/%ZZ/THREAD",
    "https://example.ts.net/ENV/%E0%A4",
    "https://example.ts.net/%20/THREAD",
    "https://example.ts.net/%20ENV/THREAD",
    "https://example.ts.net/ENV/THREAD%20",
    "https://example.ts.net/%00/THREAD",
    "https://example.ts.net/../THREAD",
    "https://example.ts.net/ENV/%2e%2e",
    "https://example.ts.net/a/../ENV/THREAD",
    "https://user:password@example.ts.net/ENV/THREAD",
    "t3code://thread/ENV",
    "t3code://thread:1234/ENV/THREAD",
  ])("rejects malformed thread link %s", (url) => {
    expect(parseThreadLink(url)).toEqual({ kind: "invalid" });
  });

  it.each([
    "not a URL",
    "http://example.ts.net/ENV/THREAD",
    "https://example.com/ENV/THREAD",
    "https://ts.net/ENV/THREAD",
    "https://example.ts.net.evil.com/ENV/THREAD",
    "https://evilts.net/ENV/THREAD",
    "t3code://pair?pairingUrl=x",
    "t3code-dev://expo-development-client/?url=x",
    "t3code-custom://threads/ENV/THREAD",
    "t3code://settings/usage",
    "https://example.com/?url=https://example.ts.net/ENV/THREAD",
  ])("leaves unrelated URL alone %s", (url) => {
    expect(parseThreadLink(url)).toEqual({ kind: "ignored" });
  });
});

describe("resolveThreadLink", () => {
  const connected = {
    isReady: true,
    environment: { isEnabled: true, connectionState: "connected" as const },
    shellStatus: "live" as const,
    shellHasError: false,
    threadExists: true,
  };
  it("waits for saved connections on cold start", () => {
    expect(resolveThreadLink({ ...connected, isReady: false, environment: undefined })).toBe(
      "waiting",
    );
  });
  it.each(["available", "connecting", "reconnecting"] as const)(
    "waits during %s",
    (connectionState) => {
      expect(
        resolveThreadLink({ ...connected, environment: { isEnabled: true, connectionState } }),
      ).toBe("waiting");
    },
  );
  it.each(["empty", "cached", "synchronizing"] as const)(
    "does not mistake %s threads for the live list",
    (shellStatus) => {
      expect(resolveThreadLink({ ...connected, shellStatus, threadExists: false })).toBe("waiting");
    },
  );
  it("opens an existing thread after hydration", () => {
    expect(resolveThreadLink(connected)).toBe("open");
  });
  it("reports an unsaved environment", () => {
    expect(resolveThreadLink({ ...connected, environment: undefined })).toContain("not saved");
  });
  it("does not enable a disabled environment", () => {
    expect(
      resolveThreadLink({
        ...connected,
        environment: { isEnabled: false, connectionState: "available" },
      }),
    ).toContain("switched off");
  });
  it.each(["offline", "error", "unsupported"] as const)(
    "reports %s even when a thread is cached",
    (connectionState) => {
      expect(
        resolveThreadLink({ ...connected, environment: { isEnabled: true, connectionState } }),
      ).toContain("not connected");
    },
  );
  it("reports a failed snapshot", () => {
    expect(resolveThreadLink({ ...connected, shellHasError: true })).toContain(
      "could not be loaded",
    );
  });
  it("reports an unknown thread after the live snapshot loads", () => {
    expect(resolveThreadLink({ ...connected, threadExists: false })).toContain("not found");
  });
});
