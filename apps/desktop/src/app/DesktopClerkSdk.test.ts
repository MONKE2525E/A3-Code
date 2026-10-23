import { describe, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    listeners,
    handlers,
    registerSchemes: vi.fn(),
    registerDefault: vi.fn(),
    releaseLock: vi.fn(),
    openExternal: vi.fn(async () => undefined),
  };
});

vi.mock("electron", () => ({
  app: {
    hasSingleInstanceLock: () => false,
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: fixtures.releaseLock,
    isReady: () => false,
    setAsDefaultProtocolClient: fixtures.registerDefault,
    on: (name: string, listener: (...args: unknown[]) => void) =>
      fixtures.listeners.set(name, listener),
    removeListener: (name: string) => fixtures.listeners.delete(name),
  },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      fixtures.handlers.set(name, handler),
    removeHandler: (name: string) => fixtures.handlers.delete(name),
  },
  protocol: { registerSchemesAsPrivileged: fixtures.registerSchemes },
  shell: { openExternal: fixtures.openExternal },
  BrowserWindow: { fromWebContents: () => null },
}));

import { createClerkBridge } from "@clerk/electron";

// Exercise the installed SDK patch, including its callback listener and OS registration.
describe("Clerk renderer and callback origins", () => {
  it("uses the production-allowlisted callback with the fork profile", async () => {
    const bridge = createClerkBridge({
      storage: {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
      },
      renderer: { scheme: "t3code", callbackScheme: "t3code", host: "app" },
    });
    try {
      expect(fixtures.registerSchemes.mock.calls[0]?.[0]).toMatchObject([{ scheme: "t3code" }]);
      expect(fixtures.registerDefault.mock.calls).toEqual([["t3code"]]);
      const frame = {};
      const event = { sender: { getType: () => "window", mainFrame: frame }, senderFrame: frame };
      const redirect = fixtures.handlers.get("clerk:oauth-transport:get-redirect-url")!;
      expect(redirect(event)).toBe("t3code://app/");
      expect(() => redirect({ ...event, senderFrame: {} })).toThrow(/main frame/);
      const pending = fixtures.handlers.get("clerk:oauth-transport:open")!(
        event,
        "https://accounts.example.test/authorize",
      );
      let settled = false;
      void Promise.resolve(pending).then(() => {
        settled = true;
      });
      fixtures.listeners.get("second-instance")!({}, ["t3code-grokbot://app/?code=other-install"]);
      await Promise.resolve();
      expect(settled).toBe(false);
      const callbackUrl = "t3code://app/?code=fixture-code";
      fixtures.listeners.get("second-instance")!({}, [callbackUrl]);
      expect(await pending).toEqual({ callbackUrl });
    } finally {
      bridge.cleanup();
    }
    expect(fixtures.handlers.size).toBe(0);
    expect(fixtures.listeners.size).toBe(0);
    expect(fixtures.releaseLock).toHaveBeenCalledOnce();
  });
});
