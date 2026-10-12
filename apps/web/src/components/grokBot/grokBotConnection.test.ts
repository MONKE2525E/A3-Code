import { describe, expect, it } from "vite-plus/test";

import {
  grokBotAccountCopy,
  grokBotCliCopy,
  grokBotMcpCopy,
  grokBotNativeReady,
  grokBotNativeSignedIn,
  grokBotProviderAuthFields,
  grokBotSkillCopy,
} from "./grokBotConnection";

describe("grokBotNativeReady", () => {
  it("is ready from the native sign-in alone, without the CLI bridge", () => {
    expect(
      grokBotNativeReady({
        installed: false,
        managed: false,
        sessionPresent: false,
        nativeAvailable: true,
      }),
    ).toBe(true);
  });

  it("is not ready when the native sign-in is unreadable, even with a CLI session", () => {
    expect(
      grokBotNativeReady({
        installed: true,
        managed: true,
        sessionPresent: true,
        nativeAvailable: false,
      }),
    ).toBe(false);
  });

  it("keeps the CLI check for servers that do not report nativeAvailable", () => {
    expect(grokBotNativeReady({ installed: true, managed: false, sessionPresent: true })).toBe(
      true,
    );
    expect(grokBotNativeReady({ installed: true, managed: false, sessionPresent: false })).toBe(
      false,
    );
    expect(grokBotNativeReady({ installed: false, managed: false, sessionPresent: true })).toBe(
      false,
    );
  });

  it("is not ready before status has loaded", () => {
    expect(grokBotNativeReady(null)).toBe(false);
    expect(grokBotNativeReady(undefined)).toBe(false);
  });
});

describe("grokBotNativeSignedIn", () => {
  it("follows the native sign-in when reported, else the CLI session", () => {
    expect(
      grokBotNativeSignedIn({
        installed: true,
        managed: false,
        sessionPresent: false,
        nativeAvailable: true,
      }),
    ).toBe(true);
    expect(
      grokBotNativeSignedIn({
        installed: true,
        managed: false,
        sessionPresent: true,
        nativeAvailable: false,
      }),
    ).toBe(false);
    expect(grokBotNativeSignedIn({ installed: true, managed: false, sessionPresent: true })).toBe(
      true,
    );
    expect(grokBotNativeSignedIn(undefined)).toBe(false);
  });
});

describe("grokBotCliCopy", () => {
  it("asks to install when the bridge is missing", () => {
    expect(grokBotCliCopy(null).description).toMatch(/community bridge/);
    expect(grokBotCliCopy({ installed: false, managed: false, sessionPresent: false }).title).toBe(
      "CLI bridge",
    );
  });

  it("marks the CLI optional when native sign-in works without it", () => {
    expect(
      grokBotCliCopy({
        installed: false,
        managed: false,
        sessionPresent: false,
        nativeAvailable: true,
      }).description,
    ).toMatch(/^Optional\./);
  });

  it("says whether the install is managed", () => {
    expect(
      grokBotCliCopy({ installed: true, managed: true, sessionPresent: true }).description,
    ).toBe("Installed for this environment.");
    expect(
      grokBotCliCopy({ installed: true, managed: false, sessionPresent: true }).description,
    ).toBe("Installed on this computer.");
  });
});

describe("grokBotAccountCopy", () => {
  it("asks to sign in until a session is present", () => {
    expect(grokBotAccountCopy({}).description).toMatch(/sign in/);
  });

  it("prefers native email and plan together", () => {
    expect(
      grokBotAccountCopy({
        sessionPresent: true,
        email: "fixture@example.test",
        plan: "SuperGrok Heavy",
      }).description,
    ).toBe("fixture@example.test · SuperGrok Heavy");
  });
});

describe("grokBotProviderAuthFields", () => {
  it("reads email and plan from authenticated provider auth", () => {
    expect(
      grokBotProviderAuthFields({
        status: "authenticated",
        email: "fixture@example.test",
        label: "SuperGrok Heavy",
      }),
    ).toEqual({ email: "fixture@example.test", plan: "SuperGrok Heavy" });
    expect(grokBotProviderAuthFields({ status: "unauthenticated" })).toEqual({});
  });
});

describe("grokBotMcpCopy", () => {
  it("uses the server reason when the endpoint is not ready", () => {
    expect(grokBotMcpCopy({ ready: true, reason: null }).description).toMatch(/can reach/);
    expect(grokBotMcpCopy({ ready: false, reason: "T3 Connect is not paired." }).description).toBe(
      "T3 Connect is not paired.",
    );
  });
});

describe("grokBotSkillCopy", () => {
  it("names the row; the setup panel owns the install copy", () => {
    expect(grokBotSkillCopy(true).title).toBe("Shared skill");
    expect(grokBotSkillCopy(true).description).toBe("");
    expect(grokBotSkillCopy(false).description).toMatch(/did not return/);
  });
});
